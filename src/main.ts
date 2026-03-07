import "dotenv/config";
import { pathToFileURL } from "node:url";
import type { CodingAgentRunResult } from "./agents/runCodingAgent.js";
import { runCodingAgent } from "./agents/runCodingAgent.js";
import { runPlannerAgent } from "./agents/plannerAgent.js";
import { WORK_DIR } from "./constants/workDir.js";
import { GitHubClient } from "./github/githubClient.js";
import { getGitHubConfig } from "./github/githubConfig.js";
import {
  buildLifecycleStateComment,
  transitionCanonicalLifecycleState,
  type CanonicalLifecycleState,
} from "./runtime/lifecycleState.js";
import { writeRuntimeReadinessSignal } from "./runtime/runtimeReadiness.js";
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
  selectIssueForWork,
  waitForRunLoopRetry,
} from "./runtime/loopUtils.js";
import { requestCycleLimitDecisionFromOperator } from "./runtime/operatorControl.js";
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
import { TaskIssueManager, type IssueSummary } from "./issues/taskIssueManager.js";

const MAX_ISSUE_CYCLES = 1;
const MIN_REPLENISH_ISSUES = 3;
const MAX_OPEN_ISSUES = 5;
const RUN_LOOP_GITHUB_MAX_RETRIES = 2;
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

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const issueCommandHandled = await runIssueCommand(args);
  if (issueCommandHandled) {
    return;
  }

  const { GITHUB_OWNER, GITHUB_REPO } = await import("./environment.js");
  const issueManager = new TaskIssueManager(new GitHubClient(getGitHubConfig()));

  console.log(`Hello from ${GITHUB_OWNER}/${GITHUB_REPO}!`);
  console.log(`Working directory: ${WORK_DIR}`);
  await signalRestartReadinessIfRequested(WORK_DIR);

  let cycleLimit = MAX_ISSUE_CYCLES;
  issueCycleLoop: for (let cycle = 1; ; cycle += 1) {
    if (cycle > cycleLimit) {
      const operatorDecision = await requestCycleLimitDecisionFromOperator(cycleLimit);
      if (operatorDecision?.decision === "continue" && operatorDecision.additionalCycles > 0) {
        cycleLimit += operatorDecision.additionalCycles;
        console.log(
          `Operator decision via Discord: continue (+${operatorDecision.additionalCycles} cycles). New limit=${cycleLimit}.`,
        );
        continue;
      }
      if (operatorDecision?.decision === "quit") {
        console.error("Operator decision via Discord: quit.");
      }
      console.error(`Reached the maximum number of issue cycles (${cycleLimit}).`);
      return;
    }

    let retryAttempt = 0;
    while (true) {
      try {
        const openIssues = await issueManager.listOpenIssues();
        const actionableIssues: IssueSummary[] = [];

        for (const issue of openIssues) {
          if (!isOutdatedIssue(issue)) {
            actionableIssues.push(issue);
            continue;
          }

          const result = await issueManager.closeIssue(issue.number);
          if (result.ok) {
            console.log(`Closed outdated issue ${formatIssueForLog(issue)}.`);
          } else {
            console.error(`Could not close outdated issue #${issue.number}: ${result.message}`);
          }
        }

        const retryEligibleIssues = await applyChallengeRetryGate({
          issueManager,
          openIssues: actionableIssues,
          issues: actionableIssues,
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
        const selectedIssue = selectIssueForWork(retryEligibleIssues);

        if (!selectedIssue) {
          const plannerResult = await runPlannerAgent({
            cycle,
            openIssueCount: openIssues.length,
            minimumIssueCount: MIN_REPLENISH_ISSUES,
            maximumOpenIssues: MAX_OPEN_ISSUES,
            issueManager,
            workDir: WORK_DIR,
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
            if (plannerResult.startupBootstrap) {
              console.log("No open issues found on startup. Bootstrapped issue queue from repository analysis.");
            }
            logCreatedIssues(createdIssues);
            continue issueCycleLoop;
          }

          if (cycle === 1) {
            console.log(DEFAULT_PROMPT);
          } else {
            console.log("No actionable open issues remaining and no new issues were created. Issue loop stopped.");
          }
          return;
        }

        logCycleQueueHealth({
          cycle,
          openCount: openIssues.length,
          selectedIssue,
        });
        await transitionIssueLifecycleState(issueManager, {
          issue: selectedIssue,
          nextState: "selected",
          reason: "issue selected for active execution in this cycle",
          cycle,
        });

        let startedThisCycle = false;
        if (!hasIssueLabel(selectedIssue, "in progress")) {
          const result = await issueManager.markInProgress(selectedIssue.number);
          if (!result.ok) {
            console.error(`Could not mark issue #${selectedIssue.number} as in progress: ${result.message}`);
          } else {
            startedThisCycle = true;
          }
        }

        if (startedThisCycle) {
          await addIssueLifecycleComment(issueManager, selectedIssue.number, buildIssueStartComment(selectedIssue));
        }

        const prompt = buildPromptFromIssue(selectedIssue);
        console.log(`Prompt: ${prompt}`);
        await transitionIssueLifecycleState(issueManager, {
          issue: selectedIssue,
          nextState: "executing",
          reason: "coding agent execution started",
          cycle,
        });

        let runError: unknown = null;
        const runResult = await runCodingAgent(prompt).catch((error) => {
          runError = error;
          console.error("Error running the coding agent:", error);
          return null;
        });

        if (runError) {
          await transitionIssueLifecycleState(issueManager, {
            issue: selectedIssue,
            nextState: "failed",
            reason: "runtime error during coding agent execution",
            cycle,
          });
          const challengeEvidence = await persistChallengeAttemptEvidence(WORK_DIR, selectedIssue, runError, runResult);
          await updateChallengeMetrics(issueManager, selectedIssue, runError, runResult);
          await addIssueLifecycleComment(
            issueManager,
            selectedIssue.number,
            buildIssueFailureComment(selectedIssue, runError, challengeEvidence),
          );
          continue issueCycleLoop;
        }

        if (runResult) {
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
          const challengeEvidence = await persistChallengeAttemptEvidence(WORK_DIR, selectedIssue, runError, runResult);
          await updateChallengeMetrics(issueManager, selectedIssue, runError, runResult);
          await addIssueLifecycleComment(
            issueManager,
            selectedIssue.number,
            buildIssueExecutionComment(selectedIssue, runResult, challengeEvidence),
          );
          const challengeCompleted = await finalizeChallengeSuccess(issueManager, selectedIssue, runResult);
          if (challengeCompleted) {
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
          await transitionIssueLifecycleState(issueManager, {
            issue: selectedIssue,
            nextState: "merged",
            reason: "pull request merged into main",
            cycle,
            runResult,
          });
          await addIssueLifecycleComment(issueManager, selectedIssue.number, buildMergeOutcomeComment(selectedIssue));
          console.log("Merged pull request detected. Running post-merge restart workflow.");
          try {
            await runPostMergeSelfRestart(WORK_DIR);
            await transitionIssueLifecycleState(issueManager, {
              issue: selectedIssue,
              nextState: "restarted",
              reason: "post-merge restart workflow completed successfully",
              cycle,
              runResult,
            });
            console.log("Post-merge restart workflow completed. Exiting current runtime.");
          } catch (error) {
            if (error instanceof Error) {
              console.error(error.message);
            } else {
              console.error("Post-merge restart failed with an unknown error.");
            }
          }

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
