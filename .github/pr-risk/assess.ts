/**
 * Decides whether a pull request can merge without a human, by asking TypeSafe's
 * Jev the questions in policy.ts about every changed file.
 *
 * Used by action.ts (the GitHub Action) and backtest.ts (replaying merged PRs).
 * It only reads: no labels, comments or reviews are written here.
 */
import { matchesGlob } from "node:path";
import { github, githubAll } from "./github.ts";
import { BLOCK_AT, DANGERS, FLAG_AT, IGNORED_PATHS, SENSITIVE_PATHS } from "./policy.ts";

export type Outcome = "approve" | "flag" | "block";

export interface Finding {
	file: string;
	reason: string;
	probability: number;
	severity: Exclude<Outcome, "approve">;
}

export interface Assessment {
	outcome: Outcome;
	findings: Finding[];
	headSha: string;
}

// Jev's context is reportedly 32k tokens for the state plus the longest
// question. A single file's diff above this gets flagged instead of read.
const MAX_PATCH_CHARS = 100_000;

// How many of the PR's other changed files to list as context with each file.
// Release PRs touch thousands, which alone would overflow Jev's context.
const MAX_CONTEXT_FILES = 100;

// Parallel Jev requests per PR. Retries handle any rate limiting beyond this.
const CONCURRENCY = 8;

const matchesAny = (path: string, globs: string[]) => globs.some((glob) => matchesGlob(path, glob));

/** Runs `fn` over `items` with at most `limit` calls in flight, keeping order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

/**
 * Asks Jev every danger question about one state; returns each "yes"
 * probability, or null when the state is too long for Jev's context.
 */
async function askJev(state: unknown): Promise<Record<string, number> | null> {
	const questions = Object.fromEntries(
		Object.entries(DANGERS).map(([id, danger]) => [id, { type: "noul", instructions: danger.question }]),
	);
	const body = JSON.stringify({ model: "jev-latest", state, questions });

	// Retry network errors, rate limits (429) and overload (529) with exponential backoff.
	let res: Response | undefined;
	for (let attempt = 0; ; attempt++) {
		try {
			res = await fetch("https://api.typesafe.ai/v1/systemone", {
				method: "POST",
				headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, "Content-Type": "application/json" },
				body,
			});
			if (![429, 529].includes(res.status)) break;
		} catch (error) {
			if (attempt === 4) throw error;
		}
		if (attempt === 4) break;
		await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
	}
	if (!res) throw new Error("Jev: no response");
	if (!res.ok) {
		const error = await res.text();
		if (res.status === 400 && error.includes("max_tokens_exceeded")) return null;
		throw new Error(`Jev: ${res.status} ${error}`);
	}

	const { answers } = (await res.json()) as { answers: Record<string, { noul: number }> };
	return Object.fromEntries(Object.keys(DANGERS).map((id) => [id, answers[id].noul]));
}

/** Checks one changed file against the policy. */
async function assessFile(pr: any, changedFiles: string[], file: any): Promise<Finding[]> {
	const paths: string[] = [file.filename, file.previous_filename].filter(Boolean);
	const finding = (reason: string, probability: number, severity: Finding["severity"]): Finding => ({
		file: file.filename,
		reason,
		probability,
		severity,
	});

	if (paths.some((p) => matchesAny(p, SENSITIVE_PATHS))) return [finding("Changes a protected path", 1, "block")];
	if (paths.every((p) => matchesAny(p, IGNORED_PATHS))) return [];
	if (!file.patch) {
		// Binary files report no line changes; text files lose their patch when GitHub deems it too large.
		return file.changes === 0 ? [] : [finding("Diff too large to inspect", 1, "flag")];
	}
	if (file.patch.length > MAX_PATCH_CHARS) return [finding("Diff too large to inspect", 1, "flag")];

	// The PR description stays out: it describes the whole PR, so it made every
	// file look like it contained what the description mentions, and it's an
	// easy place to address the reviewer.
	const answers = await askJev({
		pull_request: pr.title,
		other_changed_files: changedFiles.slice(0, MAX_CONTEXT_FILES),
		file: file.filename,
		diff: file.patch,
	});
	if (!answers) return [finding("Diff too large to inspect", 1, "flag")];
	return Object.entries(answers)
		.filter(([, p]) => p >= FLAG_AT)
		.map(([id, p]) => finding(DANGERS[id].reason, p, p >= BLOCK_AT && !DANGERS[id].flagOnly ? "block" : "flag"));
}

/** Assesses a PR file by file. `repo` is "owner/name". */
export async function assessPullRequest(repo: string, number: number): Promise<Assessment> {
	const pr = await github(`/repos/${repo}/pulls/${number}`);
	const files = await githubAll<any>(`/repos/${repo}/pulls/${number}/files`);
	const changedFiles = files.map((f) => `${f.status} +${f.additions} -${f.deletions} ${f.filename}`);

	const findings = (await mapLimit(files, CONCURRENCY, (file) => assessFile(pr, changedFiles, file)))
		.flat()
		// Blocking findings first, then most likely first.
		.sort((a, b) => Number(b.severity === "block") - Number(a.severity === "block") || b.probability - a.probability);

	const outcome: Outcome = findings.some((f) => f.severity === "block")
		? "block"
		: findings.length
			? "flag"
			: "approve";
	return { outcome, findings, headSha: pr.head.sha };
}
