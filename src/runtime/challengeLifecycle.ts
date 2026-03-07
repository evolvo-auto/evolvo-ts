import type { CodingAgentRunResult } from "../agents/runCodingAgent.js";
import { WORK_DIR } from "../constants/workDir.js";
import {
  buildChallengeFailureLearningComment,
  CHALLENGE_LEARNING_GENERATED_LABEL,
  classifyChallengeFailure,
  createCorrectiveIssuesForChallengeFailure,
} from "../challenges/challengeFailureLearning.js";
import {
  formatChallengeMetricsReport,
  readChallengeMetrics,
  recordChallengeAttemptMetrics,
  writeChallengeMetrics,
} from "../challenges/challengeMetrics.js";
import {
  CHALLENGE_BLOCKED_LABEL,
  CHALLENGE_FAILED_LABEL,
  CHALLENGE_READY_TO_RETRY_LABEL,
  evaluateChallengeRetryEligibility,
  recordChallengeAttemptOutcome,
  type ChallengeRetryDecision,
} from "../challenges/retryGate.js";
import { hasIssueLabel, isChallengeIssue } from "../issues/challengeIssue.js";
import type { IssueSummary, TaskIssueManager } from "../issues/taskIssueManager.js";
import { addIssueLifecycleComment } from "./issueLifecyclePresentation.js";
import { describeRepositoryDefaultBranch } from "./defaultBranch.js";

const CHALLENGE_MAX_ATTEMPTS = 3;
const CHALLENGE_RETRY_COOLDOWN_MS = 60 * 60 * 1000;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

async function recordChallengeAttemptState(options: {
  issueNumber: number;
  success: boolean;
  failureCategory?: string;
}): Promise<{
  metrics: Awaited<ReturnType<typeof recordChallengeAttemptMetrics>>;
  retryState: Awaited<ReturnType<typeof recordChallengeAttemptOutcome>>;
}> {
  const previousMetrics = await readChallengeMetrics(WORK_DIR);
  const metrics = await recordChallengeAttemptMetrics(WORK_DIR, {
    challengeIssueNumber: options.issueNumber,
    success: options.success,
    failureCategory: options.failureCategory,
  });

  try {
    const retryState = await recordChallengeAttemptOutcome(WORK_DIR, {
      challengeIssueNumber: options.issueNumber,
      success: options.success,
    });
    return { metrics, retryState };
  } catch (error) {
    try {
      await writeChallengeMetrics(WORK_DIR, previousMetrics);
    } catch (rollbackError) {
      throw new Error(
        `Challenge retry state update failed after metrics persisted: ${describeError(error)}. Metrics rollback failed: ${describeError(rollbackError)}`,
      );
    }

    throw error;
  }
}

export async function updateChallengeMetrics(
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
    const { metrics, retryState } = await recordChallengeAttemptState({
      issueNumber: issue.number,
      success,
      failureCategory,
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

export function buildChallengeRetryGateComment(issue: IssueSummary, decision: ChallengeRetryDecision): string {
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

function buildChallengeCompletionSummary(
  issue: IssueSummary,
  result: CodingAgentRunResult,
  defaultBranch: string | null = null,
): string {
  const reviewOutcome = result.summary.reviewOutcome;
  const validationStatus = result.summary.failedValidationCommands.length === 0 ? "all passed" : "had failures";
  const mergeStatus = result.mergedPullRequest
    ? `merged into ${describeRepositoryDefaultBranch(defaultBranch)}`
    : "not merged in this run";
  return [
    "## Challenge Completion",
    `- Challenge issue #${issue.number} succeeded.`,
    `- Acceptance criteria status: met (review outcome: \`${reviewOutcome}\`, validation: ${validationStatus}).`,
    `- Pull request status: ${mergeStatus}.`,
    "- Lifecycle state: terminal success (`completed`).",
    "- Further attempts are blocked unless this challenge is explicitly reopened or re-issued.",
  ].join("\n");
}

export async function finalizeChallengeSuccess(
  issueManager: TaskIssueManager,
  issue: IssueSummary,
  runResult: CodingAgentRunResult,
  defaultBranch: string | null = null,
): Promise<boolean> {
  if (!isChallengeIssue(issue) || runResult.summary.reviewOutcome !== "accepted") {
    return false;
  }

  const completionResult = await issueManager.markCompleted(
    issue.number,
    buildChallengeCompletionSummary(issue, runResult, defaultBranch),
  );
  const alreadyTerminal =
    /already marked as completed/i.test(completionResult.message) ||
    /is closed and cannot be completed/i.test(completionResult.message);
  if (!completionResult.ok && !alreadyTerminal) {
    console.error(`Could not finalize challenge issue #${issue.number}: ${completionResult.message}`);
    return false;
  }

  return completionResult.ok || alreadyTerminal;
}

export async function applyChallengeRetryGate(options: {
  issueManager: TaskIssueManager;
  openIssues: IssueSummary[];
  issues: IssueSummary[];
  cycle: number;
  onBlockedTransition: (issue: IssueSummary, cycle: number, reason: string) => Promise<void>;
}): Promise<IssueSummary[]> {
  const eligible: IssueSummary[] = [];

  for (const issue of options.issues) {
    if (!isChallengeIssue(issue)) {
      eligible.push(issue);
      continue;
    }

    if (hasIssueLabel(issue, "completed")) {
      eligible.push(issue);
      continue;
    }

    const decision = await evaluateChallengeRetryEligibility(WORK_DIR, issue, options.openIssues, {
      maxAttempts: CHALLENGE_MAX_ATTEMPTS,
      cooldownMs: CHALLENGE_RETRY_COOLDOWN_MS,
    });
    console.log(formatRetryDecisionLog(issue, decision));

    let nextIssue = issue;
    if (decision.addLabels.length > 0 || decision.removeLabels.length > 0) {
      const labelUpdate = await options.issueManager.updateLabels(issue.number, {
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
      await options.onBlockedTransition(issue, options.cycle, decision.reason);
    }

    await addIssueLifecycleComment(options.issueManager, issue.number, buildChallengeRetryGateComment(issue, decision));
  }

  return eligible;
}
