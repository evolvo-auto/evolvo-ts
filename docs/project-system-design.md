# Project System Design (Issue #314)

## Purpose
Design a first-class Project system so Evolvo can keep using a single central issue tracker while routing work into multiple repositories and working directories.

The target operator entrypoint is:

```text
startProject <project-name>
```

This design covers the Project model, label-based routing, project state, repository/workspace provisioning, Discord integration, runtime implications, and failure handling. It does not implement the feature directly.

## Current-State Findings

1. GitHub configuration is singleton and points to exactly one repository.
   - `src/github/githubConfig.ts` reads one `GITHUB_OWNER` and one `GITHUB_REPO`.
   - `src/github/githubClient.ts` hard-wires requests to `/repos/{owner}/{repo}/issues`.
2. Working directory is singleton and global.
   - `src/constants/workDir.ts` exports one `WORK_DIR`.
   - `src/agents/codingAgent.ts` binds `CODING_AGENT_THREAD_OPTIONS.workingDirectory` to that single path.
   - `src/main.ts`, `src/runtime/challengeLifecycle.ts`, and restart/readiness helpers all use the same `WORK_DIR`.
3. Issue routing only understands generic labels and challenge labels.
   - `src/runtime/loopUtils.ts` selects work without any project concept.
   - `src/issues/taskIssueManager.ts` lists, creates, comments on, and relabels issues without project metadata.
4. Tracker repository and execution repository are treated as the same thing.
   - `src/main.ts` builds one `repositoryName` from `GITHUB_OWNER/GITHUB_REPO`.
   - `src/runtime/operatorControl.ts` Discord start notifications expose one repository string.
   - `src/runtime/issueLifecyclePresentation.ts` comments assume one repository context.
5. Repository classification in agent summaries is based on the configured env repo, not on the issue’s actual target project.
   - `src/agents/runCodingAgent.ts` uses `GITHUB_OWNER/GITHUB_REPO` to decide whether repo links are “external”.
6. The current Discord control path can poll for simple authorized commands, but it does not yet create issues or run provisioning workflows.
   - `src/runtime/operatorControl.ts`
7. There is no generic persisted registry for multiple projects.
   - Existing `.evolvo/*.json` files are feature-specific (`runtime-lifecycle-state.json`, `runtime-readiness.json`, `graceful-shutdown-request.json`), not a cross-project registry.

## Proposed Project Model

A Project is a persisted execution target with a stable identity. Evolvo itself is the default project.

Recommended record shape:

```ts
type ProjectRecord = {
  slug: string;
  displayName: string;
  kind: "default" | "managed";
  issueLabel: string;
  trackerRepo: {
    owner: string;
    repo: string;
    url: string;
  };
  executionRepo: {
    owner: string;
    repo: string;
    url: string;
    defaultBranch: string | null;
  };
  cwd: string;
  status: "active" | "provisioning" | "failed" | "archived";
  sourceIssueNumber: number | null;
  createdAt: string;
  updatedAt: string;
  provisioning: {
    labelCreated: boolean;
    repoCreated: boolean;
    workspacePrepared: boolean;
    lastError: string | null;
  };
};
```

Recommended persistence:

- Registry path: `.evolvo/projects.json`
- Canonical default project record:
  - `slug: "evolvo"`
  - `kind: "default"`
  - `issueLabel: "project:evolvo"`
  - `executionRepo` = current `GITHUB_OWNER/GITHUB_REPO`
  - `cwd` = current `WORK_DIR`

Why the default project should be explicit instead of implicit:

- project resolution becomes uniform
- commentary/PR formatting can always read one resolved context shape
- future migrations away from the root repo are easier
- tests can resolve default and managed projects through the same API

## Label-Based Issue Routing

Project labels should use a reserved prefix:

- `project:<slug>`

Rules:

