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
const ISSUE_PRIORITY_TOPIC_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "into",
  "that",
  "this",
  "issue",
  "issues",
  "task",
  "tasks",
  "evolvo",
  "self",
  "improvement",
  "open",
  "work",
]);

type IssuePrioritySignal = {
  label: string;
  weight: number;
};

type RankedIssueCandidate = {
  issue: IssueSummary;
  score: number;
  signals: IssuePrioritySignal[];
  originalIndex: number;
};

export type IssueSelectionDecision = {
  selectedIssue: IssueSummary | null;
  candidateCount: number;
  rationale: string | null;
};

export const DEFAULT_PROMPT = "No open issues available. Create an issue first.";

function normalizeTopicToken(token: string): string | null {
  const normalized = token
    .toLowerCase()
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
  if (!normalized || normalized.length < 4 || /^\d+$/.test(normalized) || ISSUE_PRIORITY_TOPIC_STOP_WORDS.has(normalized)) {
    return null;
  }

  if (normalized.endsWith("ies") && normalized.length > 4) {
    return `${normalized.slice(0, -3)}y`;
  }

  if (normalized.endsWith("s") && normalized.length > 4) {
    return normalized.slice(0, -1);
  }

  return normalized;
}

function buildTopicTokenSet(issue: IssueSummary): Set<string> {
  const text = `${issue.title}\n${issue.description}`;
  const tokens = text
    .split(/\s+/)
    .map((token) => normalizeTopicToken(token))
    .filter((token): token is string => token !== null);
  return new Set(tokens);
}

function countTopicOverlap(left: Set<string>, right: Set<string>): number {
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) {
      overlap += 1;
    }
  }

  return overlap;
}

