import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IssueSummary } from "../issues/taskIssueManager.js";
import {
  CHALLENGE_BLOCKED_LABEL,
  CHALLENGE_FAILED_LABEL,
  CHALLENGE_READY_TO_RETRY_LABEL,
  evaluateChallengeRetryEligibility,
  readChallengeRetryState,
  recordChallengeAttemptOutcome,
} from "./retryGate.js";

async function createTempWorkDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "challenge-retry-gate-"));
}

function createIssue(overrides: Partial<IssueSummary> = {}): IssueSummary {
  return {
    number: 1,
    title: "Challenge issue",
    description: "Description",
    state: "open",
    labels: ["challenge"],
    ...overrides,
  };
}

describe("retryGate", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("treats a fresh challenge as eligible first attempt", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    const issue = createIssue();

    const decision = await evaluateChallengeRetryEligibility(workDir, issue, [issue], {
      maxAttempts: 3,
      cooldownMs: 60_000,
      nowMs: 1_000,
    });

    expect(decision).toEqual({
      eligible: true,
      reason: "first-attempt",
      attemptCount: 0,
      cooldownRemainingMs: 0,
      openCorrectiveIssueNumbers: [],
      addLabels: [],
      removeLabels: [],
    });
  });

  it("bypasses retry gating for non-challenge issues", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    const issue = createIssue({ labels: ["bug"] });

    const decision = await evaluateChallengeRetryEligibility(workDir, issue, [issue], {
      maxAttempts: 3,
      cooldownMs: 60_000,
      nowMs: 1_000,
    });

    expect(decision).toEqual({
      eligible: true,
      reason: "not-challenge",
      attemptCount: 0,
      cooldownRemainingMs: 0,
      openCorrectiveIssueNumbers: [],
      addLabels: [],
      removeLabels: [],
    });
  });

  it("treats metadata-marked issues as challenge issues", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    const issue = createIssue({
      labels: ["bug"],
      description: "<!-- evolvo:challenge\nid: challenge-101\n-->",
    });

    const decision = await evaluateChallengeRetryEligibility(workDir, issue, [issue], {
      maxAttempts: 3,
      cooldownMs: 60_000,
      nowMs: 1_000,
    });

    expect(decision.reason).toBe("first-attempt");
    expect(decision.eligible).toBe(true);
  });

  it("rejects retry when corrective issues are still open", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    await recordChallengeAttemptOutcome(workDir, {
      challengeIssueNumber: 10,
      success: false,
      nowMs: 1_000,
    });
    const challenge = createIssue({ number: 10, labels: ["challenge", CHALLENGE_FAILED_LABEL] });
    const corrective = createIssue({
      number: 999,
      title: "Corrective issue",
      labels: [],
      description: "Relates-to-Challenge: #10",
    });

    const decision = await evaluateChallengeRetryEligibility(workDir, challenge, [challenge, corrective], {
      maxAttempts: 3,
      cooldownMs: 0,
      nowMs: 2_000,
    });

    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe("awaiting-corrective-issues");
    expect(decision.openCorrectiveIssueNumbers).toEqual([999]);
    expect(decision.addLabels).toEqual([]);
    expect(decision.removeLabels).toEqual([]);
  });

  it("rejects retry while cooldown is active", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    await recordChallengeAttemptOutcome(workDir, {
      challengeIssueNumber: 11,
      success: false,
      nowMs: 10_000,
    });
    const challenge = createIssue({ number: 11, labels: ["challenge", CHALLENGE_FAILED_LABEL] });

    const decision = await evaluateChallengeRetryEligibility(workDir, challenge, [challenge], {
      maxAttempts: 3,
      cooldownMs: 60_000,
      nowMs: 20_000,
    });

    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe("cooldown-active");
    expect(decision.cooldownRemainingMs).toBe(50_000);
  });

  it("allows retry and adds ready label after cooldown with no open corrective issues", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    await recordChallengeAttemptOutcome(workDir, {
      challengeIssueNumber: 12,
      success: false,
      nowMs: 1_000,
    });
    const challenge = createIssue({ number: 12, labels: ["challenge", CHALLENGE_FAILED_LABEL] });

    const decision = await evaluateChallengeRetryEligibility(workDir, challenge, [challenge], {
      maxAttempts: 3,
      cooldownMs: 60_000,
      nowMs: 70_000,
    });

    expect(decision).toEqual({
      eligible: true,
      reason: "ready-to-retry",
      attemptCount: 1,
      cooldownRemainingMs: 0,
      openCorrectiveIssueNumbers: [],
      addLabels: [CHALLENGE_READY_TO_RETRY_LABEL],
      removeLabels: [],
    });
  });

  it("blocks challenge when max attempts are reached", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    await recordChallengeAttemptOutcome(workDir, {
      challengeIssueNumber: 13,
      success: false,
      nowMs: 1_000,
    });
    await recordChallengeAttemptOutcome(workDir, {
      challengeIssueNumber: 13,
      success: false,
      nowMs: 2_000,
    });
    await recordChallengeAttemptOutcome(workDir, {
      challengeIssueNumber: 13,
      success: false,
      nowMs: 3_000,
    });
    const challenge = createIssue({ number: 13, labels: ["challenge", CHALLENGE_FAILED_LABEL] });

    const decision = await evaluateChallengeRetryEligibility(workDir, challenge, [challenge], {
      maxAttempts: 3,
      cooldownMs: 0,
      nowMs: 4_000,
    });

    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe("max-attempts-reached");
    expect(decision.addLabels).toEqual([CHALLENGE_BLOCKED_LABEL]);
    expect(decision.removeLabels).toEqual([]);
  });

  it("keeps challenge blocked when blocked label is present without retry state", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    const challenge = createIssue({
      number: 14,
      labels: ["challenge", CHALLENGE_FAILED_LABEL, CHALLENGE_BLOCKED_LABEL, CHALLENGE_READY_TO_RETRY_LABEL],
    });

    const decision = await evaluateChallengeRetryEligibility(workDir, challenge, [challenge], {
      maxAttempts: 3,
      cooldownMs: 0,
      nowMs: 4_000,
    });

    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe("max-attempts-reached");
    expect(decision.addLabels).toEqual([]);
    expect(decision.removeLabels).toEqual([CHALLENGE_READY_TO_RETRY_LABEL]);
  });

  it("clears retry state after success", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    await recordChallengeAttemptOutcome(workDir, {
      challengeIssueNumber: 21,
      success: false,
      nowMs: 10,
    });
    const stateAfterFailure = await readChallengeRetryState(workDir);
    expect(stateAfterFailure.failuresByChallenge["21"]).toEqual({ attempts: 1, lastFailureAtMs: 10 });

    await recordChallengeAttemptOutcome(workDir, {
      challengeIssueNumber: 21,
      success: true,
      nowMs: 20,
    });
    const stateAfterSuccess = await readChallengeRetryState(workDir);
    expect(stateAfterSuccess.failuresByChallenge).toEqual({});
  });

  it("recovers malformed retry state JSON by preserving the corrupt file and resetting defaults", async () => {
    vi.useFakeTimers();
    const recoveryAtMs = new Date("2026-03-07T22:10:00.000Z").getTime();
    vi.setSystemTime(recoveryAtMs);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    const evolvoDir = join(workDir, ".evolvo");
    const statePath = join(evolvoDir, "challenge-retry-state.json");
    const corruptPath = join(evolvoDir, `challenge-retry-state.corrupt-${recoveryAtMs}.json`);
    await mkdir(evolvoDir, { recursive: true });
    await writeFile(statePath, "{\"failuresByChallenge\":", "utf8");

    const state = await readChallengeRetryState(workDir);

    expect(state).toEqual({ failuresByChallenge: {} });
    expect(await readFile(corruptPath, "utf8")).toBe("{\"failuresByChallenge\":");
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({ failuresByChallenge: {} });
    expect(warnSpy).toHaveBeenCalledWith(
      `Recovered malformed challenge retry state store at ${statePath}; preserved corrupt file at ${corruptPath}.`,
    );
  });

  it("archives parseable but invalid retry state payloads before normalizing them", async () => {
    vi.useFakeTimers();
    const recoveryAtMs = new Date("2026-03-08T00:50:00.000Z").getTime();
    vi.setSystemTime(recoveryAtMs);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    const evolvoDir = join(workDir, ".evolvo");
    const statePath = join(evolvoDir, "challenge-retry-state.json");
    const corruptPath = join(evolvoDir, `challenge-retry-state.corrupt-${recoveryAtMs}.json`);
    const invalidPayload = {
      failuresByChallenge: {
        15: {
          attempts: 2,
          lastFailureAtMs: 1000,
        },
        99: {
          attempts: -1,
          lastFailureAtMs: "bad",
        },
      },
    };
    await mkdir(evolvoDir, { recursive: true });
    await writeFile(statePath, JSON.stringify(invalidPayload), "utf8");

    const state = await readChallengeRetryState(workDir);

    expect(state).toEqual({
      failuresByChallenge: {
        15: {
          attempts: 2,
          lastFailureAtMs: 1000,
        },
      },
    });
    expect(await readFile(corruptPath, "utf8")).toBe(JSON.stringify(invalidPayload));
    expect(warnSpy).toHaveBeenCalledWith(
      `Recovered invalid challenge retry state store at ${statePath}; preserved corrupt file at ${corruptPath}.`,
    );
  });
});
