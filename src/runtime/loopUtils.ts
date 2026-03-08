import { generateStartupIssueTemplates } from "../issues/startupIssueBootstrap.js";
import { parseProjectProvisioningIssueMetadata } from "../issues/projectProvisioningIssue.js";
import type { TaskIssueManager, IssueSummary } from "../issues/taskIssueManager.js";
import { GitHubApiError } from "../github/githubClient.js";
import {
  hasIssueLabel,
  isChallengeInProgressIssue,
  isChallengeIssue,
  isChallengeRetryReadyIssue,
} from "../issues/challengeIssue.js";
import { PROJECT_LABEL_PREFIX } from "../projects/projectNaming.js";

const OUTDATED_LABELS = new Set(["outdated", "obsolete", "wontfix", "invalid", "duplicate"]);
const MIN_REPLENISH_ISSUES = 3;
const MAX_OPEN_ISSUES = 5;
const RUN_LOOP_TRANSIENT_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const RUN_LOOP_GITHUB_RETRY_BASE_DELAY_MS = 50;
const RUN_LOOP_GITHUB_RETRY_MAX_DELAY_MS = 1_000;

export const DEFAULT_PROMPT = "No open issues available. Create an issue first.";

function selectHighestPriorityIssue(issues: IssueSummary[]): IssueSummary | null {
  if (issues.length === 0) {
    return null;
  }

  const challengeCandidates = issues.filter((issue) => isChallengeIssue(issue));
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

  const inProgress = issues.find((issue) => hasIssueLabel(issue, "in progress"));
  return inProgress ?? issues[0] ?? null;
}

function issueTargetsProject(issue: IssueSummary, projectSlug: string): boolean {
  const normalizedSlug = projectSlug.trim().toLowerCase();
  if (!normalizedSlug) {
    return false;
  }

  const provisioningSlug = parseProjectProvisioningIssueMetadata(issue.description)?.slug?.trim().toLowerCase();
  if (provisioningSlug === normalizedSlug) {
    return true;
  }

  return issue.labels.some((label) => label.trim().toLowerCase() === `${PROJECT_LABEL_PREFIX}${normalizedSlug}`);
}

export function selectIssueForWork(
  issues: IssueSummary[],
  options: { activeProjectSlug?: string | null; stoppedProjectSlug?: string | null } = {},
): IssueSummary | null {
  const notCompleted = issues.filter((issue) => !hasIssueLabel(issue, "completed") && !hasIssueLabel(issue, "blocked"));
  if (notCompleted.length === 0) {
    return null;
  }

  const stoppedProjectSlug = options.stoppedProjectSlug?.trim() || null;
  const selectableIssues = stoppedProjectSlug
    ? notCompleted.filter((issue) => !issueTargetsProject(issue, stoppedProjectSlug))
    : notCompleted;
  if (selectableIssues.length === 0) {
    return null;
  }

  const activeProjectSlug = options.activeProjectSlug?.trim() || null;
  if (activeProjectSlug) {
    const activeProjectIssues = selectableIssues.filter((issue) => issueTargetsProject(issue, activeProjectSlug));
    const prioritized = selectHighestPriorityIssue(activeProjectIssues);
    if (prioritized) {
      return prioritized;
    }
  }

  return selectHighestPriorityIssue(selectableIssues);
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

function formatBootstrapError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return "unknown error";
}

function logStartupBootstrapRecoveryGuidance(options: {
  context: "repository-derived bootstrap";
  targetCount: number;
  templateCount: number;
  createdCount: number;
  workDir: string;
  repositoryAnalysisError?: unknown;
}): void {
  console.error(`Startup ${options.context} created 0 issues. Issue queue remains empty.`);
  console.error(
    `Startup bootstrap diagnostics: context=${options.context} targetCount=${options.targetCount} templateCount=${options.templateCount} createdCount=${options.createdCount}.`,
  );
  console.error(
    `Startup bootstrap environment: workDir=${options.workDir}.`,
  );
  if (options.repositoryAnalysisError) {
    console.error(`Startup bootstrap primary error: ${formatBootstrapError(options.repositoryAnalysisError)}.`);
  }
  console.error(
    "Startup bootstrap next actions: run `pnpm dev -- issues list`; if queue is still empty, run `pnpm dev -- issues create \"<title>\" \"<description>\"`.",
  );
  console.error(
    "Recovery: verify GitHub token permissions and repository issue settings, then run `pnpm dev -- issues list` and create an issue manually if needed.",
  );
}

export async function bootstrapStartupIssues(issueManager: TaskIssueManager, workDir: string): Promise<IssueSummary[]> {
  const targetCount = MIN_REPLENISH_ISSUES;
  try {
    const templates = await generateStartupIssueTemplates(workDir, { targetCount });
    if (templates.length === 0) {
      console.error("Startup repository analysis produced 0 issue candidates.");
      logStartupBootstrapRecoveryGuidance({
        context: "repository-derived bootstrap",
        targetCount,
        templateCount: 0,
        createdCount: 0,
        workDir,
      });
      return [];
    }

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
        workDir,
      });
    }

    return replenishment.created;
  } catch (error) {
    if (isTransientGitHubError(error)) {
      throw error;
    }

    if (error instanceof Error) {
      console.error(`Startup repository analysis failed: ${error.message}`);
    } else {
      console.error("Startup repository analysis failed with an unknown error.");
    }

    logStartupBootstrapRecoveryGuidance({
      context: "repository-derived bootstrap",
      targetCount,
      templateCount: 0,
      createdCount: 0,
      workDir,
      repositoryAnalysisError: error,
    });
    return [];
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
  const normalizedAttempt =
    Number.isFinite(retryAttempt) && retryAttempt > 0
      ? Math.floor(retryAttempt)
      : 1;
  const exponentialDelay = RUN_LOOP_GITHUB_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, normalizedAttempt - 1));
  return Math.min(exponentialDelay, RUN_LOOP_GITHUB_RETRY_MAX_DELAY_MS);
}

export async function waitForRunLoopRetry(delayMs: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
