
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { WORK_DIR } from "./constants/workDir.js";
import { runCodingAgent } from "./agents/runCodingAgent.js";
import { runPostMergeSelfRestart } from "./runtime/selfRestart.js";
import { runIssueCommand } from "./issues/runIssueCommand.js";
import { getGitHubConfig } from "./github/githubConfig.js";
import { GitHubApiError, GitHubClient } from "./github/githubClient.js";
import { TaskIssueManager, type IssueSummary } from "./issues/taskIssueManager.js";
import {
  hasIssueLabel,
  isChallengeInProgressIssue,
  isChallengeIssue,
  isChallengeRetryReadyIssue,
} from "./issues/challengeIssue.js";
import { generateStartupIssueTemplates } from "./issues/startupIssueBootstrap.js";
import {
  formatChallengeMetricsReport,
  recordChallengeAttemptMetrics,
} from "./challenges/challengeMetrics.js";
import {
  CHALLENGE_BLOCKED_LABEL,
  CHALLENGE_FAILED_LABEL,
  CHALLENGE_READY_TO_RETRY_LABEL,
  evaluateChallengeRetryEligibility,
  recordChallengeAttemptOutcome,
  type ChallengeRetryDecision,
} from "./challenges/retryGate.js";
import {
  buildChallengeFailureLearningComment,
  CHALLENGE_LEARNING_GENERATED_LABEL,
  classifyChallengeFailure,
  createCorrectiveIssuesForChallengeFailure,
} from "./challenges/challengeFailureLearning.js";
import { persistChallengeAttemptArtifact } from "./challenges/challengeAttemptArtifacts.js";
import type { CodingAgentRunResult, CommandExecutionSummary } from "./agents/runCodingAgent.js";

export const DEFAULT_PROMPT = "No open issues available. Create an issue first.";
const MAX_ISSUE_CYCLES = 100;
const OUTDATED_LABELS = new Set(["outdated", "obsolete", "wontfix", "invalid", "duplicate"]);
const MIN_REPLENISH_ISSUES = 3;
const MAX_OPEN_ISSUES = 5;
const CHALLENGE_MAX_ATTEMPTS = 3;
const CHALLENGE_RETRY_COOLDOWN_MS = 60 * 60 * 1000;
const RUN_LOOP_GITHUB_MAX_RETRIES = 2;
const RUN_LOOP_GITHUB_RETRY_BASE_DELAY_MS = 50;
const RUN_LOOP_TRANSIENT_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

function selectIssueForWork(issues: IssueSummary[]): IssueSummary | null {
  const notCompleted = issues.filter((issue) => !hasIssueLabel(issue, "completed"));
  if (notCompleted.length === 0) {
    return null;
  }

  const challengeCandidates = notCompleted.filter((issue) => isChallengeIssue(issue));
  if (challengeCandidates.length > 0) {
    const inProgressChallenge = challengeCandidates.find((issue) => isChallengeInProgressIssue(issue));
    if (inProgressChallenge) {
      return inProgressChallenge;
    }

    const retryReadyChallenge = challengeCandidates.find((issue) => isChallengeRetryReadyIssue(issue));
    if (retryReadyChallenge) {
      return retryReadyChallenge;
    }

    return challengeCandidates[0] ?? null;
  }

  const inProgress = notCompleted.find((issue) => hasIssueLabel(issue, "in progress"));
  return inProgress ?? notCompleted[0] ?? null;
}

function isOutdatedIssue(issue: IssueSummary): boolean {
  return issue.labels.some((label) => OUTDATED_LABELS.has(label.toLowerCase()));
}

function buildPromptFromIssue(issue: IssueSummary): string {
  const description = issue.description.trim() || "No description provided.";
  return `Issue #${issue.number}: ${issue.title}\n\n${description}`;
}

function formatIssueForLog(issue: IssueSummary): string {
  return `#${issue.number} ${issue.title}`;
}

