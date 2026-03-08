# evolvo-ts

`evolvo-ts` is a self-improving runtime that pulls GitHub issues, executes one bounded improvement cycle at a time through Codex, and continues until the queue is exhausted or a merge triggers restart.

## Runtime Overview

1. Load required environment variables from `.env`.
2. Accept optional issue CLI commands (`issues ...`) for manual queue operations.
3. Start the main issue loop (max `25` cycles per process).
4. Select one actionable issue and run a coding cycle.
5. If a pull request is merged, run post-merge restart workflow and exit.

## Required Environment

The runtime exits early if any required variable is missing:

- `CONTEXT7_API_KEY`
- `OPENAI_API_KEY`
- `GITHUB_TOKEN`
- `GITHUB_OWNER`
- `GITHUB_REPO`

## Optional Discord Operator Control

Discord operator control is optional and is only used when all required Discord vars are configured:

- `DISCORD_BOT_TOKEN`
- `DISCORD_CONTROL_GUILD_ID`
- `DISCORD_CONTROL_CHANNEL_ID`
- `DISCORD_OPERATOR_USER_ID`

Optional tuning:

- `DISCORD_OPERATOR_TIMEOUT_MS` (default `300000`)
- `DISCORD_OPERATOR_POLL_INTERVAL_MS` (default `5000`)
- `DISCORD_CYCLE_EXTENSION` (default `25`)

When configured, if Evolvo reaches its cycle limit it posts a control prompt in the configured Discord channel, tags `<@DISCORD_OPERATOR_USER_ID>`, and waits for a channel reply from that operator:

- `continue` -> extend cycle budget by `DISCORD_CYCLE_EXTENSION`
- `quit` -> exit cleanly

Outside the cycle-limit prompt, Discord operator control is explicit plain-text message polling, not Discord slash commands. Send normal channel messages such as:

- `quit after current task`
- `quit after tasks`
- `startProject <project-name>`
- `stopProject`

If Discord vars are not configured, Evolvo does not attempt Discord and keeps existing non-Discord behavior.

## Startup Flow

On `pnpm dev` / `pnpm start`, the runtime:

1. Tries issue command handling first (`issues create|list|start|comment|complete|close`).
2. Creates a GitHub issue manager using configured `GITHUB_OWNER` and `GITHUB_REPO`.
3. Loads open issues from GitHub.
4. Closes issues labeled as outdated (`outdated`, `obsolete`, `wontfix`, `invalid`, `duplicate`).
5. Picks one issue for work:
   - prefer an issue labeled `in progress`
   - otherwise pick the first non-`completed` issue
6. If no actionable issue exists:
   - on first cycle with zero open issues, bootstrap repository-derived issue candidates from a full repository scan
   - otherwise replenish queue with a minimum target of `3` open tasks and a hard cap of `5` open tasks
7. Builds the prompt from selected issue title + description and executes a Codex run.

If no issue can be selected and no new issues are created, the runtime stops cleanly.

## Issue Lifecycle (Single Issue)

1. Select issue from open queue.
2. Ensure `in progress` label exists.
3. Run implementation through Codex using the issue body as task prompt.
4. Apply the task contract: bounded change, self-review, validation, and clean commit behavior.
5. If merge is detected, runtime transitions to post-merge restart path.
6. Next cycle re-reads queue and continues.

### Canonical Runtime Lifecycle Model

Canonical lifecycle state is now persisted locally in:

- `.evolvo/runtime-lifecycle-state.json`

Canonical states currently modeled:

- `selected`
- `executing`
- `under_review`
- `accepted`
- `rejected`
- `committed`
- `pr_opened`
- `merged`
- `restarted`
- `failed`
- `blocked`

State surfaces are separated as follows:

- Canonical state: persisted transition record in `.evolvo/runtime-lifecycle-state.json`
- Derived state: runtime snapshots such as issue open/closed state, labels, challenge typing, review/PR signals
- Presentation state: GitHub issue comments/logs for human observability

Each canonical transition also posts a GitHub issue comment titled `Canonical Lifecycle State` so timeline commentary remains visible without making comments canonical.

### Labels and States

- `in progress`: current active work item.
- `completed`: done, not selected again.
- outdated labels: issue is auto-closed before selection.

## Validation Expectations

Validation should be run before accepting work in an issue cycle:

```bash
pnpm validate
```

Current validation pipeline:

1. `pnpm typecheck`
2. `pnpm lint`
3. `pnpm build`
4. `pnpm test`

If full validation is too slow while narrowing failures, run targeted commands first (`pnpm test`, `pnpm typecheck`, `pnpm lint`) then re-run `pnpm validate` before final acceptance.

## Recovery Guide

### GitHub Authentication / API Failure

Symptoms:

- startup logs include authentication failure or issue sync unavailability
- queue operations fail

Actions:

1. Verify `GITHUB_TOKEN`, `GITHUB_OWNER`, and `GITHUB_REPO` in `.env`.
2. Re-run `pnpm dev`.
3. Confirm queue is reachable with `pnpm dev -- issues list`.

### Empty Queue / No Actionable Issue

Symptoms:

- runtime reports no open issues or no actionable issues

Actions:

1. Let startup bootstrap/replenishment run automatically.
2. If still empty, create one manually:

```bash
pnpm dev -- issues create "<title>" "<description>"
```

### Post-Merge Restart Failure

Post-merge workflow runs:

1. `git checkout <repository default branch>`
   The branch is detected from git remote metadata first, with GitHub repository metadata as a fallback.
2. `git pull --ff-only`
3. `pnpm i`
4. `pnpm build`
5. `pnpm start` (with readiness-token handshake)

Restart success requires an explicit readiness signal:

- restarted runtime writes `.evolvo/runtime-readiness.json` with the restart token from `EVOLVO_RESTART_TOKEN`
- parent process waits for matching token readiness before declaring restart success

If any step fails, or readiness is not observed in time, runtime logs diagnostics and exits current cycle. Fix the reported failure, then restart manually with `pnpm dev`.

## Manual Issue Commands

```bash
pnpm dev -- issues list
pnpm dev -- issues create "<title>" "<description>"
pnpm dev -- issues start <issueNumber>
pnpm dev -- issues comment <issueNumber> "<comment>"
pnpm dev -- issues complete <issueNumber> "<summary>"
pnpm dev -- issues close <issueNumber>
```

## Development Commands

```bash
pnpm dev        # run runtime in tsx
pnpm lint       # compiler-backed unused-code/static analysis
pnpm build      # compile to dist
pnpm start      # run compiled runtime
pnpm test       # run vitest
pnpm validate   # typecheck + lint + build + test
```
