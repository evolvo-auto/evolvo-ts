import { promises as fs } from "node:fs";
import { join } from "node:path";
import { hasIssueLabel, isChallengeIssue } from "../issues/challengeIssue.js";
import type { IssueSummary } from "../issues/taskIssueManager.js";
import {
  readRecoverableJsonState,
  type RecoverableJsonStateNormalizationResult,
} from "../runtime/localStateFile.js";

const EVOLVO_DIRECTORY_NAME = ".evolvo";
const CHALLENGE_RETRY_STATE_FILE_NAME = "challenge-retry-state.json";

export const CHALLENGE_FAILED_LABEL = "challenge:failed";
export const CHALLENGE_READY_TO_RETRY_LABEL = "challenge:ready-to-retry";
export const CHALLENGE_BLOCKED_LABEL = "challenge:blocked";
const MANAGED_CHALLENGE_RETRY_LABELS = [
  CHALLENGE_FAILED_LABEL,
  CHALLENGE_READY_TO_RETRY_LABEL,
  CHALLENGE_BLOCKED_LABEL,
] as const;

type ChallengeRetryState = {
  failuresByChallenge: Record<string, { attempts: number; lastFailureAtMs: number }>;
};

export type ChallengeRetryDecision = {
  eligible: boolean;
  reason:
    | "not-challenge"
    | "first-attempt"
    | "awaiting-corrective-issues"
    | "cooldown-active"
    | "ready-to-retry"
    | "max-attempts-reached";
  attemptCount: number;
  cooldownRemainingMs: number;
  openCorrectiveIssueNumbers: number[];
  addLabels: string[];
  removeLabels: string[];
};

export type RetryGateOptions = {
  maxAttempts: number;
  cooldownMs: number;
  nowMs?: number;
};

export type RecordChallengeAttemptOutcomeInput = {
  challengeIssueNumber: number;
  success: boolean;
  nowMs?: number;
};

function createDefaultRetryState(): ChallengeRetryState {
  return {
    failuresByChallenge: {},
  };
}

function toFiniteNonNegativeInteger(value: unknown): number {
  const asNumber = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(asNumber) || asNumber < 0) {
    return 0;
  }

  return Math.floor(asNumber);
}

function normalizeRetryState(state: unknown): RecoverableJsonStateNormalizationResult<ChallengeRetryState> {
  if (typeof state !== "object" || state === null) {
    return {
      state: createDefaultRetryState(),
      recoveredInvalid: true,
    };
  }

  let recoveredInvalid = false;
  const candidate = state as Partial<ChallengeRetryState>;
  if (candidate.failuresByChallenge !== undefined && (typeof candidate.failuresByChallenge !== "object" || candidate.failuresByChallenge === null)) {
    recoveredInvalid = true;
  }
  const failuresByChallenge = Object.fromEntries(
    Object.entries(candidate.failuresByChallenge ?? {})
      .map(([challengeNumber, value]) => {
        const attempts = toFiniteNonNegativeInteger(value?.attempts);
        const lastFailureAtMs = toFiniteNonNegativeInteger(value?.lastFailureAtMs);
        if (
          typeof value !== "object" ||
          value === null ||
          attempts <= 0 ||
          attempts !== value.attempts ||
          lastFailureAtMs !== value.lastFailureAtMs
        ) {
          recoveredInvalid = true;
        }
        return [challengeNumber, { attempts, lastFailureAtMs }] as const;
      })
      .filter(([, value]) => value.attempts > 0)
      .sort(([left], [right]) => left.localeCompare(right)),
  );

  return {
    state: { failuresByChallenge },
    recoveredInvalid,
  };
}

function getRetryStatePath(workDir: string): string {
  return join(workDir, EVOLVO_DIRECTORY_NAME, CHALLENGE_RETRY_STATE_FILE_NAME);
}

