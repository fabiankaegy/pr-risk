/**
 * Assesses a pull request's risk with TypeSafe's Jev, labels it, and approves it
 * when the risk is low enough to merge without a human reviewer.
 *
 * Runs from .github/workflows/pr-risk.yml on `pull_request_target`, so this
 * file and policy.ts always come from the base branch: a PR can't edit its own
 * gate. PR code is never checked out or executed; the diff is only read as data.
 *
 * Local dry run (no labels, comments or reviews are written):
 *   DRY_RUN=1 GITHUB_REPOSITORY=owner/repo PR_NUMBER=123 \
 *   GITHUB_TOKEN=$(gh auth token) TYPESAFE_API_KEY=... node assess.ts
 */
import { matchesGlob } from "node:path";
import { RED_FLAGS, RISK_LEVELS } from "./policy.ts";

type Risk = keyof typeof RISK_LEVELS;

// Risk levels that merge without a human review.
const AUTO_APPROVE: Risk[] = ["low", "medium"];

// Auto-approve only when Jev puts the chance of "high" at or below this.
const MAX_HIGH_PROBABILITY = 0.2;

// A red flag counts when Jev's "yes" probability is at least this.
const RED_FLAG_THRESHOLD = 0.5;

// Changes touching these paths are always high risk, whatever Jev says.
const SENSITIVE_PATHS = [
	".github/**",
	"**/CODEOWNERS",
	"**/package-lock.json",
	"**/composer.lock",
];

// Jev's context is reportedly 32k tokens for the state plus the longest
// question. Bigger diffs skip Jev and go to a human.
const MAX_DIFF_CHARS = 100_000;

// Marks the bot's comment so reruns update it instead of adding new ones.
const COMMENT_MARKER = "<!-- pr-risk -->";
const BOT_LOGIN = "github-actions[bot]";

interface Assessment {
	risk: Risk;
	highProbability: number;
	confidence: number;
	reasons: string[];
}

// Jev response shapes, per https://docs.typesafe.ai/api
interface ChoiceAnswer {
	type: "choice";
	choice: string;
	probabilities: Record<string, number>;
	confidence: number;
}
interface NoulAnswer {
	type: "noul";
	noul: number;
}

const env = (name: string): string => {
	const value = process.env[name];
	if (!value) throw new Error(`Missing env var ${name}`);
	return value;
};

const repo = env("GITHUB_REPOSITORY");
const prNumber = Number(env("PR_NUMBER"));
const token = env("GITHUB_TOKEN");
const dryRun = Boolean(process.env.DRY_RUN);