function logCycleQueueHealth(options: {
  cycle: number;
  openCount: number;
  selectedIssue: IssueSummary | null;
  queueActionOutcome?: string;
}): void {
  const selectedIssueLog = options.selectedIssue ? `#${options.selectedIssue.number}` : "none";
  const queueActionSuffix = options.queueActionOutcome ? ` queueAction=${options.queueActionOutcome}` : "";
  console.log(
    `Cycle ${options.cycle} queue health: open=${options.openCount} selected=${selectedIssueLog}${queueActionSuffix}`,
  );
}

async function updateChallengeMetrics(
  issueManager: TaskIssueManager,
  issue: IssueSummary,
  runError: unknown,
  runResult: CodingAgentRunResult | null,
): Promise<void> {
  if (!isChallengeIssue(issue)) {
    return;
  }

  const success = runError === null && runResult !== null && runResult.summary.reviewOutcome === "accepted";
  const failureCategory = success ? undefined : classifyChallengeFailure(runError, runResult);

  try {
    const metrics = await recordChallengeAttemptMetrics(WORK_DIR, {
      challengeIssueNumber: issue.number,
      success,
      failureCategory,
    });

    const retryState = await recordChallengeAttemptOutcome(WORK_DIR, {
      challengeIssueNumber: issue.number,
      success,
    });
    const failureAttempts = retryState.failuresByChallenge[String(issue.number)]?.attempts ?? 0;
    const labelUpdate = success
      ? await issueManager.updateLabels(issue.number, {
          remove: [
            CHALLENGE_FAILED_LABEL,
            CHALLENGE_READY_TO_RETRY_LABEL,
            CHALLENGE_BLOCKED_LABEL,
            CHALLENGE_LEARNING_GENERATED_LABEL,
          ],
        })
      : await issueManager.updateLabels(issue.number, {
          add: failureAttempts >= CHALLENGE_MAX_ATTEMPTS
            ? [CHALLENGE_FAILED_LABEL, CHALLENGE_BLOCKED_LABEL]
            : [CHALLENGE_FAILED_LABEL],
          remove: failureAttempts >= CHALLENGE_MAX_ATTEMPTS
            ? [CHALLENGE_READY_TO_RETRY_LABEL]
            : [CHALLENGE_READY_TO_RETRY_LABEL, CHALLENGE_BLOCKED_LABEL],
        });
    if (!labelUpdate.ok) {
      console.error(`Could not update challenge retry labels for issue #${issue.number}: ${labelUpdate.message}`);
    }

    if (!success && failureCategory) {
      const correctiveIssues = await createCorrectiveIssuesForChallengeFailure(
        issueManager,
        issue.number,
        failureCategory,
      );
      const learningComment = buildChallengeFailureLearningComment({
        challengeIssueNumber: issue.number,
        category: failureCategory,
        correctiveIssues,
      });
      const commentResult = await issueManager.addProgressComment(issue.number, learningComment);
      if (!commentResult.ok) {
        console.error(`Could not add challenge learning comment for issue #${issue.number}: ${commentResult.message}`);
      }

      if (correctiveIssues.length > 0) {
        const learningLabelUpdate = await issueManager.updateLabels(issue.number, {
          add: [CHALLENGE_LEARNING_GENERATED_LABEL],
        });
        if (!learningLabelUpdate.ok) {
          console.error(`Could not set learning label for issue #${issue.number}: ${learningLabelUpdate.message}`);
        }
      }
    }

    console.log(formatChallengeMetricsReport(metrics));
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Could not update challenge metrics for issue #${issue.number}: ${error.message}`);
      return;
    }

    console.error(`Could not update challenge metrics for issue #${issue.number}: unknown error.`);
  }
}

