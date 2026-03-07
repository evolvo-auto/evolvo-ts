# Challenge-Issue Workflow Design (Issue #42)

## Purpose
Add a first-class workflow for user-issued **Challenge issues** so failed attempts produce durable learning and concrete corrective issues.

## Current-State Findings

1. Issue model has no type system. Runtime only uses labels `in progress`, `completed`, and outdated labels.
   - `src/issues/taskIssueManager.ts`
   - `src/main.ts`
2. Selection logic cannot distinguish challenge work from self-improvement work.
   - `selectIssueForWork` in `src/main.ts`
3. Failure capture is shallow and mostly comment text.
   - Run error path only posts `## Task Execution Problem` with error message (`src/main.ts`)
   - Execution summary captures commands/files but is not persisted as structured machine-readable failure records (`src/agents/runCodingAgent.ts`, `src/main.ts`)
4. No failure taxonomy/classification and no link from failure reason to corrective issue generation.
5. Queue replenishment only creates generic templates and is unaware of challenge failures.
   - `replenishSelfImprovementIssues` in `src/issues/taskIssueManager.ts`
6. No retry gating model for failed challenges, and no attempt counters.
7. No metrics model to detect whether challenge success rate improves.

## Challenge Issue Model

A Challenge issue is an open GitHub issue with label `challenge` and optional metadata block in the issue body:

```md
<!-- evolvo:challenge
id: challenge-<issue-number>
priority: normal
retry_policy: gated
validation_profile: full
-->
```

Required labels:
- `challenge`: identifies external/user challenge work
- `challenge:failed`: set after failed attempt
- `challenge:ready-to-retry`: set when corrective work is completed and retry is allowed
- `learning-generated`: indicates follow-up improvement issues were created

Linkage conventions:
- Corrective issues include `Relates-to-Challenge: #<challengeIssueNumber>` in body
- Challenge issue comments include a "Learning Links" section listing generated issue numbers and PRs

## Execution Flow

1. Runtime fetches open issues.
2. Classify issues into challenge vs self-improvement.
3. Selection order:
   - `challenge` + `in progress`
   - `challenge` + `challenge:ready-to-retry`
   - other `challenge` (first attempt)
   - fallback to existing self-improvement selection
4. Build prompt with explicit mode header:
   - `Mode: challenge`
   - challenge context and previous failure summaries if retried
5. Run agent (`runCodingAgent`) and capture structured execution summary.
6. Determine outcome using explicit rules:
   - success: merge observed for the issue PR or explicit accepted outcome with passing validation policy
   - failure: runtime exception, failed validation not resolved, rejected review outcome, or no required repository edits for edit tasks
7. Post execution artifact summary comment and update labels/state accordingly.

## Failure Capture Model

Persist a per-attempt JSON artifact under:

- `.evolvo/challenge-attempts/<issueNumber>/<attemptTimestamp>.json`

Artifact schema (minimum):
- `challengeIssueNumber`
- `attempt`
- `startedAt`, `endedAt`
- `prompt`
- `inspectedAreas`
- `editedFiles`
- `validationCommands`
- `failedValidationCommands`
- `reviewOutcome`
- `pullRequestCreated`, `mergedPullRequest`
- `externalRepositories`, `externalPullRequests`, `mergedExternalPullRequest`
- `runtimeError` (if thrown)
- `finalResponse`
- `classification`
- `generatedImprovementIssues`

GitHub comment should include a compact pointer to artifact path + key failure facts.

## Failure Classification

Initial categories:
- `validation_failure` (tests/typecheck/build/lint failures)
- `workflow_failure` (branch/commit/push/pr/merge process failure)
- `review_rejection` (self-review rejected or required amendment unresolved)
- `execution_error` (runtime/tooling errors)
- `scope_control_failure` (off-task diff, unrelated files, missing boundedness)
- `unknown`

Classification input sources:
- `runCodingAgent` summary
- runtime error object
- PR/review signals in logs/comments

Classification output drives issue templates.

## Learning Loop

On challenge failure:
1. Create/update failure artifact.
2. Classify failure category.
3. Generate 1-3 bounded improvement issues from category templates.
4. Add label `learning-generated` to challenge issue.
5. Add links between challenge issue and generated issues in both directions.
6. Mark challenge issue `challenge:failed` and remove `in progress`.

Retry eligibility:
- challenge has label `challenge:ready-to-retry`
- all linked corrective issues are closed or `completed`
- attempt count below cap
- cooldown window elapsed (for repeated failures)

## Retry Policy

Default policy: **gated manual retry**.

- Runtime does not immediately loop failed challenge attempts.
- Runtime checks gating conditions each cycle.
- Max attempts default: 3.
- On max attempts reached, add `challenge:blocked` and require explicit operator action.

This avoids infinite loops while still enabling deliberate re-attempts.

## GitHub Issue/PR Linkage Model

Challenge issue timeline should contain:
1. Attempt start comment
2. Attempt result comment with classification
3. Links to generated corrective issues
4. Retry readiness comment once corrective issues complete
5. Retry attempt references
6. Final success comment with merged PR link

Corrective issues should include:
- link to originating challenge issue
- classification and attempt context
- explicit acceptance test tied to challenge retry readiness

## Metrics

Persist rolling metrics in `.evolvo/challenge-metrics.json`:
- `totalChallenges`
- `successfulChallenges`
- `failedChallenges`
- `avgAttemptsToSuccess`
- `failureCountByCategory`
- `retrySuccessRate`
- `medianTimeToRecovery`

Use metrics in startup comments or periodic report issue/comment.

## Required Architecture Changes

1. Add challenge issue typing/parsing and selection logic in `main.ts` + `TaskIssueManager`.
2. Add challenge attempt persistence utilities (`src/challenges/*`).
3. Extend run-result pipeline with explicit challenge outcome evaluator.
4. Add failure classifier and corrective issue generation service.
5. Add link-management helpers for GitHub comments/labels.
6. Add retry gating evaluator.
7. Add metrics updater and report formatter.

## Recommended Phases

Phase 1: Foundation
- issue typing, labels, selection, and outcome evaluation

Phase 2: Failure Learning
- artifact persistence, classification, and corrective issue generation

Phase 3: Retry + Metrics
- retry gate engine, attempt caps, and learning metrics

## Follow-up Implementation Issues

The following issues were created from this design:
- #44 Introduce challenge issue type, labels, and runtime selection rules
- #45 Persist challenge attempt artifacts and lifecycle evidence
- #46 Add failure classification and corrective issue generation for challenge failures
- #47 Implement retry gating and blocked-state handling for challenge issues
- #48 Add challenge learning metrics and reporting