function parseCorrectiveChallengeLink(description: string): number | null {
  const match = description.match(/Relates-to-Challenge:\s*#(\d+)/i);
  if (!match?.[1]) {
    return null;
  }

  const challengeNumber = Number(match[1]);
  return Number.isInteger(challengeNumber) && challengeNumber > 0 ? challengeNumber : null;
}

function getManagedLabelChanges(issue: IssueSummary, addLabels: string[]): { addLabels: string[]; removeLabels: string[] } {
  const addSet = new Set(addLabels.map((label) => label.toLowerCase()));
  const removeLabels = MANAGED_CHALLENGE_RETRY_LABELS
    .filter((label) => !addSet.has(label.toLowerCase()) && hasIssueLabel(issue, label));
  const existingLowerCase = new Set(issue.labels.map((label) => label.toLowerCase()));
  const dedupedAddLabels = addLabels.filter((label) => !existingLowerCase.has(label.toLowerCase()));

  return {
    addLabels: dedupedAddLabels,
    removeLabels,
  };
}

export async function readChallengeRetryState(workDir: string): Promise<ChallengeRetryState> {
  return readRecoverableJsonState({
    statePath: getRetryStatePath(workDir),
    createDefaultState: createDefaultRetryState,
    normalizeState: normalizeRetryState,
    warningLabel: "challenge retry state store",
  });
}

async function writeChallengeRetryState(workDir: string, state: ChallengeRetryState): Promise<void> {
  await fs.mkdir(join(workDir, EVOLVO_DIRECTORY_NAME), { recursive: true });
  await fs.writeFile(
    getRetryStatePath(workDir),
    `${JSON.stringify(normalizeRetryState(state).state, null, 2)}\n`,
    "utf8",
  );
}

export async function recordChallengeAttemptOutcome(
  workDir: string,
  input: RecordChallengeAttemptOutcomeInput,
): Promise<ChallengeRetryState> {
  const nowMs = toFiniteNonNegativeInteger(input.nowMs ?? Date.now());
  const challengeKey = String(Math.floor(input.challengeIssueNumber));
  const state = await readChallengeRetryState(workDir);
  const current = state.failuresByChallenge[challengeKey];

  if (input.success) {
    delete state.failuresByChallenge[challengeKey];
  } else {
    state.failuresByChallenge[challengeKey] = {
      attempts: toFiniteNonNegativeInteger(current?.attempts) + 1,
      lastFailureAtMs: nowMs,
    };
  }

  const normalized = normalizeRetryState(state).state;
  await writeChallengeRetryState(workDir, normalized);
  return normalized;
}

export async function evaluateChallengeRetryEligibility(
  workDir: string,
  issue: IssueSummary,
  openIssues: IssueSummary[],
  options: RetryGateOptions,
): Promise<ChallengeRetryDecision> {
  if (!isChallengeIssue(issue)) {
    return {
      eligible: true,
      reason: "not-challenge",
      attemptCount: 0,
      cooldownRemainingMs: 0,
      openCorrectiveIssueNumbers: [],
      addLabels: [],
      removeLabels: [],
    };
  }

  const nowMs = toFiniteNonNegativeInteger(options.nowMs ?? Date.now());
  const maxAttempts = Math.max(1, toFiniteNonNegativeInteger(options.maxAttempts));
  const cooldownMs = toFiniteNonNegativeInteger(options.cooldownMs);
  const state = await readChallengeRetryState(workDir);
  const retryEntry = state.failuresByChallenge[String(issue.number)];
  const attemptCount = toFiniteNonNegativeInteger(retryEntry?.attempts);
  const blockedLabelPresent = hasIssueLabel(issue, CHALLENGE_BLOCKED_LABEL);

  if (blockedLabelPresent) {
    return {
      eligible: false,
      reason: "max-attempts-reached",
      attemptCount,
      cooldownRemainingMs: 0,
      openCorrectiveIssueNumbers: [],
      ...getManagedLabelChanges(issue, [CHALLENGE_FAILED_LABEL, CHALLENGE_BLOCKED_LABEL]),
    };
  }

  const failedLabelPresent = hasIssueLabel(issue, CHALLENGE_FAILED_LABEL) || attemptCount > 0;
  if (!failedLabelPresent) {
    return {
      eligible: true,
      reason: "first-attempt",
      attemptCount,
      cooldownRemainingMs: 0,
      openCorrectiveIssueNumbers: [],
      ...getManagedLabelChanges(issue, []),
    };
  }

  if (attemptCount >= maxAttempts) {
    return {
      eligible: false,
      reason: "max-attempts-reached",
      attemptCount,
      cooldownRemainingMs: 0,
      openCorrectiveIssueNumbers: [],
      ...getManagedLabelChanges(issue, [CHALLENGE_FAILED_LABEL, CHALLENGE_BLOCKED_LABEL]),
    };
  }

  const openCorrectiveIssueNumbers = openIssues
    .filter((openIssue) => openIssue.number !== issue.number)
    .filter((openIssue) => parseCorrectiveChallengeLink(openIssue.description) === issue.number)
    .map((openIssue) => openIssue.number)
    .sort((left, right) => left - right);

  if (openCorrectiveIssueNumbers.length > 0) {
    return {
      eligible: false,
      reason: "awaiting-corrective-issues",
      attemptCount,
      cooldownRemainingMs: 0,
      openCorrectiveIssueNumbers,
      ...getManagedLabelChanges(issue, [CHALLENGE_FAILED_LABEL]),
    };
  }

  const lastFailureAtMs = toFiniteNonNegativeInteger(retryEntry?.lastFailureAtMs);
  const cooldownRemainingMs = Math.max(0, lastFailureAtMs + cooldownMs - nowMs);
  if (cooldownRemainingMs > 0) {
    return {
      eligible: false,
      reason: "cooldown-active",
      attemptCount,
      cooldownRemainingMs,
      openCorrectiveIssueNumbers: [],
      ...getManagedLabelChanges(issue, [CHALLENGE_FAILED_LABEL]),
    };
  }

  return {
    eligible: true,
    reason: "ready-to-retry",
    attemptCount,
    cooldownRemainingMs: 0,
    openCorrectiveIssueNumbers: [],
    ...getManagedLabelChanges(issue, [CHALLENGE_FAILED_LABEL, CHALLENGE_READY_TO_RETRY_LABEL]),
  };
}