function formatRetryDecisionLog(issue: IssueSummary, decision: ChallengeRetryDecision): string {
  const corrective = decision.openCorrectiveIssueNumbers.length > 0
    ? ` correctiveOpen=${decision.openCorrectiveIssueNumbers.join(",")}`
    : "";
  const cooldownSuffix = decision.cooldownRemainingMs > 0
    ? ` cooldownRemainingMs=${decision.cooldownRemainingMs}`
    : "";
  return `Challenge retry decision for issue #${issue.number}: eligible=${decision.eligible} reason=${decision.reason} attempts=${decision.attemptCount}/${CHALLENGE_MAX_ATTEMPTS}${cooldownSuffix}${corrective}`;
}

function buildChallengeRetryGateComment(issue: IssueSummary, decision: ChallengeRetryDecision): string {
  const details = [
    `- Decision: \`${decision.reason}\``,
    `- Eligible to run this cycle: ${decision.eligible ? "yes" : "no"}`,
    `- Attempts recorded: ${decision.attemptCount}/${CHALLENGE_MAX_ATTEMPTS}`,
  ];

  if (decision.cooldownRemainingMs > 0) {
    details.push(`- Cooldown remaining: ${decision.cooldownRemainingMs}ms`);
  }

  if (decision.openCorrectiveIssueNumbers.length > 0) {
    details.push(`- Open corrective issues: ${decision.openCorrectiveIssueNumbers.map((number) => `#${number}`).join(", ")}`);
  }

  return [
    "## Challenge Retry Gate",
    `- Issue #${issue.number} was evaluated by retry gating.`,
    ...details,
  ].join("\n");
}

async function applyChallengeRetryGate(
  issueManager: TaskIssueManager,
  openIssues: IssueSummary[],
  issues: IssueSummary[],
): Promise<IssueSummary[]> {
  const eligible: IssueSummary[] = [];

  for (const issue of issues) {
    if (!isChallengeIssue(issue)) {
      eligible.push(issue);
      continue;
    }

    const decision = await evaluateChallengeRetryEligibility(WORK_DIR, issue, openIssues, {
      maxAttempts: CHALLENGE_MAX_ATTEMPTS,
      cooldownMs: CHALLENGE_RETRY_COOLDOWN_MS,
    });
    console.log(formatRetryDecisionLog(issue, decision));

    let nextIssue = issue;
    if (decision.addLabels.length > 0 || decision.removeLabels.length > 0) {
      const labelUpdate = await issueManager.updateLabels(issue.number, {
        add: decision.addLabels,
        remove: decision.removeLabels,
      });

      if (!labelUpdate.ok) {
        console.error(`Could not sync retry labels for issue #${issue.number}: ${labelUpdate.message}`);
      } else if (labelUpdate.issue) {
        nextIssue = labelUpdate.issue;
      }
    }

    if (decision.eligible) {
      eligible.push(nextIssue);
      continue;
    }

    await addIssueLifecycleComment(issueManager, issue.number, buildChallengeRetryGateComment(issue, decision));
  }

  return eligible;
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) {
    return "unknown";
  }

  return `${Math.round(durationMs)}ms`;
}

function getCommandName(command: string): string {
  const [commandName] = command.trim().split(/\s+/, 1);
  return commandName || "unknown";
}

function formatValidationCommand(command: CommandExecutionSummary): string {
  const exitCode = command.exitCode === null ? "unknown" : String(command.exitCode);
  return `- \`${command.command}\` (name=${getCommandName(command.command)}, status=${exitCode}, elapsed=${formatDuration(command.durationMs)})`;
}

function summarizeRetryNotes(result: CodingAgentRunResult): string {
  if (result.summary.failedValidationCommands.length === 0) {
    return "- No amendment/retry cycle was detected.";
  }

  return `- Validation had ${result.summary.failedValidationCommands.length} failing command(s), indicating amendment/retry activity.`;
}

