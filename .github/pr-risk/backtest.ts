/**
 * Replays the policy over a repo's PRs to show how often it would approve,
 * flag or block, before trusting its thresholds. Writes nothing to the repo.
 *
 * Usage: node backtest.ts owner/repo [count] [search qualifiers]
 *   node backtest.ts owner/repo 100                                  # last 100 merged PRs
 *   node backtest.ts owner/repo 20 "is:open author:fabiankaegy"      # your open PRs
 *
 * Needs GITHUB_TOKEN (read access to the repo) and TYPESAFE_API_KEY. Run it
 * locally: the report names PRs and files, so don't publish it from a public repo.
 */
import { assessPullRequest, type Assessment, type Outcome } from "./assess.ts";
import { github } from "./github.ts";

const [repo, countArg = "100", qualifiers = "is:merged"] = process.argv.slice(2);
if (!repo) throw new Error("Usage: node backtest.ts owner/repo [count] [search qualifiers]");
const count = Number(countArg);

const ICONS: Record<Outcome, string> = { approve: "✅", flag: "⚠️", block: "🛑" };

// Most recently updated PRs matching the qualifiers, via GitHub search.
const q = encodeURIComponent(`repo:${repo} is:pr ${qualifiers}`);
const prs: any[] = [];
for (let page = 1; prs.length < count; page++) {
	const { items } = await github(`/search/issues?q=${q}&sort=updated&order=desc&per_page=100&page=${page}`);
	prs.push(...items);
	if (items.length < 100) break;
}
prs.splice(count);

const rows: string[] = [];
const totals: Record<Outcome | "error", number> = { approve: 0, flag: 0, block: 0, error: 0 };

for (const pr of prs) {
	let assessment: Assessment;
	try {
		assessment = await assessPullRequest(repo, pr.number);
	} catch (error) {
		totals.error++;
		rows.push(`| [#${pr.number}](${pr.html_url}) | ${pr.title} | ❌ | ${(error as Error).message.slice(0, 120)} |`);
		continue;
	}
	totals[assessment.outcome]++;
	const findings = assessment.findings
		.map((f) => `${ICONS[f.severity]} \`${f.file}\` ${f.reason} (${Math.round(f.probability * 100)}%)`)
		.join("<br>");
	rows.push(`| [#${pr.number}](${pr.html_url}) | ${pr.title.replaceAll("|", "\\|")} | ${ICONS[assessment.outcome]} | ${findings} |`);
	console.error(`#${pr.number} ${assessment.outcome}`);
}

const pct = (n: number) => `${Math.round((n / prs.length) * 100)}%`;
const report = [
	`## pr-risk backtest: ${repo}, ${prs.length} PRs matching \`${qualifiers}\``,
	`✅ approved ${totals.approve} (${pct(totals.approve)}) · ⚠️ flagged ${totals.flag} (${pct(totals.flag)}) · 🛑 blocked ${totals.block} (${pct(totals.block)})` +
		(totals.error ? ` · ❌ errors ${totals.error}` : ""),
	"| PR | Title | Outcome | Findings |\n|---|---|---|---|\n" + rows.join("\n"),
].join("\n\n");

console.log(report);