/** Calls the GitHub REST API for this repo. `path` is relative to /repos/{repo}. */
async function github<T = any>(
	path: string,
	{ method = "GET", body, accept = "application/vnd.github+json" }: { method?: string; body?: unknown; accept?: string } = {},
): Promise<T> {
	const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: accept,
			"X-GitHub-Api-Version": "2022-11-28",
			...(body ? { "Content-Type": "application/json" } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status} ${await res.text()}`);
	if (accept.endsWith("diff")) return (await res.text()) as T;
	return res.status === 204 ? (undefined as T) : res.json();
}

/** Fetches every page of a list endpoint. */
async function githubAll<T>(path: string): Promise<T[]> {
	const items: T[] = [];
	for (let page = 1; ; page++) {
		const sep = path.includes("?") ? "&" : "?";
		const batch = await github<T[]>(`${path}${sep}per_page=100&page=${page}`);
		items.push(...batch);
		if (batch.length < 100) return items;
	}
}

/** Asks Jev the overall risk question and every red-flag question in one call. */
async function assessWithJev(pr: any, files: any[], diff: string): Promise<Assessment> {
	const questions: Record<string, unknown> = {
		risk: {
			type: "choice",
			instructions: "How risky is it to merge this pull request without a human code review?",
			criteria: RISK_LEVELS,
		},
	};
	for (const [id, flag] of Object.entries(RED_FLAGS)) {
		questions[id] = { type: "noul", instructions: flag.question };
	}

	const body = JSON.stringify({
		model: "jev-latest",
		state: {
			title: pr.title,
			description: pr.body ?? "",
			files: files.map((f) => `${f.status} +${f.additions} -${f.deletions} ${f.filename}`),
			diff,
		},
		questions,
	});

	// Retry rate limits (429) and overload (529) with exponential backoff.
	let res: Response;
	for (let attempt = 0; ; attempt++) {
		res = await fetch("https://api.typesafe.ai/v1/systemone", {
			method: "POST",
			headers: { Authorization: `Bearer ${env("TYPESAFE_API_KEY")}`, "Content-Type": "application/json" },
			body,
		});
		if (![429, 529].includes(res.status) || attempt === 3) break;
		await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
	}
	if (!res.ok) throw new Error(`Jev: ${res.status} ${await res.text()}`);

	const { answers } = (await res.json()) as { answers: Record<string, ChoiceAnswer | NoulAnswer> };
	const risk = answers.risk as ChoiceAnswer;
	const reasons = Object.entries(RED_FLAGS)
		.filter(([id]) => (answers[id] as NoulAnswer).noul >= RED_FLAG_THRESHOLD)
		.map(([, flag]) => flag.reason);

	return {
		risk: reasons.length ? "high" : (risk.choice as Risk),
		highProbability: risk.probabilities.high ?? 0,
		confidence: risk.confidence,
		reasons,
	};
}

/** Swaps the PR's `risk: *` label for the current one. */
async function setRiskLabel(risk: Risk) {
	for (const other of Object.keys(RISK_LEVELS).filter((r) => r !== risk)) {
		await github(`/issues/${prNumber}/labels/${encodeURIComponent(`risk: ${other}`)}`, { method: "DELETE" }).catch(() => {});
	}
	await github(`/issues/${prNumber}/labels`, { method: "POST", body: { labels: [`risk: ${risk}`] } });
}

/** Creates or updates the bot's single assessment comment. */
async function upsertComment(body: string) {
	const comments = await githubAll<any>(`/issues/${prNumber}/comments`);
	const existing = comments.find((c) => c.user?.login === BOT_LOGIN && c.body?.includes(COMMENT_MARKER));
	if (existing) await github(`/issues/comments/${existing.id}`, { method: "PATCH", body: { body } });
	else await github(`/issues/${prNumber}/comments`, { method: "POST", body: { body } });
}

/** Dismisses earlier bot approvals, e.g. when a new push raised the risk. */
async function dismissBotApprovals() {
	const reviews = await githubAll<any>(`/pulls/${prNumber}/reviews`);
	for (const review of reviews.filter((r) => r.user?.login === BOT_LOGIN && r.state === "APPROVED")) {
		await github(`/pulls/${prNumber}/reviews/${review.id}/dismissals`, {
			method: "PUT",
			body: { message: "Risk re-assessed: human review required." },
		});
	}
}

const pr = await github(`/pulls/${prNumber}`);
const files = await githubAll<any>(`/pulls/${prNumber}/files`);
const diff = await github<string>(`/pulls/${prNumber}`, { accept: "application/vnd.github.diff" });

// Only authors with write access can be auto-approved, so outside PRs can't
// talk their way past review.
const { permission } = await github(`/collaborators/${pr.user.login}/permission`);
const trustedAuthor = ["admin", "maintain", "write"].includes(permission);

const touchedPaths = files.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean));
const sensitive = touchedPaths.filter((p) => SENSITIVE_PATHS.some((glob) => matchesGlob(p, glob)));

const assessment: Assessment =
	diff.length > MAX_DIFF_CHARS
		? { risk: "high", highProbability: 1, confidence: 1, reasons: ["Diff too large to assess automatically"] }
		: await assessWithJev(pr, files, diff);
if (sensitive.length) {
	assessment.risk = "high";
	assessment.reasons.unshift(`Touches sensitive paths: ${sensitive.map((p) => `\`${p}\``).join(", ")}`);
}

const confidentEnough = assessment.highProbability <= MAX_HIGH_PROBABILITY;
const approve = AUTO_APPROVE.includes(assessment.risk) && confidentEnough && trustedAuthor;
const decision = approve
	? "✅ Auto-approved. No human review required."
	: !trustedAuthor
		? "👀 Human review required: the author doesn't have write access."
		: AUTO_APPROVE.includes(assessment.risk) && !confidentEnough
			? `👀 Human review required: ${Math.round(assessment.highProbability * 100)}% chance of high risk is above the ${MAX_HIGH_PROBABILITY * 100}% limit.`
			: "👀 Human review required.";

const comment = [
	COMMENT_MARKER,
	`### Risk: **${assessment.risk}**`,
	assessment.reasons.map((r) => `- ${r}`).join("\n"),
	decision,
	`<sub>Assessed by Jev at ${pr.head.sha.slice(0, 7)} · chance of high risk ${Math.round(assessment.highProbability * 100)}% · confidence ${Math.round(assessment.confidence * 100)}%</sub>`,
]
	.filter(Boolean)
	.join("\n\n");

console.log(comment);

if (!dryRun) {
	await setRiskLabel(assessment.risk);
	await upsertComment(comment);
	if (approve) {
		await github(`/pulls/${prNumber}/reviews`, {
			method: "POST",
			// The comment is the single source of truth for the risk level; it's
			// updated on every run, while review bodies stay frozen in the timeline.
			body: { event: "APPROVE", commit_id: pr.head.sha, body: `Auto-approved by pr-risk at ${pr.head.sha.slice(0, 7)}.` },
		});
	} else {
		await dismissBotApprovals();
	}
}
