import "dotenv/config";
import { pathToFileURL } from "node:url";
import type { CodingAgentRunResult } from "./agents/runCodingAgent.js";
import { OPENAI_API_KEY } from "./environment.js";
import { selectIssueForWorkWithOpenAi } from "./agents/issueSelectionOpenAi.js";
import { configureCodingAgentExecutionContext, runCodingAgent } from "./agents/runCodingAgent.js";
import { runPlannerAgent } from "./agents/plannerAgent.js";
import { WORK_DIR } from "./constants/workDir.js";
import { GitHubAdminClient } from "./github/githubAdminClient.js";
import { GitHubClient } from "./github/githubClient.js";
import { getGitHubConfig } from "./github/githubConfig.js";
import {
  buildLifecycleStateComment,
  transitionCanonicalLifecycleState,
  type CanonicalLifecycleState,
} from "./runtime/lifecycleState.js";
import { writeRuntimeReadinessSignal } from "./runtime/runtimeReadiness.js";
import {
  buildMergedPullRequestReason,
  tryResolveRepositoryDefaultBranch,
} from "./runtime/defaultBranch.js";
import { runPostMergeSelfRestart } from "./runtime/selfRestart.js";
import {
  DEFAULT_PROMPT as LOOP_DEFAULT_PROMPT,
  buildPromptFromIssue,
  formatIssueForLog,
  getRunLoopRetryDelayMs,
  isOutdatedIssue,
    isTransientGitHubError,
    logCreatedIssues,
    logCycleQueueHealth,
    logGitHubFallback,
    logIssuePrioritizationDecision,
    waitForRunLoopRetry,
} from "./runtime/loopUtils.js";
import {
  markGracefulShutdownRequestEnforced,
  readGracefulShutdownRequest,
  type GracefulShutdownRequest,
} from "./runtime/gracefulShutdown.js";
import {
  notifyCycleLimitDecisionAppliedInDiscord,
  notifyDeferredProjectStopTriggeredInDiscord,
  type StatusCommandResult,
  type StopProjectCommandResult,
  notifyIssueStartedInDiscord,
  notifyRuntimeQuittingInDiscord,
  pollDiscordGracefulShutdownCommand,
  requestCycleLimitDecisionFromOperator,
  runDiscordOperatorControlStartupCheck,
  type DiscordControlHandlers,
  startDiscordGracefulShutdownListener,
} from "./runtime/operatorControl.js";
import {
  addIssueLifecycleComment,
  buildIssueExecutionComment,
  buildIssueFailureComment,
  buildIssueStartComment,
  buildMergeOutcomeComment,
  persistChallengeAttemptEvidence,
} from "./runtime/issueLifecyclePresentation.js";
import {
  applyChallengeRetryGate,
  finalizeChallengeSuccess,
  updateChallengeMetrics,
} from "./runtime/challengeLifecycle.js";
import { runIssueCommand } from "./issues/runIssueCommand.js";
import { hasIssueLabel, isChallengeIssue } from "./issues/challengeIssue.js";
import {
  TaskIssueManager,
  type IssueSummary,
  type UnauthorizedIssueClosureResult,
} from "./issues/taskIssueManager.js";
import { buildUnifiedIssueQueue, type UnifiedIssue } from "./issues/unifiedIssueQueue.js";
import {
  buildProjectProvisioningCompletionSummary,
  buildProjectProvisioningOutcomeComment,
  executeProjectProvisioningIssue,
  handleStartProjectCommand,
  isProjectProvisioningRequestIssue,
} from "./projects/projectProvisioning.js";
import { parseProjectProvisioningIssueMetadata } from "./issues/projectProvisioningIssue.js";
import { clearActiveProjectState, readActiveProjectState, stopActiveProjectState } from "./projects/activeProjectState.js";
import {
  PROJECT_ROUTING_BLOCKED_LABEL,
  buildProjectRoutingBlockedComment,
  buildProjectExecutionContext,
  resolveProjectExecutionContextForIssue,
} from "./projects/projectExecutionContext.js";
import { PROJECT_LABEL_PREFIX } from "./projects/projectNaming.js";
import {
  ProjectRepositoryIssueInspector,
  buildProjectRepositoryIssueInspectionLogLines,
  type ProjectRepositoryIssueState,
} from "./projects/projectRepositoryIssues.js";
import {
  buildDefaultProjectContext,
  ensureProjectRegistry,
  findProjectBySlug,
  readProjectRegistry,
} from "./projects/projectRegistry.js";
import {
  buildRuntimeStatusSnapshot,
  type RuntimeStatusIssue,
  type RuntimeStatusProject,
  type RuntimeStatusState,
} from "./runtime/runtimeStatus.js";

const MAX_ISSUE_CYCLES = 10;
const MIN_REPLENISH_ISSUES = 3;
const MAX_OPEN_ISSUES = 5;
const RUN_LOOP_GITHUB_MAX_RETRIES = 2;
const STOPPED_PROJECT_IDLE_WAIT_MS = 1_000;
export const DEFAULT_PROMPT = LOOP_DEFAULT_PROMPT;

function getLifecycleEntityKind(issue: IssueSummary): "issue" | "challenge" {
  return isChallengeIssue(issue) ? "challenge" : "issue";
}

function buildLifecycleDerivedState(issue: IssueSummary, runResult: CodingAgentRunResult | null): {
  issueState: "open" | "closed";
  labels: string[];
  isChallenge: boolean;
  reviewOutcome: string | null;
  pullRequestCreated: boolean | null;
  mergedPullRequest: boolean | null;
} {
  return {
    issueState: issue.state,
    labels: [...issue.labels],
    isChallenge: isChallengeIssue(issue),
    reviewOutcome: runResult?.summary.reviewOutcome ?? null,
    pullRequestCreated: runResult?.summary.pullRequestCreated ?? null,
    mergedPullRequest: runResult?.mergedPullRequest ?? null,
  };
}

