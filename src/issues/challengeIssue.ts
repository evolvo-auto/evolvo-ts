import type { IssueSummary } from "./taskIssueManager.js";

export const IN_PROGRESS_LABEL = "in progress";
export const CHALLENGE_LABEL = "challenge";
export const CHALLENGE_FAILED_LABEL = "challenge:failed";
export const CHALLENGE_READY_TO_RETRY_LABEL = "challenge:ready-to-retry";
export const CHALLENGE_BLOCKED_LABEL = "challenge:blocked";

export type ChallengeIssueMetadata = {
  id?: string;
  source_issue?: string;
  retry_policy?: string;
  [key: string]: string | undefined;
};

export function hasIssueLabel(issue: IssueSummary, label: string): boolean {
  return issue.labels.some((currentLabel) => currentLabel.toLowerCase() === label.toLowerCase());
}

export function parseChallengeIssueMetadata(description: string): ChallengeIssueMetadata | null {
  const match = description.match(/<!--\s*evolvo:challenge([\s\S]*?)-->/i);
  if (!match?.[1]) {
    return null;
  }

  const metadata: ChallengeIssueMetadata = {};
  const lines = match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex < 1 || separatorIndex >= line.length - 1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    if (!key || !value) {
      continue;
    }

    metadata[key] = value;
  }

  return Object.keys(metadata).length > 0 ? metadata : {};
}

export function isChallengeIssue(issue: IssueSummary): boolean {
  if (hasIssueLabel(issue, CHALLENGE_LABEL)) {
    return true;
  }

  return parseChallengeIssueMetadata(issue.description) !== null;
}

export function isChallengeRetryReadyIssue(issue: IssueSummary): boolean {
  return isChallengeIssue(issue) && hasIssueLabel(issue, CHALLENGE_READY_TO_RETRY_LABEL);
}

export function isChallengeInProgressIssue(issue: IssueSummary): boolean {
  return isChallengeIssue(issue) && hasIssueLabel(issue, IN_PROGRESS_LABEL);
}
