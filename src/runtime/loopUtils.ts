import { generateStartupIssueTemplates } from "../issues/startupIssueBootstrap.js";
import type { TaskIssueManager, IssueSummary } from "../issues/taskIssueManager.js";
import { GitHubApiError } from "../github/githubClient.js";
import {
  hasIssueLabel,
  isChallengeInProgressIssue,
  isChallengeIssue,
  isChallengeRetryReadyIssue,
} from "../issues/challengeIssue.js";

const OUTDATED_LABELS = new Set(["outdated", "obsolete", "wontfix", "invalid", "duplicate"]);
const MIN_REPLENISH_ISSUES = 3;
const MAX_OPEN_ISSUES = 5;
const RUN_LOOP_TRANSIENT_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const RUN_LOOP_GITHUB_RETRY_BASE_DELAY_MS = 50;
const RUN_LOOP_GITHUB_RETRY_MAX_DELAY_MS = 1_000;

export const DEFAULT_PROMPT = "No open issues available. Create an issue first.";

export function selectIssueForWork(issues: IssueSummary[]): IssueSummary | null {
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

export function isOutdatedIssue(issue: IssueSummary): boolean {
  return issue.labels.some((label) => OUTDATED_LABELS.has(label.toLowerCase()));
}

export function buildPromptFromIssue(issue: IssueSummary): string {
  const description = issue.description.trim() || "No description provided.";
  return `Issue #${issue.number}: ${issue.title}\n\n${description}`;
}

export function formatIssueForLog(issue: IssueSummary): string {
  return `#${issue.number} ${issue.title}`;
}

export function logCycleQueueHealth(options: {
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

function logStartupBootstrapRecoveryGuidance(context: {
  context: "repository-derived bootstrap" | "fallback bootstrap";
  targetCount: number;
  templateCount: number | "default";
  createdCount: number;
}): void {
  console.error(`Startup ${context.context} created 0 issues. Issue queue remains empty.`);
  console.error(
    `Startup bootstrap diagnostics: context=${context.context} targetCount=${context.targetCount} templateCount=${context.templateCount} createdCount=${context.createdCount}.`,
  );
  console.error(
    "Recovery: verify GitHub token permissions and repository issue settings, then run `pnpm dev -- issues list` and create an issue manually if needed.",
  );
}

export async function bootstrapStartupIssues(issueManager: TaskIssueManager, workDir: string): Promise<IssueSummary[]> {
  const targetCount = MIN_REPLENISH_ISSUES;
  try {
    const templates = await generateStartupIssueTemplates(workDir, { targetCount });
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

export function logCreatedIssues(issues: IssueSummary[]): void {
  const issueList = issues.map((issue) => formatIssueForLog(issue)).join(", ");
  console.log(`Created ${issues.length} self-improvement issue(s): ${issueList}.`);
}

export function logGitHubFallback(error: unknown): void {
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

export function isTransientGitHubError(error: unknown): boolean {
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

export function getRunLoopRetryDelayMs(retryAttempt: number): number {
  const exponentialDelay = RUN_LOOP_GITHUB_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, retryAttempt - 1));
  return Math.min(exponentialDelay, RUN_LOOP_GITHUB_RETRY_MAX_DELAY_MS);
}

export async function waitForRunLoopRetry(delayMs: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