1. If an issue has no `project:*` label, it belongs to the default `evolvo` project.
2. If an issue has exactly one `project:<slug>` label, it belongs to that project.
3. If an issue has `project:evolvo`, treat it the same as an unlabeled default-project issue.
4. If an issue has more than one `project:*` label, do not execute it. Surface a deterministic blocked diagnostic and require cleanup.
5. If an issue references an unknown project slug, do not execute it. Surface a deterministic blocked diagnostic and require registry recovery or project provisioning.

This keeps project membership in tracker labels while preserving the “unlabeled means Evolvo” requirement.

## Project State Management

Project state should live in one canonical registry under `.evolvo/projects.json`, not in labels/comments alone.

State responsibilities:

- canonical project identity (`slug`, `displayName`, `issueLabel`)
- tracker repository vs execution repository
- execution cwd
- provisioning status and partial progress
- source issue number for auditability

Recommended runtime services:

- `ProjectRegistry`
  - load, normalize, and persist `.evolvo/projects.json`
  - return the default project
  - look up a project by slug or label
  - transition provisioning status deterministically
- `resolveProjectForIssue(issue)`
  - derive project label from issue labels
  - map unlabeled issues to default project
  - reject unknown or ambiguous project labels

Comments, labels, and Discord messages stay presentation state; the registry stays canonical.

## Repository Provisioning

The current `GitHubClient` is issue-scoped and cannot create repositories or labels outside `/issues`.

Recommended addition:

- a generic GitHub admin client/service for:
  - `POST /orgs/{owner}/repos` (or equivalent owner-aware endpoint)
  - `GET /repos/{owner}/{repo}` for verification
  - `POST /repos/{trackerOwner}/{trackerRepo}/labels` to ensure `project:<slug>`

The provisioning flow should not mutate the registry as “active” until all required steps succeed. Instead:

1. Create or update a registry entry with `status: "provisioning"`.
2. Ensure the project label on the central tracker.
3. Create the project repository under `evolvo-auto`.
4. Verify the repository exists and capture its URL/default branch.
5. Prepare the local workspace.
6. Mark the project `active`.

If any step fails, keep the registry entry with `status: "failed"` and structured partial-progress flags. Do not silently delete remote repos or labels.

## Working Directory / Workspace Provisioning

Recommended workspace layout:

- `WORK_DIR/projects/<slug>/`

Implications:

- `projects/` should be ignored from git so project workspaces do not pollute the Evolvo repository.
- The registry stores the absolute `cwd` for each project so runtime code does not reconstruct paths ad hoc.
- Default project keeps using the current root `WORK_DIR`.

The runtime must stop assuming one global working directory:

- `src/agents/codingAgent.ts` must accept a per-project working directory instead of the static `WORK_DIR`.
- `src/agents/runCodingAgent.ts` should run against a project-specific thread or thread factory, not a single long-lived global thread tied to one cwd.
- runtime helpers that persist project-specific artifacts should receive a resolved project cwd when the work belongs to a managed project.

## Recommended `startProject <project-name>` Flow

The safest design is issue-driven rather than performing full provisioning directly inside the Discord polling loop.

Recommended flow:

1. Authorized operator sends `startProject <project-name>` in the control channel.
2. Discord control validates and normalizes the requested name into a slug.
3. Runtime creates a central tracker provisioning issue in the default Evolvo project.
   - title example: `Start project <display-name>`
   - body includes a structured metadata block with slug/display name and requested repo/cwd
4. Discord acknowledges with the created issue number and the intended repo/label/cwd.
5. The normal issue loop selects that provisioning issue as Evolvo-project work.
6. The provisioning workflow:
   - ensures `project:<slug>` label
   - creates repo under `evolvo-auto`
   - prepares `WORK_DIR/projects/<slug>/`
   - writes/updates `.evolvo/projects.json`
   - comments success or failure details back to the provisioning issue
7. Subsequent `project:<slug>` issues route into that project’s repo/cwd.

Why queue it as an issue:

- reuses the existing issue/PR/review/lifecycle machinery
- keeps Discord control lightweight and authorized-only
- gives provisioning a visible tracker artifact and retry surface
- avoids adding a second orchestration path that bypasses the bounded-task workflow

## Runtime Issue Selection Implications

The tracker remains central, but issue execution becomes project-aware.

Recommended changes:

1. Continue listing and selecting issues from the Evolvo tracker repository.
2. Resolve the selected issue’s project before the task starts.
3. Build a `ProjectExecutionContext` for the issue:

```ts
type ProjectExecutionContext = {
  project: ProjectRecord;
  trackerIssueNumber: number;
};
```

4. Pass that context into:
   - coding-agent working directory selection
   - repository naming in Discord and lifecycle comments
   - repo classification in `runCodingAgent`
   - branch/PR link expectations

Important constraint for the first implementation:

- planner/bootstrap should remain default-project only
- project-labelled issues should be operator-created or explicitly created by follow-up workflows until project-aware planning is designed separately

## PR / Branch / Commentary Implications

Project work still links back to the central Evolvo tracker.

Needed changes:

1. Execution comments should show both:
   - tracker issue repository (`evolvo-auto/evolvo-ts`)
   - execution repository (`evolvo-auto/<project-repo>`)
2. Discord start notifications should show project slug and execution repository, not only the central tracker repo.
3. Coding prompts for project issues should explicitly tell the agent:
   - central tracker issue number
   - active execution repository URL
   - active cwd
   - that PRs in the project repo must reference the central tracker issue with a cross-repo reference
4. `runCodingAgent` should treat the active project repo as internal work, not as “external repository evidence”.

## Failure Handling

Failure handling should prefer explicit partial state over destructive rollback.

Recommended behavior:

- label creation fails:
  - keep provisioning issue open/blocked
  - registry entry stays `failed` with `labelCreated: false`
- repo creation succeeds but cwd preparation fails:
  - registry entry stays `failed`
  - preserve repo URL and provisioning flags
  - do not auto-delete the repo
- registry write fails after remote mutations:
  - surface a dedicated local-state failure
  - do not continue into normal project work until the registry is repaired
- ambiguous project labels on a work issue:
  - do not run agent
  - add a lifecycle comment with required cleanup

The provisioning issue becomes the recovery surface. A later retry can read the failed registry entry and continue or repair from there.

## Main Code Changes Required

Foundation changes:

1. Add a project registry module under `src/projects/`.
2. Add project label parsing/resolution from central tracker issues.
3. Introduce project-aware execution context in `main.ts`.
4. Replace static coding-agent cwd binding with per-project cwd resolution.
5. Update lifecycle comments and Discord notifications to surface execution project metadata.
6. Update `runCodingAgent` repo-classification logic to use the active execution repo instead of env globals.

Provisioning changes:

1. Add a generic GitHub admin client/service for repo and label creation.
2. Add project workspace preparation helpers.
3. Add a provisioning issue type or metadata parser.
4. Extend Discord operator control with `startProject <project-name>`.
5. Persist provisioning progress/failure in `.evolvo/projects.json`.
6. Add `.gitignore` coverage for `projects/`.

## Recommended Implementation Phases

Phase 1: Project registry and routing foundation
- project registry
- `project:<slug>` label resolution
- default-project mapping for unlabeled issues
- project-aware execution context and commentary

Phase 2: Provisioning pipeline
- GitHub admin client
- tracker-label ensure
- repo creation/verification
- local workspace preparation
- provisioning state transitions

Phase 3: Operator workflow
- `startProject <project-name>` command parsing
- provisioning-issue creation
- Discord acknowledgements and diagnostics
- recovery/retry behavior for failed provisioning requests

## Follow-up Implementation Issues

To stay within the current max-five-open-issues queue limit, this design creates the next two implementation issues now and keeps later refinements inside those scoped phases until queue space opens again.

Created from this design:

- `#317` project registry, label routing, and project-aware execution context
- `#318` project provisioning pipeline and `startProject <project-name>` operator flow
