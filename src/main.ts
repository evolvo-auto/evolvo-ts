
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
import {
  buildLifecycleStateComment,
  transitionCanonicalLifecycleState,
  type CanonicalLifecycleState,
  type LifecycleDerivedState,
  type LifecycleEntityKind,
} from "./runtime/lifecycleState.js";
import { writeRuntimeReadinessSignal } from "./runtime/runtimeReadiness.js";

export const DEFAULT_PROMPT = "No open issues available. Create an issue first.";
const MAX_ISSUE_CYCLES = 100;
const OUTDATED_LABELS = new Set(["outdated", "obsolete", "wontfix", "invalid", "duplicate"]);
const MIN_REPLENISH_ISSUES = 3;
const MAX_OPEN_ISSUES = 5;
const CHALLENGE_MAX_ATTEMPTS = 3;
const CHALLENGE_RETRY_COOLDOWN_MS = 60 * 60 * 1000;
const RUN_LOOP_GITHUB_MAX_RETRIES = 2;
const RUN_LOOP_GITHUB_RETRY_BASE_DELAY_MS = 50;
const RUN_LOOP_GITHUB_RETRY_MAX_DELAY_MS = 1_000;
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
  queueAction?: {
    type: "bootstrap" | "replenish";
    createdCount: number;
    outcome: "continue" | "stop";
  };
}): void {
  const selectedIssueLog = options.selectedIssue ? `#${options.selectedIssue.number}` : "none";
  const queueActionSuffix = options.queueAction
    ? ` queueAction=${options.queueAction.type} created=${options.queueAction.createdCount} outcome=${options.queueAction.outcome}`
    : "";
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

function buildChallengeCompletionSummary(issue: IssueSummary, result: CodingAgentRunResult): string {
  const reviewOutcome = result.summary.reviewOutcome;
  const validationStatus = result.summary.failedValidationCommands.length === 0 ? "all passed" : "had failures";
  const mergeStatus = result.mergedPullRequest ? "merged into main" : "not merged in this run";
  return [
    "## Challenge Completion",
    `- Challenge issue #${issue.number} succeeded.`,
    `- Acceptance criteria status: met (review outcome: \`${reviewOutcome}\`, validation: ${validationStatus}).`,
    `- Pull request status: ${mergeStatus}.`,
    "- Lifecycle state: terminal success (`completed`).",
    "- Further attempts are blocked unless this challenge is explicitly reopened or re-issued.",
  ].join("\n");
}

async function finalizeChallengeSuccess(
  issueManager: TaskIssueManager,
  issue: IssueSummary,
  runResult: CodingAgentRunResult,
): Promise<void> {
  if (!isChallengeIssue(issue) || runResult.summary.reviewOutcome !== "accepted") {
    return;
  }

  const completionResult = await issueManager.markCompleted(issue.number, buildChallengeCompletionSummary(issue, runResult));
  const alreadyTerminal =
    /already marked as completed/i.test(completionResult.message) ||
    /is closed and cannot be completed/i.test(completionResult.message);
  if (!completionResult.ok && !alreadyTerminal) {
    console.error(`Could not finalize challenge issue #${issue.number}: ${completionResult.message}`);
  }
}

async function applyChallengeRetryGate(
  issueManager: TaskIssueManager,
  openIssues: IssueSummary[],
  issues: IssueSummary[],
  cycle: number,
): Promise<IssueSummary[]> {
  const eligible: IssueSummary[] = [];

  for (const issue of issues) {
    if (!isChallengeIssue(issue)) {
      eligible.push(issue);
      continue;
    }

    if (hasIssueLabel(issue, "completed")) {
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

    if (decision.reason === "max-attempts-reached") {
      await transitionIssueLifecycleState(issueManager, {
        issue,
        nextState: "blocked",
        reason: `retry gate decision: ${decision.reason}`,
        cycle,
      });
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
  const commandName = typeof command.commandName === "string" && command.commandName.trim().length > 0
    ? command.commandName
    : getCommandName(command.command);
  const exitCode = command.exitCode === null ? "unknown" : String(command.exitCode);
  return `- \`${command.command}\` (name=${commandName}, status=${exitCode}, elapsed=${formatDuration(command.durationMs)})`;
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

function getLifecycleEntityKind(issue: IssueSummary): LifecycleEntityKind {
  return isChallengeIssue(issue) ? "challenge" : "issue";
}

function buildLifecycleDerivedState(
  issue: IssueSummary,
  runResult: CodingAgentRunResult | null = null,
): LifecycleDerivedState {
  return {
    issueState: issue.state,
    labels: [...issue.labels],
    isChallenge: isChallengeIssue(issue),
    reviewOutcome: runResult?.summary.reviewOutcome ?? null,
    pullRequestCreated: runResult?.summary.pullRequestCreated ?? null,
    mergedPullRequest: runResult?.mergedPullRequest ?? null,
  };
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

type StartupBootstrapRecoveryContext = {
  context: "repository-derived bootstrap" | "fallback bootstrap";
  targetCount: number;
  templateCount: number | "default";
  createdCount: number;
};

function logStartupBootstrapRecoveryGuidance(context: StartupBootstrapRecoveryContext): void {
  console.error(`Startup ${context.context} created 0 issues. Issue queue remains empty.`);
  console.error(
    `Startup bootstrap diagnostics: context=${context.context} targetCount=${context.targetCount} templateCount=${context.templateCount} createdCount=${context.createdCount}.`,
  );
  console.error(
    "Recovery: verify GitHub token permissions and repository issue settings, then run `pnpm dev -- issues list` and create an issue manually if needed.",
  );
}

async function bootstrapStartupIssues(issueManager: TaskIssueManager): Promise<IssueSummary[]> {
  const targetCount = MIN_REPLENISH_ISSUES;
  try {
    const templates = await generateStartupIssueTemplates(WORK_DIR, { targetCount });
    const replenishment = await issueManager.replenishSelfImprovementIssues({
      minimumIssueCount: targetCount,
      maximumOpenIssues: MAX_OPEN_ISSUES,
      templates,
    });

    if (replenishment.created.length === 0) {
      console.error(
        `Startup bootstrap created 0 issues from ${templates.length} repository-derived template(s).`,
      );
      logStartupBootstrapRecoveryGuidance({
        context: "repository-derived bootstrap",
        targetCount,
        templateCount: templates.length,
        createdCount: replenishment.created.length,
      });
    }

    return replenishment.created;
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Startup repository analysis failed: ${error.message}`);
    } else {
      console.error("Startup repository analysis failed with an unknown error.");
    }

    console.error(`Startup issue bootstrap is falling back to default issue templates (targetCount=${targetCount}).`);

    try {
      const replenishment = await issueManager.replenishSelfImprovementIssues({
        minimumIssueCount: targetCount,
        maximumOpenIssues: MAX_OPEN_ISSUES,
      });

      if (replenishment.created.length === 0) {
        logStartupBootstrapRecoveryGuidance({
          context: "fallback bootstrap",
          targetCount,
          templateCount: "default",
          createdCount: replenishment.created.length,
        });
      }

      return replenishment.created;
    } catch (fallbackError) {
      if (fallbackError instanceof Error) {
        console.error(`Startup fallback issue creation failed: ${fallbackError.message}`);
      } else {
        console.error("Startup fallback issue creation failed with an unknown error.");
      }

      logStartupBootstrapRecoveryGuidance({
        context: "fallback bootstrap",
        targetCount,
        templateCount: "default",
        createdCount: 0,
      });
      return [];
    }
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
    if (isGitHubRateLimitError(error)) {
      return true;
    }

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

function isGitHubRateLimitError(error: GitHubApiError): boolean {
  if (error.status !== 403) {
    return false;
  }

  if (typeof error.responseBody === "object" && error.responseBody !== null && "message" in error.responseBody) {
    const message = (error.responseBody as { message?: unknown }).message;
    if (typeof message === "string" && /rate limit/i.test(message)) {
      return true;
    }
  }

  return /rate limit/i.test(error.message);
}

function getRunLoopRetryDelayMs(retryAttempt: number): number {
  const exponentialDelay = RUN_LOOP_GITHUB_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, retryAttempt - 1));
  return Math.min(exponentialDelay, RUN_LOOP_GITHUB_RETRY_MAX_DELAY_MS);
}

async function waitForRunLoopRetry(delayMs: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
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

        const retryEligibleIssues = await applyChallengeRetryGate(issueManager, actionableIssues, actionableIssues, cycle);
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
          logCycleQueueHealth({
            cycle,
            openCount: openIssues.length,
            selectedIssue: null,
            queueAction: {
              type: isStartupBootstrap ? "bootstrap" : "replenish",
              createdCount: createdIssues.length,
              outcome: createdIssues.length > 0 ? "continue" : "stop",
            },
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
          await transitionIssueLifecycleState(issueManager, {
            issue: selectedIssue,
            nextState: "under_review",
            reason: "coding agent execution completed and review result is being processed",
            cycle,
            runResult,
          });
          await transitionIssueLifecycleState(issueManager, {
            issue: selectedIssue,
            nextState: runResult.summary.reviewOutcome === "accepted" ? "accepted" : "rejected",
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
          const challengeEvidence = await persistChallengeAttemptEvidence(selectedIssue, runError, runResult);
          await updateChallengeMetrics(issueManager, selectedIssue, runError, runResult);
          await addIssueLifecycleComment(
            issueManager,
            selectedIssue.number,
            buildIssueExecutionComment(selectedIssue, runResult, challengeEvidence),
          );
          await finalizeChallengeSuccess(issueManager, selectedIssue, runResult);
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