function formatFinalResponseExcerpt(response: string): string {
  const normalized = response.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "No final assistant summary captured.";
  }

  const maxLength = 280;
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function buildIssueStartComment(issue: IssueSummary): string {
  return [
    "## Task Start",
    `- Started work on issue #${issue.number}: ${issue.title}.`,
    "- Initial assessment: inspect related files, apply a focused implementation, then validate and review.",
    "- Planned lifecycle logging: inspection, implementation decisions, validation steps/results, review outcome, PR/merge status, completion summary.",
  ].join("\n");
}

type ChallengeAttemptEvidence = {
  artifactPath: string;
  attempt: number;
  outcome: "success" | "failure";
  reviewOutcome: string | null;
  runtimeErrorMessage: string | null;
};

function buildChallengeEvidenceCommentLines(evidence: ChallengeAttemptEvidence | null): string[] {
  if (!evidence) {
    return [
      "",
      "### Challenge Attempt Artifact",
      "- Artifact path: (capture failed)",
      "- Attempt: unknown",
    ];
  }

  return [
    "",
    "### Challenge Attempt Artifact",
    `- Artifact path: \`${evidence.artifactPath}\``,
    `- Attempt: ${evidence.attempt}`,
    `- Outcome: ${evidence.outcome}`,
    `- Review outcome: ${evidence.reviewOutcome ?? "unknown"}`,
    `- Runtime error message: ${evidence.runtimeErrorMessage ?? "none"}`,
  ];
}

async function persistChallengeAttemptEvidence(
  issue: IssueSummary,
  runError: unknown,
  runResult: CodingAgentRunResult | null,
): Promise<ChallengeAttemptEvidence | null> {
  if (!isChallengeIssue(issue)) {
    return null;
  }

  try {
    const persisted = await persistChallengeAttemptArtifact(WORK_DIR, {
      challengeIssueNumber: issue.number,
      runResult,
      runError,
    });
    const reviewOutcome = persisted.artifact.executionSummary &&
      typeof persisted.artifact.executionSummary.reviewOutcome === "string"
      ? persisted.artifact.executionSummary.reviewOutcome
      : null;
    const outcome = persisted.artifact.outcome === "success" ? "success" : "failure";
    const attempt = Number.isFinite(persisted.artifact.attempt) ? Math.max(1, Math.floor(persisted.artifact.attempt)) : 1;
    return {
      artifactPath: persisted.relativePath,
      attempt,
      outcome,
      reviewOutcome,
      runtimeErrorMessage: persisted.artifact.runtimeError?.message ?? null,
    };
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Could not persist challenge attempt artifact for issue #${issue.number}: ${error.message}`);
      return null;
    }

    console.error(`Could not persist challenge attempt artifact for issue #${issue.number}: unknown error.`);
    return null;
  }
}

function buildIssueExecutionComment(
  issue: IssueSummary,
  result: CodingAgentRunResult,
  challengeEvidence: ChallengeAttemptEvidence | null,
): string {
  const inspectedAreas = result.summary.inspectedAreas.length > 0
    ? result.summary.inspectedAreas.map((area) => `- \`${area}\``)
    : ["- No explicit file/area inspection commands were captured."];
  const editedFiles = result.summary.editedFiles.length > 0
    ? result.summary.editedFiles.map((path) => `- \`${path}\``)
    : ["- No repository edits were captured in this run."];
  const validationLines = result.summary.validationCommands.length > 0
    ? result.summary.validationCommands.map(formatValidationCommand)
    : ["- No validation command was captured."];
  const prLines = [
    `- PR created: ${result.summary.pullRequestCreated ? "yes" : "no"}.`,
    `- PR merged into main: ${result.mergedPullRequest ? "yes" : "no"}.`,
  ];
  const externalRepositoryLines = result.summary.externalRepositories.length > 0
    ? result.summary.externalRepositories.map((url) => `- ${url}`)
    : ["- No external repository link captured."];
  const externalPullRequestLines = result.summary.externalPullRequests.length > 0
    ? result.summary.externalPullRequests.map((url) => `- ${url}`)
    : ["- No external pull request link captured."];
  const externalMergeLine = `- External pull request merged: ${result.summary.mergedExternalPullRequest ? "yes" : "no"}.`;
  const challengeEvidenceLines = isChallengeIssue(issue) ? buildChallengeEvidenceCommentLines(challengeEvidence) : [];

  return [
    "## Task Execution Log",
    "",
    "### Inspection",
    ...inspectedAreas,
    "",
    "### Implementation",
    ...editedFiles,
    "",
    "### Validation",
    ...validationLines,
    "",
    "### Review",
    `- Review outcome: ${result.summary.reviewOutcome}.`,
    summarizeRetryNotes(result),
    "",
    "### Pull Request",
    ...prLines,
    "",
    "### External Repository Evidence",
    "#### External Repository",
    ...externalRepositoryLines,
    "#### External Pull Request",
    ...externalPullRequestLines,
    externalMergeLine,
    ...challengeEvidenceLines,
    "",
    "### Completion Summary",
    `- Issue #${issue.number} execution cycle finished with outcome: ${result.summary.reviewOutcome}.`,
    `- Agent final summary: ${formatFinalResponseExcerpt(result.summary.finalResponse)}`,
  ].join("\n");
}

