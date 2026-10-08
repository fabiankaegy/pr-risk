# pr-risk

[TypeSafe's Jev](https://docs.typesafe.ai/api) grades every non-draft PR as low, medium or high risk. Jev doesn't write text. It answers typed questions with probabilities, which suits a yes/no gate. The action labels the PR (`risk: low` and so on) and keeps one summary comment up to date. When the risk is low or medium and the author has write access, it approves the PR, so nobody else has to review it.

## How a PR is graded

[`policy.ts`](policy.ts) holds the questions, all sent to Jev in one request:

- A **choice** question picks low, medium or high. Each level's description tells Jev what it means.
- **Yes/no** red-flag questions, such as "does this touch auth?" or "does this change stored data?". Any flag Jev answers yes to makes the PR high risk and is listed in the comment.

A PR is auto-approved only when its risk is low or medium **and** Jev puts the chance of high risk at 20% or less (`MAX_HIGH_PROBABILITY` in `assess.ts`).

## Setup

1. Copy `.github/pr-risk/` and `.github/workflows/pr-risk.yml` into your repo.
2. Add a `TYPESAFE_API_KEY` repository secret.
3. **Settings → Actions → General**: enable *Allow GitHub Actions to create and approve pull requests*.
4. **Settings → Rules → Rulesets**, on your default branch:
   - Require a pull request with **1 approval**. The bot's approval counts, and high-risk PRs wait for a human.
   - Enable **Dismiss stale pull request approvals when new commits are pushed**, so every push gets assessed again.
   - Optionally, require the `assess` status check so nothing merges before the assessment runs.

## Guardrails

- The workflow runs on `pull_request_target`, so the workflow, script and policy always come from the base branch. A PR can't edit its own gate, and PR code is never executed.
- PRs from authors without write access are labeled and commented on but never approved.
- One red flag asks whether the PR contains text aimed at the automated reviewer.
- Paths in `SENSITIVE_PATHS` (in `assess.ts`) are always high risk. By default that's CI config, CODEOWNERS and lockfiles.
- Diffs over 100k characters skip Jev and go to a human, because Jev's context is reportedly 32k tokens.

## Trying it locally

```sh
cd .github/pr-risk
DRY_RUN=1 GITHUB_REPOSITORY=owner/repo PR_NUMBER=123 \
GITHUB_TOKEN=$(gh auth token) TYPESAFE_API_KEY=... node assess.ts
```

This prints the comment without changing anything on the PR. `npm install && npm run typecheck` checks the types.
