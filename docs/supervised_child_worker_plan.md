# Replace the Single Scheduler With a Supervised Child-Worker Runtime

## Summary

Replace the current in-process staged scheduler with a **single supervisor** plus **long-lived child workers**:

- `1` global Issue Generator worker
- `1` global Planner worker
- `1` global Review worker
- `1` global Release worker
- `1` Dev worker per active project max

Workers coordinate through **GitHub Project stage state + local runtime lease/state files only**. No internal IPC task queue. This is a **full cutover** on the current branch, not a feature-flagged parallel path.

## Implementation Changes

### 1. Introduce a supervisor and explicit worker roles
Create a runtime supervisor that starts and monitors child processes for:
- `issue-generator`
- `planner`
- `review`
- `release`
- `dev --project <slug>`

The supervisor is responsible only for:
- ensuring global singleton workers are running
- ensuring at most one dev worker exists per active project
- restarting crashed workers
- removing workers for stopped/inactive projects
- emitting lifecycle logs for worker start/exit/restart

Workers are long-lived and poll their own owned columns. They do not call each other directly.

### 2. Make GitHub Projects + local state the only handoff surface
Use GitHub Project stage values as the visible workflow source of truth and local state files for leases/heartbeats only.

Add/extend runtime state for:
- global worker heartbeats and last-seen timestamps
- per-project dev worker heartbeat
- per-worker current claim
- crash/failure count
- last processed issue/PR per worker where needed for observability

Do not introduce a second work queue. Workers discover work by polling their owned columns and claiming via board transition + lease update.

### 3. Enforce column ownership and throughput rules in each worker
Implement each worker as column-owned and autonomous:

- Issue Generator:
  - scans active projects
  - maintains `Inbox + Planning = 5` idea-stage items total per project
  - may create up to `5` new issues per project in one pass
  - only creates new issues and places them in `Inbox`

- Planner:
  - processes `Inbox` ideas **one at a time per project**
  - for an `Inbox` item, it must either:
    - block it
    - refine it and move it to `Planning`
    - split it, create refined child issues in `Planning`, and move the parent to `Planning`
  - once an item is in `Planning`, the planner must never rewrite it again
  - planner may only revisit `Planning` items to move one into `Ready for Dev`
  - planner may move items into `Ready for Dev` only when that project has fewer than `3` there
  - `Planning` is capped at `5`, except split-created overflow is allowed

- Dev worker:
  - one long-lived worker per active project
  - works one `Ready for Dev` item at a time
  - claims `Ready for Dev -> In Dev`
  - implements, validates, creates/updates PR, then moves to `Ready for Review`
  - uses Codex only

- Review worker:
  - global singleton
  - processes `Ready for Review` one PR at a time
  - round-robin across active projects
  - claims `Ready for Review -> In Review`
  - approves to `Ready for Release` or rejects back to `Ready for Dev`
  - rejection may bypass the `Ready for Dev` cap
  - uses direct OpenAI API only

- Release worker:
  - global singleton
  - processes `Ready for Release` one PR at a time
  - round-robin across active projects
  - claims `Ready for Release -> Releasing`
  - merges, handles merge conflicts, closes/completes, then moves to `Done`
  - uses Codex only

### 4. Replace the current scheduler path with worker entrypoints
Refactor the current logic in `workflowScheduler.ts` into reusable worker-safe units, then add dedicated worker entrypoints and a supervisor entrypoint.

Expected runtime structure:
- supervisor loop in `main.ts` or a new `workflowSupervisor.ts`
- one file per worker runner
- shared board-query helpers and claim/move helpers
- shared lease/heartbeat helpers

Delete the old “single cycle does everything” runtime path after the worker path is live. Do not keep both runtimes.

### 5. Tighten lease recovery and logging
Make lease recovery worker-oriented:
- if a worker heartbeat expires, supervisor marks it dead and clears/reconciles stale lease state
- if board state and local lease state disagree, reconcile in favor of board truth plus safety rules
- dev lease cleanup must still prevent a second dev worker for the same project

Standardize logs to always include:
- worker role
- project slug for project-scoped activity
- claimed item/PR number
- stage move
- skip reason when no work is taken
- worker lifecycle events

Example log shape:
- `[worker][planner][evolvo] planned #427 -> Planning`
- `[worker][dev][evolvo-web] claimed #38 Ready for Dev -> In Dev`
- `[supervisor] restarted review worker after exit code 1`

## Public Interfaces / Type Changes

Add or replace runtime interfaces with:
- `WorkerRole = "issue-generator" | "planner" | "review" | "release" | "dev"`
- `WorkerProcessRecord`
  - pid, role, projectSlug, startedAt, heartbeatAt, currentClaim, restartCount
- `WorkflowWorkerState`
  - global worker inventory and health
- expanded per-project activity state
  - dev worker heartbeat/lease ownership remains per project
- worker CLI/entry args
  - global workers: role only
  - dev workers: role + project slug

Keep model routing explicit:
- Issue Generator, Planner, Review: OpenAI API only
- Dev, Release: Codex only

## Test Plan

Add worker-runtime tests for:
- supervisor starts exactly one global worker per global role
- supervisor starts at most one dev worker per active project
- multiple dev workers run concurrently for different projects
- no second dev worker starts for the same project
- stopped projects lose/avoid dev workers
- stale worker heartbeat triggers restart and stale lease cleanup
- planner behavior:
  - `Inbox` processed one at a time
  - refined/split/blocked outcomes
  - `Planning` items are not rewritten
  - only `Planning -> Ready for Dev`
- review/release round-robin across active projects
- issue generator maintains `Inbox + Planning = 5` target per project
- board/state-only coordination works after supervisor restart
- logs include worker role and project context consistently

## Assumptions and Defaults

- Full cutover: the old single-process scheduler path is removed rather than hidden behind a flag.
- Workers coordinate through GitHub Projects + local runtime state only; no IPC task queue is added.
- `Planning` overflow above `5` is allowed only for planner-created split children and their parent.
- Review and Release remain one-at-a-time global workers with round-robin project selection.
- `evolvo-ts` continues to behave as a normal project in the same worker model.