function mapReviewOutcomeToLifecycleState(reviewOutcome: string): "accepted" | "amended" | "rejected" {
  if (reviewOutcome === "accepted") {
    return "accepted";
  }

  if (reviewOutcome === "amended") {
    return "amended";
  }

  return "rejected";
}

function logUnauthorizedIssueClosure(result: UnauthorizedIssueClosureResult): void {
  const authorLogin = result.authorLogin ?? "unknown";
  const actionSummary = result.closed ? "closed automatically" : "could not be closed automatically";
  console.log(`Unauthorized issue #${result.issueNumber} ${result.issueTitle} by ${authorLogin} ${actionSummary}.`);

  if (result.commentMessage) {
    const log = result.commentAdded ? console.log : console.error;
    log(result.commentMessage);
  }

  if (!result.closed) {
    console.error(result.closeMessage);
  }
}

function isTrackerIssue(issue: UnifiedIssue): boolean {
  return issue.sourceKind === "tracker";
}

function getIssueManagerForUnifiedIssue(
  trackerIssueManager: TaskIssueManager,
  issue: UnifiedIssue,
): TaskIssueManager {
  if (issue.sourceKind === "tracker") {
    return trackerIssueManager;
  }

  return trackerIssueManager.forRepository({
    owner: issue.repository.owner,
    repo: issue.repository.repo,
  });
}

async function transitionIssueLifecycleState(
  issueManager: TaskIssueManager,
  options: {
    issue: IssueSummary;
    nextState: CanonicalLifecycleState;
    reason: string;
    cycle: number;
    runResult?: CodingAgentRunResult | null;
  },
): Promise<void> {
  try {
    const transition = await transitionCanonicalLifecycleState(WORK_DIR, {
      issueNumber: options.issue.number,
      kind: getLifecycleEntityKind(options.issue),
      nextState: options.nextState,
      reason: options.reason,
      runCycle: options.cycle,
    });
    if (!transition.ok || transition.entry === null) {
      console.error(`Could not persist canonical lifecycle state for issue #${options.issue.number}: ${transition.message}`);
      return;
    }

    const comment = buildLifecycleStateComment({
      issueNumber: options.issue.number,
      currentState: options.nextState,
      previousState: transition.previousState,
      kind: transition.entry.kind,
      reason: options.reason,
      derived: buildLifecycleDerivedState(options.issue, options.runResult ?? null),
    });
    await addIssueLifecycleComment(issueManager, options.issue.number, comment);
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Could not persist canonical lifecycle state for issue #${options.issue.number}: ${error.message}`);
      return;
    }

    console.error(`Could not persist canonical lifecycle state for issue #${options.issue.number}: unknown error.`);
  }
}

async function signalRestartReadinessIfRequested(workDir: string): Promise<void> {
  const token = process.env.EVOLVO_RESTART_TOKEN?.trim();
  if (!token) {
    return;
  }

  const signalPathOverride = process.env.EVOLVO_READINESS_FILE?.trim();
  const signalPath = await writeRuntimeReadinessSignal({
    workDir,
    token,
    signalPath: signalPathOverride || undefined,
  });
  console.log(`[startup] Runtime readiness signal written: ${signalPath}`);
}

function buildGracefulShutdownLogMessage(
  request: GracefulShutdownRequest,
  reason: string,
): string {
  return `Graceful shutdown requested via Discord ${request.command}. ${reason} Shutdown intent remains persisted so later restarts do not resume work unexpectedly.`;
}

function buildGracefulShutdownQuitNotificationReason(
  request: GracefulShutdownRequest,
  reason: string,
): string {
  return `Graceful shutdown via ${request.command} is being enforced. ${reason}`;
}

function isQueueDrainGracefulShutdownRequest(request: GracefulShutdownRequest | null): boolean {
  return request?.mode === "after-tasks";
}

function isEnforcedGracefulShutdownRequest(request: GracefulShutdownRequest | null): boolean {
  return request?.enforcedAt !== null;
}

function buildStopProjectResultLog(result: StopProjectCommandResult): string {
  if (!result.ok) {
    return `[stopProject] failed: ${result.message}`;
  }

  if (result.action === "stopped") {
    return `[stopProject] halted project ${result.project?.displayName ?? result.project?.slug ?? "unknown"}. Runtime remains online.`;
  }

  if (result.action === "stop-when-complete-scheduled") {
    return `[stopProject] project ${result.project?.displayName ?? result.project?.slug ?? "unknown"} will stop automatically when it runs out of actionable work. Evolvo will then return to self-work.`;
  }

  if (result.action === "already-stop-when-complete-scheduled") {
    return `[stopProject] project ${result.project?.displayName ?? result.project?.slug ?? "unknown"} is already scheduled to stop when complete. Evolvo will return to self-work afterward.`;
  }

  if (result.action === "already-stopped") {
    return `[stopProject] project ${result.project?.displayName ?? result.project?.slug ?? "unknown"} was already halted. Runtime remains online.`;
  }

  return "[stopProject] no active project was selected. Runtime remains online.";
}