function buildIssueFailureComment(
  issue: IssueSummary,
  error: unknown,
  challengeEvidence: ChallengeAttemptEvidence | null,
): string {
  const message = error instanceof Error ? error.message : "Unknown runtime error.";
  const challengeEvidenceLines = isChallengeIssue(issue) ? buildChallengeEvidenceCommentLines(challengeEvidence) : [];
  return [
    "## Task Execution Problem",
    `- Issue #${issue.number} hit an execution error: ${message}`,
    "- Action: run interrupted; follow-up retry/amendment is required.",
    ...challengeEvidenceLines,
  ].join("\n");
}

function buildMergeOutcomeComment(issue: IssueSummary): string {
  return [
    "## Merge Outcome",
    `- Pull request for issue #${issue.number} was merged into main.`,
    "- Runtime will exit so the host can perform post-merge restart orchestration.",
  ].join("\n");
}

async function addIssueLifecycleComment(
  issueManager: TaskIssueManager,
  issueNumber: number,
  comment: string,
): Promise<void> {
  try {
    const result = await issueManager.addProgressComment(issueNumber, comment);
    if (!result.ok) {
      console.error(`Could not add lifecycle comment to issue #${issueNumber}: ${result.message}`);
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Could not add lifecycle comment to issue #${issueNumber}: ${error.message}`);
      return;
    }

    console.error(`Could not add lifecycle comment to issue #${issueNumber}: unknown error.`);
  }
}

function logCreatedIssues(issues: IssueSummary[]): void {
  const issueList = issues.map((issue) => formatIssueForLog(issue)).join(", ");
  console.log(`Created ${issues.length} self-improvement issue(s): ${issueList}.`);
}

