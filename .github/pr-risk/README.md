# pr-risk

Lets agent-built PRs merge on their own unless they contain a real footgun. [TypeSafe's Jev](https://docs.typesafe.ai/api) checks every changed file, and the action approves the PR unless something needs a human.

The question isn't "is this PR risky?", since every feature is. It's "if this is wrong, is it exploitable, irreversible, or hard to notice?". Everything else merges and gets fixed forward.

## Outcomes

| Label | When | What happens |
|---|---|---|
| `pr-risk: approved` | Nothing found | Approved |
| `pr-risk: flagged` | A danger scored between `FLAG_AT` and `BLOCK_AT`, or a file was too large to read | Approved; the comment lists the files worth a look after merging |
| `pr-risk: needs review` | A danger scored at or above `BLOCK_AT`, a protected path changed, or the author lacks write access | Not approved; a human has to review |

The bot keeps a single comment on the PR, updated on every push. If a later push blocks the PR, the bot withdraws its earlier approval.

## Policy

Everything tunable lives in [`policy.ts`](policy.ts):

- **`DANGERS`**: yes/no questions about specific mistakes, such as weakening an auth check, unescaped user input, or deleting data without a safeguard. They name the mistake, not the topic, so ordinary feature work in those areas passes.
- **`FLAG_AT` / `BLOCK_AT`**: probability thresholds, 0.3 and 0.7 to start. Tune them with the backtest below.
- **`SENSITIVE_PATHS`**: always need a human. By default that's the gate itself: workflows, this folder, and CODEOWNERS.
- **`IGNORED_PATHS`**: generated files Jev doesn't need to read, such as lockfiles and snapshots.

Each file goes to Jev as its own request, so PR size doesn't matter. A single file over 100k characters is flagged rather than read, because Jev's context is reportedly 32k tokens.

## Setup

1. Copy `.github/pr-risk/` and the two workflows in `.github/workflows/` into your repo.
2. Add a `TYPESAFE_API_KEY` repository secret.
3. **Settings → Actions → General**: enable *Allow GitHub Actions to create and approve pull requests*.
4. **Settings → Rules → Rulesets**, on your default branch:
   - Require a pull request with **1 approval**. The bot's approval counts, and blocked PRs wait for a human.
   - Enable **Dismiss stale pull request approvals when new commits are pushed**, so every push gets assessed again.
   - Optionally, require the `assess` status check so nothing merges before the assessment runs.

The workflow runs on `pull_request_target`, so its code and policy always come from the base branch. A PR can't edit its own gate, and PR code is never executed.

## Tuning with a backtest

Run **Actions → PR risk backtest** with a repo and a PR count. It replays the policy over that repo's most recently merged PRs and writes a table to the run summary showing which PRs would have been approved, flagged or blocked, and why. Nothing is written to the target repo. Private repos need a fine-grained token with read access, saved as a `BACKTEST_GITHUB_TOKEN` secret.

Locally:

```sh
cd .github/pr-risk
GITHUB_TOKEN=$(gh auth token) TYPESAFE_API_KEY=... node backtest.ts owner/repo 100
```

## Trying a single PR locally

```sh
DRY_RUN=1 GITHUB_REPOSITORY=owner/repo PR_NUMBER=123 \
GITHUB_TOKEN=$(gh auth token) TYPESAFE_API_KEY=... node action.ts
```

This prints the comment without changing anything. `npm install && npm run typecheck` checks the types.