async function resolveActiveStatusProject(
  activeProjectSlug: string | null,
  defaultProjectContext: ReturnType<typeof buildDefaultProjectContext>,
): Promise<RuntimeStatusProject | null> {
  if (activeProjectSlug === null) {
    return null;
  }

  try {
    const registry = await readProjectRegistry(WORK_DIR, defaultProjectContext);
    const projectRecord = findProjectBySlug(registry, activeProjectSlug);
    if (projectRecord !== null) {
      return {
        displayName: projectRecord.displayName,
        slug: projectRecord.slug,
        repository: `${projectRecord.executionRepo.owner}/${projectRecord.executionRepo.repo}`,
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    console.error(`[status] could not resolve project metadata for ${activeProjectSlug}: ${message}`);
  }

  return {
    displayName: activeProjectSlug,
    slug: activeProjectSlug,
    repository: null,
  };
}

function issueTargetsProject(issue: UnifiedIssue, projectSlug: string): boolean {
  const normalizedProjectSlug = projectSlug.trim().toLowerCase();
  if (!normalizedProjectSlug) {
    return false;
  }

  if (issue.projectSlug?.trim().toLowerCase() === normalizedProjectSlug) {
    return true;
  }

  const provisioningSlug = parseProjectProvisioningIssueMetadata(issue.description)?.slug?.trim().toLowerCase();
  if (provisioningSlug === normalizedProjectSlug) {
    return true;
  }

  return issue.labels.some((label) => label.trim().toLowerCase() === `${PROJECT_LABEL_PREFIX}${normalizedProjectSlug}`);
}

async function readPendingGracefulShutdownRequest(
  workDir: string,
  discordHandlers: DiscordControlHandlers,
): Promise<GracefulShutdownRequest | null> {
  await pollDiscordGracefulShutdownCommand(workDir, discordHandlers);
  return readGracefulShutdownRequest(workDir);
}

async function stopIfSingleTaskGracefulShutdownRequested(
  workDir: string,
  reason: string,
  discordHandlers: DiscordControlHandlers,
): Promise<boolean> {
  const request = await readPendingGracefulShutdownRequest(workDir, discordHandlers);
  if (request === null) {
    return false;
  }

  if (isQueueDrainGracefulShutdownRequest(request) && !isEnforcedGracefulShutdownRequest(request)) {
    return false;
  }

  const enforced = await markGracefulShutdownRequestEnforced(workDir);
  const activeRequest = enforced?.request ?? request;
  console.log(buildGracefulShutdownLogMessage(activeRequest, reason));
  await notifyRuntimeQuittingInDiscord(buildGracefulShutdownQuitNotificationReason(activeRequest, reason));
  return true;
}

async function stopIfGracefulShutdownPreventsNewWork(
  workDir: string,
  reason: string,
  discordHandlers: DiscordControlHandlers,
): Promise<boolean> {
  const request = await readPendingGracefulShutdownRequest(workDir, discordHandlers);
  if (request === null) {
    return false;
  }

  const enforced = await markGracefulShutdownRequestEnforced(workDir);
  const shutdownReason = isQueueDrainGracefulShutdownRequest(request)
    ? "Queue-drain shutdown is active. Planning and replenishment are disabled, so no new work will be started."
    : reason;
  const activeRequest = enforced?.request ?? request;
  console.log(buildGracefulShutdownLogMessage(activeRequest, shutdownReason));
  await notifyRuntimeQuittingInDiscord(buildGracefulShutdownQuitNotificationReason(activeRequest, shutdownReason));
  return true;
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const issueCommandHandled = await runIssueCommand(args);
  if (issueCommandHandled) {
    return;
  }

  const { GITHUB_OWNER, GITHUB_REPO } = await import("./environment.js");
  const githubConfig = getGitHubConfig();
  const githubClient = new GitHubClient(githubConfig);
  const issueManager = new TaskIssueManager(githubClient);
  const adminClient = new GitHubAdminClient(githubClient, githubConfig);
  const projectRepositoryIssueInspector = new ProjectRepositoryIssueInspector(githubClient);
  const defaultProjectContext = buildDefaultProjectContext({
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO,
    workDir: WORK_DIR,
  });
  let activeProjectState = await readActiveProjectState(WORK_DIR);
  let stoppedProjectIdleLoggedSlug: string | null = null;
  let runtimeStatusState: RuntimeStatusState = "starting";
  let runtimeStatusActivitySummary = "Starting runtime.";
  let runtimeStatusCycle: number | null = null;
  let runtimeStatusCycleLimit: number | null = MAX_ISSUE_CYCLES;
  let runtimeStatusIssue: RuntimeStatusIssue | null = null;
  const discordHandlers: DiscordControlHandlers = {
    onStartProject: async (request) => {
      const result = await handleStartProjectCommand({
        issueManager,
        workDir: WORK_DIR,
        trackerOwner: GITHUB_OWNER,
        trackerRepo: GITHUB_REPO,
        projectName: request.displayName,
        requestedBy: request.requestedBy,
        requestedAt: request.requestedAt,
      });
      if (result.ok) {
        activeProjectState = {
          version: activeProjectState.version,
          activeProjectSlug: result.project.slug,
          selectionState: "active",
          updatedAt: request.requestedAt,
          requestedBy: request.requestedBy,
          source: "start-project-command",
        };
        stoppedProjectIdleLoggedSlug = null;
        console.log(
          result.action === "created"
            ? `[startProject] created new project flow for ${result.project.displayName} (${result.project.slug}) at ${result.project.workspacePath}.`
            : `[startProject] resumed existing project ${result.project.displayName} (${result.project.slug}) with status ${result.project.status} at ${result.project.workspacePath}.`,
        );
      } else {
        console.error(`[startProject] failed for ${request.displayName}: ${result.message}`);
      }
      return result;
    },
    onStopProject: async (request) => {
      console.log(`[stopProject] received stop request from ${request.requestedBy}.`);
      const stopResult = await stopActiveProjectState({
        workDir: WORK_DIR,
        requestedBy: request.requestedBy,
        mode: request.mode,
        updatedAt: request.requestedAt,
      });
      activeProjectState = stopResult.state;
      let projectRecord = null;
      if (stopResult.state.activeProjectSlug !== null) {
        try {
          const registry = await readProjectRegistry(WORK_DIR, defaultProjectContext);
          projectRecord = findProjectBySlug(registry, stopResult.state.activeProjectSlug);
        } catch {
          projectRecord = null;
        }
      }
      const result: StopProjectCommandResult = stopResult.status === "stopped"
        ? {
          ok: true,
          action: "stopped",
          message: `Project \`${projectRecord?.slug ?? stopResult.state.activeProjectSlug ?? "unknown"}\` will not be selected again until \`startProject <project-name>\` is used.`,
          ...(projectRecord
            ? {
              project: {
                displayName: projectRecord.displayName,
                slug: projectRecord.slug,
              },
            }
            : {}),
        }
        : stopResult.status === "stop-when-complete-scheduled"
          ? {
            ok: true,
            action: "stop-when-complete-scheduled",
            message: `Project \`${projectRecord?.slug ?? stopResult.state.activeProjectSlug ?? "unknown"}\` will keep running until it has no actionable issues left. Evolvo will then stop it automatically, return to self-work, and remain online.`,
            ...(projectRecord
              ? {
                project: {
                  displayName: projectRecord.displayName,
                  slug: projectRecord.slug,
                },
              }
              : {}),
          }
          : stopResult.status === "already-stop-when-complete-scheduled"
            ? {
              ok: true,
              action: "already-stop-when-complete-scheduled",
              message: `Project \`${projectRecord?.slug ?? stopResult.state.activeProjectSlug ?? "unknown"}\` is already scheduled to stop when it runs out of actionable work. Evolvo will return to self-work afterward.`,
              ...(projectRecord
                ? {
                  project: {
                    displayName: projectRecord.displayName,
                    slug: projectRecord.slug,
                  },
                }
                : {}),
            }
        : stopResult.status === "already-stopped"
          ? {
            ok: true,
            action: "already-stopped",
            message: `Project \`${projectRecord?.slug ?? stopResult.state.activeProjectSlug ?? "unknown"}\` is already halted. Use \`startProject <project-name>\` to resume it later.`,
            ...(projectRecord
              ? {
                project: {
                  displayName: projectRecord.displayName,
                  slug: projectRecord.slug,
                },
              }
              : {}),
          }
          : {
            ok: true,
            action: "no-active-project",
            message: "There is no active project to stop. Evolvo remains online and ready for further operator commands.",
          };
      console.log(buildStopProjectResultLog(result));
      return result;
    },
    onStatus: async (request): Promise<StatusCommandResult> => {
      const activeProject = await resolveActiveStatusProject(activeProjectState.activeProjectSlug, defaultProjectContext);
      const snapshot = buildRuntimeStatusSnapshot({
        runtimeState: runtimeStatusState,
        activitySummary: runtimeStatusActivitySummary,
        activeProjectState,
        activeProject,
        activeIssue: runtimeStatusIssue,
        currentCycle: runtimeStatusCycle,
        cycleLimit: runtimeStatusCycleLimit,
      });
      console.log(
        `[status] served runtime status to ${request.requestedBy}: state=${snapshot.runtimeState} mode=${snapshot.workMode} project=${snapshot.activeProject?.slug ?? "none"} issue=${snapshot.activeIssue?.number ?? "none"}`,
      );
      return {
        ok: true,
        snapshot,
      };
    },
  };

  console.log(`Hello from ${GITHUB_OWNER}/${GITHUB_REPO}!`);
  console.log(`Working directory: ${WORK_DIR}`);
  await ensureProjectRegistry(WORK_DIR, defaultProjectContext);
  await signalRestartReadinessIfRequested(WORK_DIR);
  await runDiscordOperatorControlStartupCheck();
  const gracefulShutdownListener = await startDiscordGracefulShutdownListener(WORK_DIR, discordHandlers);

  try {
    if (await stopIfSingleTaskGracefulShutdownRequested(WORK_DIR, "Stopping before starting a new task.", discordHandlers)) {
      return;
    }

    let cycleLimit = MAX_ISSUE_CYCLES;
    issueCycleLoop: for (let cycle = 1; ; cycle += 1) {
      runtimeStatusState = "active";
      runtimeStatusActivitySummary = "Selecting the next issue.";
      runtimeStatusCycle = cycle;
      runtimeStatusCycleLimit = cycleLimit;
      runtimeStatusIssue = null;
      if (await stopIfSingleTaskGracefulShutdownRequested(WORK_DIR, "Stopping before starting a new task.", discordHandlers)) {
        return;
      }

      if (cycle > cycleLimit) {
        runtimeStatusState = "waiting";
        runtimeStatusActivitySummary = "Waiting for operator cycle-limit decision.";
        const operatorDecision = await requestCycleLimitDecisionFromOperator(cycleLimit);
        if (operatorDecision?.decision === "continue" && operatorDecision.additionalCycles > 0) {
          const currentLimit = cycleLimit;
          cycleLimit += operatorDecision.additionalCycles;
          runtimeStatusState = "active";
          runtimeStatusActivitySummary = "Resuming work after cycle-limit extension.";
          runtimeStatusCycleLimit = cycleLimit;
          console.log(
            `Operator decision via Discord: continue (+${operatorDecision.additionalCycles} cycles). New limit=${cycleLimit}.`,
          );
          await notifyCycleLimitDecisionAppliedInDiscord({
            decision: "continue",
            currentLimit,
            additionalCycles: operatorDecision.additionalCycles,
            newLimit: cycleLimit,
          });
          continue;
        }
        if (operatorDecision?.decision === "quit") {
          console.error("Operator decision via Discord: quit.");
          runtimeStatusState = "stopping";
          runtimeStatusActivitySummary = "Stopping after operator cycle-limit quit decision.";
          await notifyCycleLimitDecisionAppliedInDiscord({
            decision: "quit",
            currentLimit: cycleLimit,
          });
        }
        console.error(`Reached the maximum number of issue cycles (${cycleLimit}).`);
        if (operatorDecision?.decision !== "quit") {
          runtimeStatusState = "stopping";
          runtimeStatusActivitySummary = `Stopping because cycle limit ${cycleLimit} was reached.`;
          await notifyRuntimeQuittingInDiscord(
            `Cycle limit of ${cycleLimit} was reached and no continue decision was applied.`,
          );
        }
        return;
      }

      let retryAttempt = 0;
      while (true) {
        try {
          const unifiedQueue = await buildUnifiedIssueQueue({
            trackerIssueManager: issueManager,
            workDir: WORK_DIR,
            defaultProject: defaultProjectContext,
            activeProjectState,
          });
          const openIssues = unifiedQueue.issues;
          for (const unauthorizedClosure of unifiedQueue.unauthorizedClosures) {
            logUnauthorizedIssueClosure(unauthorizedClosure);
          }
          const actionableIssues: UnifiedIssue[] = [];

          for (const issue of openIssues) {
            if (!isOutdatedIssue(issue)) {
              actionableIssues.push(issue);
              continue;
            }

            const scopedIssueManager = getIssueManagerForUnifiedIssue(issueManager, issue);
            const result = await scopedIssueManager.closeIssue(issue.number);
            if (result.ok) {
              console.log(`Closed outdated issue ${formatIssueForLog(issue)}.`);
            } else {
              console.error(`Could not close outdated issue #${issue.number}: ${result.message}`);
            }
          }

          const trackerActionableIssues = actionableIssues.filter((issue) => isTrackerIssue(issue));
          const projectActionableIssues = actionableIssues.filter((issue) => !isTrackerIssue(issue));
          const retryEligibleIssues = await applyChallengeRetryGate({
            issueManager,
            openIssues: trackerActionableIssues,
            issues: trackerActionableIssues,
            cycle,
            onBlockedTransition: async (issue, transitionCycle, reason) => {
              await transitionIssueLifecycleState(issueManager, {
                issue,
                nextState: "blocked",
                reason: `retry gate decision: ${reason}`,
                cycle: transitionCycle,
              });
            },
          });
          const selectionCandidates = [...projectActionableIssues, ...retryEligibleIssues as UnifiedIssue[]];
          if (await stopIfSingleTaskGracefulShutdownRequested(WORK_DIR, "Stopping before starting a new task.", discordHandlers)) {
            return;
          }

          if (
            activeProjectState.selectionState === "active"
            && activeProjectState.activeProjectSlug !== null
            && activeProjectState.deferredStopMode === "when-project-complete"
          ) {
            const activeProjectSelectionCandidates = selectionCandidates.filter((issue) =>
              issueTargetsProject(issue, activeProjectState.activeProjectSlug ?? "")
            );
            if (activeProjectSelectionCandidates.length === 0) {
              if (unifiedQueue.activeManagedProject !== null) {
                runtimeStatusState = "active";
                runtimeStatusActivitySummary = `Replenishing project work for ${unifiedQueue.activeManagedProject.slug}.`;
                if (
                  await stopIfGracefulShutdownPreventsNewWork(
                    WORK_DIR,
                    "Stopping before planner replenishment.",
                    discordHandlers,
                  )
                ) {
                  return;
                }

                const plannerResult = await runPlannerAgent({
                  cycle,
                  openIssueCount: activeProjectSelectionCandidates.length,
                  minimumIssueCount: MIN_REPLENISH_ISSUES,
                  maximumOpenIssues: MAX_OPEN_ISSUES,
                  issueManager: issueManager.forRepository({
                    owner: unifiedQueue.activeManagedProject.executionRepo.owner,
                    repo: unifiedQueue.activeManagedProject.executionRepo.repo,
                  }),
                  workDir: unifiedQueue.activeManagedProject.cwd,
                });
                const createdIssues = plannerResult.created;
                logCycleQueueHealth({
                  cycle,
                  openCount: openIssues.length,
                  selectedIssue: null,
                  queueAction: {
                    type: plannerResult.startupBootstrap ? "bootstrap" : "replenish",
                    createdCount: createdIssues.length,
                    outcome: createdIssues.length > 0 ? "continue" : "stop",
                  },
                });

                if (createdIssues.length > 0) {
                  if (
                    await stopIfGracefulShutdownPreventsNewWork(
                      WORK_DIR,
                      "Stopping before starting a new task.",
                      discordHandlers,
                    )
                  ) {
                    return;
                  }

                  logCreatedIssues(createdIssues);
                  continue issueCycleLoop;
                }
              }

              const completedProject = unifiedQueue.activeManagedProject ?? {
                slug: activeProjectState.activeProjectSlug,
                displayName: activeProjectState.activeProjectSlug,
              };
              runtimeStatusState = "active";
              runtimeStatusActivitySummary = `Deferred project stop triggered for ${completedProject.slug}. Returning to self-work.`;
              console.log(
                `[stopProject] project ${completedProject.slug} reached completion with deferred stop active. No actionable project work remains.`,
              );
              activeProjectState = await clearActiveProjectState(WORK_DIR);
              stoppedProjectIdleLoggedSlug = null;
              console.log(
                `[stopProject] switched from project ${completedProject.displayName} (${completedProject.slug}) back to Evolvo self-work. Runtime remains online.`,
              );
              await notifyDeferredProjectStopTriggeredInDiscord({
                displayName: completedProject.displayName,
                slug: completedProject.slug,
              });
              cycle -= 1;
              continue issueCycleLoop;
            }
          }

          const selectionDecision = await selectIssueForWorkWithOpenAi({
            apiKey: OPENAI_API_KEY,
            issues: selectionCandidates,
            activeProjectSlug: activeProjectState.selectionState === "active" ? activeProjectState.activeProjectSlug : null,
            stoppedProjectSlug: activeProjectState.selectionState === "stopped" ? activeProjectState.activeProjectSlug : null,
          });
          const selectedIssue = selectionDecision.selectedIssue;
          if (selectedIssue !== null || activeProjectState.selectionState !== "stopped") {
            stoppedProjectIdleLoggedSlug = null;
          }

          if (!selectedIssue) {
            if (activeProjectState.selectionState === "stopped" && activeProjectState.activeProjectSlug !== null) {
              runtimeStatusState = "waiting";
              runtimeStatusActivitySummary =
                `Waiting for further operator instructions while project ${activeProjectState.activeProjectSlug} remains stopped.`;
              if (
                await stopIfGracefulShutdownPreventsNewWork(
                  WORK_DIR,
                  "Stopping before entering stopped-project idle mode.",
                  discordHandlers,
                )
              ) {
                return;
              }

              if (stoppedProjectIdleLoggedSlug !== activeProjectState.activeProjectSlug) {
                console.log(
                  `[stopProject] project ${activeProjectState.activeProjectSlug} is halted. Runtime remains online and is waiting for further operator instructions.`,
                );
                stoppedProjectIdleLoggedSlug = activeProjectState.activeProjectSlug;
              }
              await waitForRunLoopRetry(STOPPED_PROJECT_IDLE_WAIT_MS);
              cycle -= 1;
              continue issueCycleLoop;
            }

            if (
              await stopIfGracefulShutdownPreventsNewWork(
                WORK_DIR,
                "Stopping before planner replenishment.",
                discordHandlers,
              )
            ) {
              return;
            }

            runtimeStatusState = "active";
            runtimeStatusActivitySummary = unifiedQueue.activeManagedProject !== null
              ? `Replenishing project work for ${unifiedQueue.activeManagedProject.slug}.`
              : "Replenishing self-work issue queue.";
            const plannerResult = await runPlannerAgent({
              cycle,
              openIssueCount: openIssues.length,
              minimumIssueCount: MIN_REPLENISH_ISSUES,
              maximumOpenIssues: MAX_OPEN_ISSUES,
              issueManager: unifiedQueue.activeManagedProject
                ? issueManager.forRepository({
                  owner: unifiedQueue.activeManagedProject.executionRepo.owner,
                  repo: unifiedQueue.activeManagedProject.executionRepo.repo,
                })
                : issueManager,
              workDir: unifiedQueue.activeManagedProject?.cwd ?? WORK_DIR,
            });
            const createdIssues = plannerResult.created;
            logCycleQueueHealth({
              cycle,
              openCount: openIssues.length,
              selectedIssue: null,
              queueAction: {
                type: plannerResult.startupBootstrap ? "bootstrap" : "replenish",
                createdCount: createdIssues.length,
                outcome: createdIssues.length > 0 ? "continue" : "stop",
              },
            });

            if (createdIssues.length > 0) {
              if (
                await stopIfGracefulShutdownPreventsNewWork(
                  WORK_DIR,
                  "Stopping before starting a new task.",
                  discordHandlers,
                )
              ) {
                return;
              }

              if (plannerResult.startupBootstrap) {
                console.log("No open issues found on startup. Bootstrapped issue queue from repository analysis.");
              }
              logCreatedIssues(createdIssues);
              continue issueCycleLoop;
            }

            if (await stopIfGracefulShutdownPreventsNewWork(WORK_DIR, "Stopping before starting a new task.", discordHandlers)) {
              return;
            }

            if (cycle === 1) {
              runtimeStatusState = "stopping";
              runtimeStatusActivitySummary = "Stopping because no open issues are available on startup.";
              console.log(DEFAULT_PROMPT);
              await notifyRuntimeQuittingInDiscord(
                "No open issues are available, so Evolvo is shutting down until more work is created.",
              );
            } else {
              runtimeStatusState = "stopping";
              runtimeStatusActivitySummary = "Stopping because no actionable work remains.";
              console.log("No actionable open issues remaining and no new issues were created. Issue loop stopped.");
              await notifyRuntimeQuittingInDiscord(
                "No actionable open issues remain and no new work was created, so Evolvo is shutting down.",
              );
            }
            return;
          }

          logIssuePrioritizationDecision(selectionDecision);
          logCycleQueueHealth({
            cycle,
            openCount: openIssues.length,
            selectedIssue,
          });
          const selectedIssueManager = getIssueManagerForUnifiedIssue(issueManager, selectedIssue);
          const executionContext = selectedIssue.sourceKind === "project-repo" && selectedIssue.project !== null
            ? buildProjectExecutionContext(selectedIssue.project)
            : await (async () => {
              const projectResolution = await resolveProjectExecutionContextForIssue({
                issue: selectedIssue,
                workDir: WORK_DIR,
                defaultProject: defaultProjectContext,
              });
              if (!projectResolution.ok) {
                const routingComment = buildProjectRoutingBlockedComment(selectedIssue, projectResolution);
                await addIssueLifecycleComment(selectedIssueManager, selectedIssue.number, routingComment);
                await transitionIssueLifecycleState(issueManager, {
                  issue: selectedIssue,
                  nextState: "blocked",
                  reason: `project routing blocked: ${projectResolution.message}`,
                  cycle,
                });
                const blockLabelResult = await selectedIssueManager.updateLabels(selectedIssue.number, {
                  add: [PROJECT_ROUTING_BLOCKED_LABEL],
                  remove: ["in progress"],
                });
                if (!blockLabelResult.ok) {
                  console.error(`Could not block issue #${selectedIssue.number} for invalid project routing: ${blockLabelResult.message}`);
                }
                return null;
              }

              return projectResolution.context;
            })();
          if (executionContext === null) {
            continue;
          }

          if (isTrackerIssue(selectedIssue)) {
            await transitionIssueLifecycleState(issueManager, {
              issue: selectedIssue,
              nextState: "selected",
              reason: "issue selected for active execution in this cycle",
              cycle,
            });
          }

          let startedThisCycle = false;
          if (!hasIssueLabel(selectedIssue, "in progress")) {
            const result = await selectedIssueManager.markInProgress(selectedIssue.number);
            if (!result.ok) {
              console.error(`Could not mark issue #${selectedIssue.number} as in progress: ${result.message}`);
            } else {
              startedThisCycle = true;
            }
          }

          if (startedThisCycle) {
            await addIssueLifecycleComment(selectedIssueManager, selectedIssue.number, buildIssueStartComment(selectedIssue, executionContext));
            await notifyIssueStartedInDiscord({
              issue: {
                number: selectedIssue.number,
                title: selectedIssue.title,
                repository: selectedIssue.repository.reference,
                url: `${selectedIssue.repository.url}/issues/${selectedIssue.number}`,
              },
              executionContext: {
                trackerRepository: executionContext.trackerRepository,
                executionRepository: executionContext.executionRepository,
                project: {
                  displayName: executionContext.project.displayName,
                  slug: executionContext.project.slug,
                },
              },
              lifecycleState: "selected -> executing",
            });
          }

          runtimeStatusState = "active";
          runtimeStatusActivitySummary = `Executing issue #${selectedIssue.number}.`;
          runtimeStatusIssue = {
            number: selectedIssue.number,
            title: selectedIssue.title,
            repository: selectedIssue.repository.reference,
            lifecycleState: "selected -> executing",
          };

          const isProvisioningIssue = isTrackerIssue(selectedIssue) && isProjectProvisioningRequestIssue(selectedIssue);
          if (isTrackerIssue(selectedIssue)) {
            await transitionIssueLifecycleState(issueManager, {
              issue: selectedIssue,
              nextState: "executing",
              reason: isProvisioningIssue
                ? "project provisioning execution started"
                : "coding agent execution started",
              cycle,
            });
          }

          if (isProvisioningIssue) {
            const provisioningResult = await executeProjectProvisioningIssue({
              issue: selectedIssue,
              workDir: WORK_DIR,
              trackerOwner: GITHUB_OWNER,
              trackerRepo: GITHUB_REPO,
              adminClient,
            });
            await addIssueLifecycleComment(
              selectedIssueManager,
              selectedIssue.number,
              buildProjectProvisioningOutcomeComment(provisioningResult),
            );

            if (provisioningResult.ok) {
              activeProjectState = {
                version: activeProjectState.version,
                activeProjectSlug: provisioningResult.record.slug,
                selectionState: "active",
                updatedAt: new Date().toISOString(),
                requestedBy: provisioningResult.metadata.requestedBy,
                source: "project-provisioning",
              };
              stoppedProjectIdleLoggedSlug = null;
              await transitionIssueLifecycleState(issueManager, {
                issue: selectedIssue,
                nextState: "accepted",
                reason: "project provisioning request completed successfully",
                cycle,
              });
              const completionResult = await selectedIssueManager.markCompleted(
                selectedIssue.number,
                buildProjectProvisioningCompletionSummary(provisioningResult),
              );
              if (!completionResult.ok) {
                console.error(`Could not mark issue #${selectedIssue.number} as completed: ${completionResult.message}`);
              }
              const closeResult = await selectedIssueManager.closeIssue(selectedIssue.number);
              if (!closeResult.ok) {
                console.error(`Could not close issue #${selectedIssue.number}: ${closeResult.message}`);
              } else {
                await transitionIssueLifecycleState(issueManager, {
                  issue: selectedIssue,
                  nextState: "completed",
                  reason: "project provisioning request completed and issue was closed",
                  cycle,
                });
              }
            } else {
              await transitionIssueLifecycleState(issueManager, {
                issue: selectedIssue,
                nextState: "failed",
                reason: `project provisioning failed at ${provisioningResult.failureStep ?? "unknown"} step`,
                cycle,
              });
              const resetLabels = await selectedIssueManager.updateLabels(selectedIssue.number, {
                remove: ["in progress"],
              });
              if (!resetLabels.ok) {
                console.error(`Could not clear in-progress label for issue #${selectedIssue.number}: ${resetLabels.message}`);
              }
              const closeResult = await selectedIssueManager.closeIssue(selectedIssue.number);
              if (!closeResult.ok) {
                console.error(`Could not close failed provisioning issue #${selectedIssue.number}: ${closeResult.message}`);
              }
            }

            runtimeStatusIssue = null;
            runtimeStatusActivitySummary = "Selecting the next issue.";

            if (
              await stopIfSingleTaskGracefulShutdownRequested(
                WORK_DIR,
                "Current task completed. Stopping before starting another issue.",
                discordHandlers,
              )
            ) {
              return;
            }

            break;
          }

          let projectRepositoryIssueState: ProjectRepositoryIssueState | null = null;
          if (executionContext.project.kind === "managed") {
            try {
              projectRepositoryIssueState = await projectRepositoryIssueInspector.inspectProject(executionContext.project);
              for (const logLine of buildProjectRepositoryIssueInspectionLogLines(projectRepositoryIssueState)) {
                console.log(logLine);
              }
              console.log(
                `[project-issues] using ${projectRepositoryIssueState.repository.reference} issue state to shape execution planning for ${selectedIssue.queueKey}.`,
              );
            } catch (error) {
              const repositoryReference =
                `${executionContext.project.executionRepo.owner}/${executionContext.project.executionRepo.repo}`;
              const message = error instanceof Error ? error.message : "unknown error";
              console.error(
                `[project-issues] failed to inspect project=${executionContext.project.slug} repository=${repositoryReference}: ${message}`,
              );
            }
          }

          const prompt = buildPromptFromIssue(selectedIssue, {
            projectRepositoryIssueState,
          });
          console.log(`Prompt: ${prompt}`);
          configureCodingAgentExecutionContext({
            workDir: executionContext.project.cwd,
            internalRepositoryUrls: [
              executionContext.project.trackerRepo.url,
              executionContext.project.executionRepo.url,
            ],
          });
          let runError: unknown = null;
          const runResult = await runCodingAgent(prompt).catch((error) => {
            runError = error;
            console.error("Error running the coding agent:", error);
            return null;
          });

          if (runError) {
            runtimeStatusIssue = null;
            runtimeStatusActivitySummary = "Selecting the next issue.";
            if (isTrackerIssue(selectedIssue)) {
              await transitionIssueLifecycleState(issueManager, {
                issue: selectedIssue,
                nextState: "failed",
                reason: "runtime error during coding agent execution",
                cycle,
              });
            }
            const challengeEvidence = isTrackerIssue(selectedIssue)
              ? await persistChallengeAttemptEvidence(WORK_DIR, selectedIssue, runError, runResult)
              : null;
            if (isTrackerIssue(selectedIssue)) {
              await updateChallengeMetrics(selectedIssueManager, selectedIssue, runError, runResult);
            }
            await addIssueLifecycleComment(
              selectedIssueManager,
              selectedIssue.number,
              buildIssueFailureComment(selectedIssue, runError, challengeEvidence),
            );
            continue issueCycleLoop;
          }

          let mergedDefaultBranch: string | null = null;
          if (runResult) {
            mergedDefaultBranch = runResult.mergedPullRequest
              ? await tryResolveRepositoryDefaultBranch(executionContext.project.cwd)
              : null;
            if (isTrackerIssue(selectedIssue)) {
              await transitionIssueLifecycleState(issueManager, {
                issue: selectedIssue,
                nextState: "under_review",
                reason: "coding agent execution completed and review result is being processed",
                cycle,
                runResult,
              });
              await transitionIssueLifecycleState(issueManager, {
                issue: selectedIssue,
                nextState: mapReviewOutcomeToLifecycleState(runResult.summary.reviewOutcome),
                reason: `review outcome received: ${runResult.summary.reviewOutcome}`,
                cycle,
                runResult,
              });
              if (runResult.summary.reviewOutcome === "accepted" && runResult.summary.pullRequestCreated) {
                await transitionIssueLifecycleState(issueManager, {
                  issue: selectedIssue,
                  nextState: "committed",
                  reason: "commit evidence observed through pull request creation",
                  cycle,
                  runResult,
                });
              }
              if (runResult.summary.pullRequestCreated) {
                await transitionIssueLifecycleState(issueManager, {
                  issue: selectedIssue,
                  nextState: "pr_opened",
                  reason: "pull request created for this lifecycle",
                  cycle,
                  runResult,
                });
              }
            }
            const challengeEvidence = isTrackerIssue(selectedIssue)
              ? await persistChallengeAttemptEvidence(WORK_DIR, selectedIssue, runError, runResult)
              : null;
            if (isTrackerIssue(selectedIssue)) {
              await updateChallengeMetrics(selectedIssueManager, selectedIssue, runError, runResult);
            }
            await addIssueLifecycleComment(
              selectedIssueManager,
              selectedIssue.number,
              buildIssueExecutionComment(selectedIssue, runResult, challengeEvidence, mergedDefaultBranch, executionContext),
            );
            const challengeCompleted = isTrackerIssue(selectedIssue)
              ? await finalizeChallengeSuccess(
                selectedIssueManager,
                selectedIssue,
                runResult,
                mergedDefaultBranch,
              )
              : false;
            if (challengeCompleted && isTrackerIssue(selectedIssue)) {
              await transitionIssueLifecycleState(issueManager, {
                issue: selectedIssue,
                nextState: "completed",
                reason: "challenge issue marked as completed after accepted review outcome",
                cycle,
                runResult,
              });
            }
          }

          if (runResult?.mergedPullRequest) {
            if (isTrackerIssue(selectedIssue)) {
              await transitionIssueLifecycleState(issueManager, {
                issue: selectedIssue,
                nextState: "merged",
                reason: buildMergedPullRequestReason(mergedDefaultBranch),
                cycle,
                runResult,
              });
            }
            await addIssueLifecycleComment(
              selectedIssueManager,
              selectedIssue.number,
              buildMergeOutcomeComment(selectedIssue, mergedDefaultBranch),
            );
            if (executionContext.project.kind === "default") {
              console.log("Merged pull request detected. Running post-merge restart workflow.");
              let postMergeQuitReason =
                "Post-merge restart workflow completed. This runtime is quitting so the restarted runtime can take over.";
              try {
                await runPostMergeSelfRestart(WORK_DIR);
                if (isTrackerIssue(selectedIssue)) {
                  await transitionIssueLifecycleState(issueManager, {
                    issue: selectedIssue,
                    nextState: "restarted",
                    reason: "post-merge restart workflow completed successfully",
                    cycle,
                    runResult,
                  });
                }
                console.log("Post-merge restart workflow completed. Exiting current runtime.");
              } catch (error) {
                postMergeQuitReason =
                  "Post-merge restart workflow failed, and this runtime is still quitting after the merged pull request.";
                if (error instanceof Error) {
                  console.error(error.message);
                } else {
                  console.error("Post-merge restart failed with an unknown error.");
                }
              }

              await notifyRuntimeQuittingInDiscord(postMergeQuitReason);
              return;
            }

            console.log("Merged pull request detected for a managed project. Continuing without self-restart.");
          }

          runtimeStatusIssue = null;
          runtimeStatusActivitySummary = "Selecting the next issue.";

          if (
            await stopIfSingleTaskGracefulShutdownRequested(
              WORK_DIR,
              "Current task completed. Stopping before starting another issue.",
              discordHandlers,
            )
          ) {
            return;
          }

          break;
        } catch (error) {
          if (isTransientGitHubError(error) && retryAttempt < RUN_LOOP_GITHUB_MAX_RETRIES) {
            retryAttempt += 1;
            const delayMs = getRunLoopRetryDelayMs(retryAttempt);
            const message = error instanceof Error ? error.message : "unknown error";
            console.error(
              `Transient GitHub issue sync failure on cycle ${cycle} (attempt ${retryAttempt}/${RUN_LOOP_GITHUB_MAX_RETRIES}). Retrying in ${delayMs}ms. Error: ${message}`,
            );
            await waitForRunLoopRetry(delayMs);
            continue;
          }

          logGitHubFallback(error);
          if (cycle === 1) {
            console.log(DEFAULT_PROMPT);
          }
          return;
        }
      }
    }
  } finally {
    await gracefulShutdownListener?.stop();
  }
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  main().catch((error) => {
    console.error("Error in main execution:", error);
  }).finally(() => {
    console.log("Execution finished.");
  });
}