async function bootstrapStartupIssues(issueManager: TaskIssueManager): Promise<IssueSummary[]> {
  try {
    const templates = await generateStartupIssueTemplates(WORK_DIR, { targetCount: MIN_REPLENISH_ISSUES });
    const replenishment = await issueManager.replenishSelfImprovementIssues({
      minimumIssueCount: MIN_REPLENISH_ISSUES,
      maximumOpenIssues: MAX_OPEN_ISSUES,
      templates,
    });

    return replenishment.created;
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Startup repository analysis failed: ${error.message}`);
    } else {
      console.error("Startup repository analysis failed with an unknown error.");
    }

    const replenishment = await issueManager.replenishSelfImprovementIssues({
      minimumIssueCount: MIN_REPLENISH_ISSUES,
      maximumOpenIssues: MAX_OPEN_ISSUES,
    });

    return replenishment.created;
  }
}

function logGitHubFallback(error: unknown): void {
  if (error instanceof GitHubApiError && error.status === 401) {
    console.error(
      "GitHub authentication failed. Check GITHUB_TOKEN and make sure it is a valid token for the configured repository.",
    );
    return;
  }

  if (error instanceof Error) {
    console.error(`GitHub issue sync unavailable: ${error.message}`);
    return;
  }

  console.error("GitHub issue sync unavailable due to an unknown error.");
}

function isTransientGitHubError(error: unknown): boolean {
  if (error instanceof GitHubApiError) {
    return RUN_LOOP_TRANSIENT_STATUS_CODES.has(error.status);
  }

  if (error instanceof Error) {
    if (error.message.startsWith("GitHub API request timed out")) {
      return true;
    }

    return error instanceof TypeError;
  }

  return false;
}

async function waitForRunLoopRetry(delayMs: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
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

  issueCycleLoop: for (let cycle = 1; cycle <= MAX_ISSUE_CYCLES; cycle += 1) {
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

        const retryEligibleIssues = await applyChallengeRetryGate(issueManager, actionableIssues, actionableIssues);
        const selectedIssue = selectIssueForWork(retryEligibleIssues);

        if (!selectedIssue) {
          const isStartupBootstrap = cycle === 1 && openIssues.length === 0;
          const createdIssues = isStartupBootstrap
            ? await bootstrapStartupIssues(issueManager)
            : (
                await issueManager.replenishSelfImprovementIssues({
                  minimumIssueCount: MIN_REPLENISH_ISSUES,
                  maximumOpenIssues: MAX_OPEN_ISSUES,
                })
              ).created;
          const queueActionOutcome = `${isStartupBootstrap ? "bootstrap" : "replenish"}:${createdIssues.length}`;
          logCycleQueueHealth({
            cycle,
            openCount: openIssues.length,
            selectedIssue: null,
            queueActionOutcome,
          });

          if (createdIssues.length > 0) {
            if (isStartupBootstrap) {
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

        if (!hasIssueLabel(selectedIssue, "in progress")) {
          const result = await issueManager.markInProgress(selectedIssue.number);
          if (!result.ok) {
            console.error(`Could not mark issue #${selectedIssue.number} as in progress: ${result.message}`);
          }
        }

        await addIssueLifecycleComment(issueManager, selectedIssue.number, buildIssueStartComment(selectedIssue));

        const prompt = buildPromptFromIssue(selectedIssue);
        console.log(`Prompt: ${prompt}`);

        let runError: unknown = null;
        const runResult = await runCodingAgent(prompt).catch((error) => {
          runError = error;
          console.error("Error running the coding agent:", error);
          return null;
        });

        if (runError) {
          const challengeEvidence = await persistChallengeAttemptEvidence(selectedIssue, runError, runResult);
          await updateChallengeMetrics(issueManager, selectedIssue, runError, runResult);
          await addIssueLifecycleComment(
            issueManager,
            selectedIssue.number,
            buildIssueFailureComment(selectedIssue, runError, challengeEvidence),
          );
          continue issueCycleLoop;
        }

        if (runResult) {
          const challengeEvidence = await persistChallengeAttemptEvidence(selectedIssue, runError, runResult);
          await updateChallengeMetrics(issueManager, selectedIssue, runError, runResult);
          await addIssueLifecycleComment(
            issueManager,
            selectedIssue.number,
            buildIssueExecutionComment(selectedIssue, runResult, challengeEvidence),
          );
        }

        if (runResult?.mergedPullRequest) {
          await addIssueLifecycleComment(issueManager, selectedIssue.number, buildMergeOutcomeComment(selectedIssue));
          console.log("Merged pull request detected. Running post-merge restart workflow.");
          try {
            await runPostMergeSelfRestart(WORK_DIR);
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
          const delayMs = RUN_LOOP_GITHUB_RETRY_BASE_DELAY_MS * retryAttempt;
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

  console.error(`Reached the maximum number of issue cycles (${MAX_ISSUE_CYCLES}).`);
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
