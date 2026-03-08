# evolvo-ts

`evolvo-ts` is a self-improving runtime that supervises a staged GitHub workflow, runs specialized workers against that board, and keeps improving tracked projects until queues drain or an operator changes course.

## Runtime Overview

1. Load required environment variables from `.env`.
2. Accept optional issue CLI commands (`issues ...`) for manual queue operations.
3. Start the supervised runtime.
4. Launch and monitor worker processes for issue generation, planning, development, review, and release.
5. Reconcile stale worker leases or expired board claims.
6. Continue until the operator stops the runtime or work naturally drains.

## Supervised Worker Runtime

The runtime now uses a supervisor plus long-lived child workers instead of a single monolithic issue loop.

- Supervisor responsibilities:
   - compute desired worker inventory
   - start, stop, and restart workers
   - reconcile stale worker heartbeats and stale board claims
   - surface runtime status to Discord/operator commands
- Worker roles:
   - `issue-generator`: keeps `Inbox` supplied with new candidate work
   - `planner`: moves ideas through `Planning` into `Ready for Dev`
   - `dev`: claims `In Dev` work and runs implementation
   - `review`: processes `In Review`
   - `release`: processes `Releasing` / release-ready work
- Shared state:
   - GitHub Projects V2 board columns remain the source of truth for staged work
   - local worker state tracks heartbeats, claims, leases, and restart counts

Current status output now includes:

- runtime state and work mode
- active projects / active issue
- cycle budget
- per-column queue totals
- live worker inventory
- configured workflow limits

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

Outside the cycle-limit prompt, the live bot session now registers guild slash commands in the configured Discord server:

- `/quit mode:after-current-task|after-tasks`
- `/startproject name:<project-name>`
- `/stopproject mode:now|when-project-complete`

Plain-text channel messages remain available as a fallback in the control channel:

- `quit after current task`
- `quit after tasks`
- `startProject <project-name>`
- `stopProject`
- `stopProject whenProjectComplete`

Vitest runs set `EVOLVO_DISCORD_TRANSPORT=disabled`, so automated tests never send live Discord messages and must exercise Discord behavior through mocks, spies, or other controlled doubles.

If Discord vars are not configured, Evolvo does not attempt Discord and keeps existing non-Discord behavior.

### Workflow Limit Tuning

The staged workflow queue targets can be tuned from `.env`:

- `EVOLVO_IDEA_STAGE_TARGET_PER_PROJECT` (default `5`)
- `EVOLVO_ISSUE_GENERATOR_MAX_ISSUES_PER_PROJECT` (default `5`)
- `EVOLVO_PLANNING_LIMIT_PER_PROJECT` (default `5`)
- `EVOLVO_READY_FOR_DEV_LIMIT_PER_PROJECT` (default `3`)
- `EVOLVO_IN_DEV_LIMIT_PER_PROJECT` (default `1`)

These control how much work each worker is allowed to keep in its corresponding board stage per project.

## Startup Flow

On `pnpm dev` / `pnpm start`, the runtime:

1. Tries issue command handling first (`issues create|list|start|comment|complete|close`).
2. Builds runtime services for GitHub issues, pull requests, project board access, and local runtime state.
3. Starts the supervisor runtime.
4. Restores worker state and reconciles stale claims if needed.
5. Launches the desired worker set.
6. Loops on supervision, status publication, and worker recovery.

If the runtime is invoked as a worker command, the matching child worker process runs its role-specific pass loop instead.

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