function hasPriorityKeyword(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function buildPrioritySignals(
  issue: IssueSummary,
  issues: IssueSummary[],
  topicTokensByIssueNumber: Map<number, Set<string>>,
): IssuePrioritySignal[] {
  const text = `${issue.title}\n${issue.description}`.toLowerCase();
  const signals: IssuePrioritySignal[] = [];

  if (
    hasPriorityKeyword(text, [
      /\b(unblock|unlock|prerequisite|foundational|foundation|infrastructure|depends? on|sequenc(?:e|ing)|come first)\b/,
      /\bshared infrastructure\b/,
    ])
  ) {
    signals.push({
      label: "dependency or unblock potential",
      weight: 140,
    });
  }

  if (
    hasPriorityKeyword(text, [
      /\brun(?: |-)?loop\b/,
      /\bqueue\b/,
      /\breplenish(?:ment)?\b/,
      /\bbootstrap\b/,
      /\brestart\b/,
      /\breadiness\b/,
      /\blifecycle\b/,
      /\bstate(?: transition)?\b/,
      /\bselection\b/,
      /\bprioriti[sz](?:e|ation)\b/,
      /\bretry\b/,
      /\bplanner\b/,
      /\breview\b/,
      /\bvalidation\b/,
      /\bgithub\b/,
      /\boperator\b/,
      /\bcontrol\b/,
    ])
  ) {
    signals.push({
      label: "core runtime/control surface",
      weight: 110,
    });
  }

  if (
    hasPriorityKeyword(text, [
      /\bfail(?:ure|ed|ing|s)?\b/,
      /\berror\b/,
      /\bflak(?:e|y|iness)\b/,
      /\btimeout\b/,
      /\bcrash\b/,
      /\bbug\b/,
      /\bregression\b/,
      /\bdiagnostic\b/,
      /\bincorrect\b/,
      /\bopaque\b/,
      /\brisk\b/,
    ])
  ) {
    signals.push({
      label: "reliability or failure evidence",
      weight: 90,
    });
  }

  if (
    hasPriorityKeyword(text, [
      /\bshared\b/,
      /\breusable\b/,
      /\bworkflow\b/,
      /\borchestrat(?:e|ion)\b/,
      /\bselector\b/,
      /\bplanning\b/,
      /\bquality\b/,
      /\brobust(?:ness)?\b/,
      /\bsequenc(?:e|ing)\b/,
    ])
  ) {
    signals.push({
      label: "system-wide leverage",
      weight: 70,
    });
  }

  const issueTopicTokens = topicTokensByIssueNumber.get(issue.number) ?? new Set<string>();
  const relatedIssueCount = issues.filter((candidate) => {
    if (candidate.number === issue.number) {
      return false;
    }

    const candidateTokens = topicTokensByIssueNumber.get(candidate.number) ?? new Set<string>();
    return countTopicOverlap(issueTopicTokens, candidateTokens) >= 2;
  }).length;
  if (relatedIssueCount > 0) {
    signals.push({
      label: `shared topic with ${relatedIssueCount} other open issue${relatedIssueCount === 1 ? "" : "s"}`,
      weight: Math.min(60, relatedIssueCount * 20),
    });
  }

  return signals;
}

function compareRankedIssueCandidates(left: RankedIssueCandidate, right: RankedIssueCandidate): number {
  if (right.score !== left.score) {
    return right.score - left.score;
  }

  if (right.signals.length !== left.signals.length) {
    return right.signals.length - left.signals.length;
  }

  if (left.issue.number !== right.issue.number) {
    return left.issue.number - right.issue.number;
  }

  return left.originalIndex - right.originalIndex;
}

function formatIssuePrioritySignalLabels(signals: IssuePrioritySignal[]): string {
  const sortedLabels = [...signals]
    .sort((left, right) => right.weight - left.weight)
    .map((signal) => signal.label);
  const uniqueLabels = [...new Set(sortedLabels)].slice(0, 3);

  if (uniqueLabels.length === 0) {
    return "stable tie-break after comparing equally actionable issues";
  }

  if (uniqueLabels.length === 1) {
    return uniqueLabels[0] ?? "stable tie-break after comparing equally actionable issues";
  }

  if (uniqueLabels.length === 2) {
    return `${uniqueLabels[0]} and ${uniqueLabels[1]}`;
  }

  return `${uniqueLabels[0]}, ${uniqueLabels[1]}, and ${uniqueLabels[2]}`;
}

function buildSelectionRationale(prefix: string | null, details: string | null): string | null {
  if (prefix && details) {
    return `${prefix}; ${details}`;
  }

  return prefix ?? details;
}

function rankIssueCandidates(issues: IssueSummary[]): IssueSelectionDecision {
  if (issues.length === 0) {
    return {
      selectedIssue: null,
      candidateCount: 0,
      rationale: null,
    };
  }

  if (issues.length === 1) {
    return {
      selectedIssue: issues[0] ?? null,
      candidateCount: 1,
      rationale: null,
    };
  }

  const topicTokensByIssueNumber = new Map<number, Set<string>>(
    issues.map((issue) => [issue.number, buildTopicTokenSet(issue)]),
  );
  const ranked = issues
    .map((issue, originalIndex) => {
      const signals = buildPrioritySignals(issue, issues, topicTokensByIssueNumber);
      const score = signals.reduce((total, signal) => total + signal.weight, 0);
      return {
        issue,
        score,
        signals,
        originalIndex,
      };
    })
    .sort(compareRankedIssueCandidates);
  const selected = ranked[0];

  return {
    selectedIssue: selected?.issue ?? null,
    candidateCount: issues.length,
    rationale: selected
      ? `selected for ${formatIssuePrioritySignalLabels(selected.signals)}`
      : null,
  };
}

function prioritizeIssueCandidates(issues: IssueSummary[]): IssueSelectionDecision {
  if (issues.length === 0) {
    return {
      selectedIssue: null,
      candidateCount: 0,
      rationale: null,
    };
  }

  const challengeCandidates = issues.filter((issue) => isChallengeIssue(issue));
  if (challengeCandidates.length > 0) {
    const inProgressChallenge = challengeCandidates.find((issue) => isChallengeInProgressIssue(issue));
    if (inProgressChallenge) {
      return {
        selectedIssue: inProgressChallenge,
        candidateCount: issues.length,
        rationale: issues.length > 1
          ? "resuming an in-progress challenge takes precedence over other open work"
          : null,
      };
    }

    const retryReadyChallenge = challengeCandidates.find((issue) => isChallengeRetryReadyIssue(issue));
    if (retryReadyChallenge) {
      return {
        selectedIssue: retryReadyChallenge,
        candidateCount: issues.length,
        rationale: issues.length > 1
          ? "retry-ready challenge work takes precedence over first-attempt work"
          : null,
      };
    }

    const challengeDecision = rankIssueCandidates(challengeCandidates);
    return {
      selectedIssue: challengeDecision.selectedIssue,
      candidateCount: issues.length,
      rationale: issues.length > 1
        ? buildSelectionRationale(
          "challenge work takes precedence over self-improvement issues",
          challengeDecision.rationale,
        )
        : null,
    };
  }

  const inProgress = issues.find((issue) => hasIssueLabel(issue, "in progress"));
  if (inProgress) {
    return {
      selectedIssue: inProgress,
      candidateCount: issues.length,
      rationale: issues.length > 1
        ? "resuming an in-progress issue takes precedence over starting new work"
        : null,
    };
  }

  return rankIssueCandidates(issues);
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

export function prioritizeIssuesForWork(
  issues: IssueSummary[],
  options: { activeProjectSlug?: string | null; stoppedProjectSlug?: string | null } = {},
): IssueSelectionDecision {
  const notCompleted = issues.filter((issue) => !hasIssueLabel(issue, "completed") && !hasIssueLabel(issue, "blocked"));
  if (notCompleted.length === 0) {
    return {
      selectedIssue: null,
      candidateCount: 0,
      rationale: null,
    };
  }

  const stoppedProjectSlug = options.stoppedProjectSlug?.trim() || null;
  const selectableIssues = stoppedProjectSlug
    ? notCompleted.filter((issue) => !issueTargetsProject(issue, stoppedProjectSlug))
    : notCompleted;
  if (selectableIssues.length === 0) {
    return {
      selectedIssue: null,
      candidateCount: 0,
      rationale: null,
    };
  }

  const activeProjectSlug = options.activeProjectSlug?.trim() || null;
  if (activeProjectSlug) {
    const activeProjectIssues = selectableIssues.filter((issue) => issueTargetsProject(issue, activeProjectSlug));
    if (activeProjectIssues.length > 0) {
      const decision = prioritizeIssueCandidates(activeProjectIssues);
      return {
        selectedIssue: decision.selectedIssue,
        candidateCount: selectableIssues.length,
        rationale: selectableIssues.length > 1
          ? buildSelectionRationale(
            `active project issues take precedence while ${activeProjectSlug} is selected`,
            decision.rationale,
          )
          : null,
      };
    }
  }

  const decision = prioritizeIssueCandidates(selectableIssues);
  return {
    selectedIssue: decision.selectedIssue,
    candidateCount: selectableIssues.length,
    rationale: selectableIssues.length > 1 ? decision.rationale : null,
  };
}

export function selectIssueForWork(
  issues: IssueSummary[],
  options: { activeProjectSlug?: string | null; stoppedProjectSlug?: string | null } = {},
): IssueSummary | null {
  return prioritizeIssuesForWork(issues, options).selectedIssue;
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

export function logIssuePrioritizationDecision(decision: IssueSelectionDecision): void {
  if (decision.selectedIssue === null || decision.candidateCount < 2 || !decision.rationale) {
    return;
  }

  console.log(
    `Issue prioritization selected ${formatIssueForLog(decision.selectedIssue)} over ${decision.candidateCount - 1} other candidate(s): ${decision.rationale}.`,
  );
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
