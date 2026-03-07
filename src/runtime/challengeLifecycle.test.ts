import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingAgentRunResult } from "../agents/runCodingAgent.js";
import type { IssueSummary, TaskIssueManager } from "../issues/taskIssueManager.js";
import * as challengeFailureLearning from "../challenges/challengeFailureLearning.js";
import * as challengeMetrics from "../challenges/challengeMetrics.js";
import * as retryGate from "../challenges/retryGate.js";
import * as issueLifecyclePresentation from "./issueLifecyclePresentation.js";
import {
  applyChallengeRetryGate,
  buildChallengeRetryGateComment,
  finalizeChallengeSuccess,
  updateChallengeMetrics,
} from "./challengeLifecycle.js";

vi.mock("../challenges/challengeFailureLearning.js", () => ({
  CHALLENGE_LEARNING_GENERATED_LABEL: "challenge:learning-generated",
  buildChallengeFailureLearningComment: vi.fn(() => "learning-comment"),
  classifyChallengeFailure: vi.fn(() => "execution_failure"),
  createCorrectiveIssuesForChallengeFailure: vi.fn(async () => []),
}));

vi.mock("../challenges/challengeMetrics.js", () => ({
  formatChallengeMetricsReport: vi.fn(() => "metrics-report"),
  recordChallengeAttemptMetrics: vi.fn(async () => ({ totalAttempts: 1 })),
}));

vi.mock("../challenges/retryGate.js", () => ({
  CHALLENGE_BLOCKED_LABEL: "challenge:blocked",
  CHALLENGE_FAILED_LABEL: "challenge:failed",
  CHALLENGE_READY_TO_RETRY_LABEL: "challenge:ready-to-retry",
  evaluateChallengeRetryEligibility: vi.fn(),
  recordChallengeAttemptOutcome: vi.fn(async () => ({ failuresByChallenge: {} })),
}));

vi.mock("./issueLifecyclePresentation.js", () => ({
  addIssueLifecycleComment: vi.fn(async () => {}),
}));

function createIssue(overrides: Partial<IssueSummary> = {}): IssueSummary {
  return {
    number: 10,
    title: "Challenge task",
    description: "",
    state: "open",
    labels: ["challenge"],
    ...overrides,
  };
}

function createRunResult(overrides: Partial<CodingAgentRunResult["summary"]> = {}): CodingAgentRunResult {
  return {
    mergedPullRequest: false,
    summary: {
      inspectedAreas: [],
      editedFiles: [],
      validationCommands: [],
      failedValidationCommands: [],
      reviewOutcome: "accepted",
      pullRequestCreated: true,
      externalRepositories: [],
      externalPullRequests: [],
      mergedExternalPullRequest: false,
      finalResponse: "done",
      ...overrides,
    },
  };
}

function createIssueManager(): TaskIssueManager {
  return {
    updateLabels: vi.fn(async () => ({ ok: true, message: "updated" })),
    addProgressComment: vi.fn(async () => ({ ok: true, message: "commented" })),
    markCompleted: vi.fn(async () => ({ ok: true, message: "completed" })),
  } as unknown as TaskIssueManager;
}

describe("challengeLifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("updates metrics and clears retry labels after successful challenge run", async () => {
    const issueManager = createIssueManager();
    const issue = createIssue();
    const runResult = createRunResult({ reviewOutcome: "accepted" });

    await updateChallengeMetrics(issueManager, issue, null, runResult);

    expect(challengeMetrics.recordChallengeAttemptMetrics).toHaveBeenCalledWith(expect.any(String), {
      challengeIssueNumber: issue.number,
      success: true,
      failureCategory: undefined,
    });
    expect(retryGate.recordChallengeAttemptOutcome).toHaveBeenCalledWith(expect.any(String), {
      challengeIssueNumber: issue.number,
      success: true,
    });
    expect(issueManager.updateLabels).toHaveBeenCalledWith(issue.number, {
      remove: [
        "challenge:failed",
        "challenge:ready-to-retry",
        "challenge:blocked",
        "challenge:learning-generated",
      ],
    });
    expect(challengeFailureLearning.createCorrectiveIssuesForChallengeFailure).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith("metrics-report");
  });

  it("records failure, blocks max-attempt challenge, and emits learning artifacts", async () => {
    const issueManager = createIssueManager();
    const issue = createIssue({ number: 22 });
    vi.mocked(retryGate.recordChallengeAttemptOutcome).mockResolvedValueOnce({
      failuresByChallenge: { "22": { attempts: 3, lastFailureAtMs: 1_000 } },
    });
    vi.mocked(challengeFailureLearning.createCorrectiveIssuesForChallengeFailure).mockResolvedValueOnce([
      { number: 91, title: "Fix failure mode", description: "", state: "open", labels: [] },
    ]);

    await updateChallengeMetrics(issueManager, issue, new Error("boom"), createRunResult({ reviewOutcome: "amended" }));

    expect(issueManager.updateLabels).toHaveBeenNthCalledWith(1, issue.number, {
      add: ["challenge:failed", "challenge:blocked"],
      remove: ["challenge:ready-to-retry"],
    });
    expect(challengeFailureLearning.createCorrectiveIssuesForChallengeFailure).toHaveBeenCalledWith(
      issueManager,
      issue.number,
      "execution_failure",
    );
    expect(issueManager.addProgressComment).toHaveBeenCalledWith(issue.number, "learning-comment");
    expect(issueManager.updateLabels).toHaveBeenNthCalledWith(2, issue.number, {
      add: ["challenge:learning-generated"],
    });
  });

  it("logs and exits when metrics update throws", async () => {
    const issueManager = createIssueManager();
    const issue = createIssue({ number: 33 });
    vi.mocked(challengeMetrics.recordChallengeAttemptMetrics).mockRejectedValueOnce(new Error("write failed"));

    await updateChallengeMetrics(issueManager, issue, new Error("boom"), null);

    expect(console.error).toHaveBeenCalledWith("Could not update challenge metrics for issue #33: write failed");
    expect(issueManager.updateLabels).not.toHaveBeenCalled();
  });

  it("skips metrics update for non-challenge issues", async () => {
    const issueManager = createIssueManager();
    const issue = createIssue({ labels: ["bug"] });

    await updateChallengeMetrics(issueManager, issue, null, createRunResult());

    expect(challengeMetrics.recordChallengeAttemptMetrics).not.toHaveBeenCalled();
    expect(issueManager.updateLabels).not.toHaveBeenCalled();
  });

  it("finalizes accepted challenge issues", async () => {
    const issueManager = createIssueManager();
    const issue = createIssue({ number: 44 });

    const completed = await finalizeChallengeSuccess(issueManager, issue, createRunResult({ reviewOutcome: "accepted" }));

    expect(completed).toBe(true);
    expect(issueManager.markCompleted).toHaveBeenCalledWith(
      issue.number,
      expect.stringContaining("Challenge issue #44 succeeded."),
    );
  });

  it("treats already-terminal completion response as success", async () => {
    const issueManager = createIssueManager();
    vi.mocked(issueManager.markCompleted).mockResolvedValueOnce({
      ok: false,
      message: "Issue is closed and cannot be completed",
    });

    const completed = await finalizeChallengeSuccess(
      issueManager,
      createIssue({ number: 45 }),
      createRunResult({ reviewOutcome: "accepted" }),
    );

    expect(completed).toBe(true);
  });

  it("returns false when completion cannot be finalized", async () => {
    const issueManager = createIssueManager();
    vi.mocked(issueManager.markCompleted).mockResolvedValueOnce({
      ok: false,
      message: "api timeout",
    });

    const completed = await finalizeChallengeSuccess(
      issueManager,
      createIssue({ number: 46 }),
      createRunResult({ reviewOutcome: "accepted" }),
    );

    expect(completed).toBe(false);
    expect(console.error).toHaveBeenCalledWith("Could not finalize challenge issue #46: api timeout");
  });

  it("does not finalize when review was not accepted", async () => {
    const issueManager = createIssueManager();

    const completed = await finalizeChallengeSuccess(
      issueManager,
      createIssue({ number: 47 }),
      createRunResult({ reviewOutcome: "amended" }),
    );

    expect(completed).toBe(false);
    expect(issueManager.markCompleted).not.toHaveBeenCalled();
  });

  it("passes through non-challenge issues in retry gating", async () => {
    const issue = createIssue({ labels: ["bug"] });
    const issueManager = createIssueManager();
    const eligible = await applyChallengeRetryGate({
      issueManager,
      openIssues: [issue],
      issues: [issue],
      cycle: 9,
      onBlockedTransition: vi.fn(async () => {}),
    });

    expect(eligible).toEqual([issue]);
    expect(retryGate.evaluateChallengeRetryEligibility).not.toHaveBeenCalled();
  });

  it("keeps eligible challenge with updated labels from issue manager", async () => {
    const issue = createIssue({ number: 50 });
    const updatedIssue = createIssue({ number: 50, labels: ["challenge", "challenge:ready-to-retry"] });
    const issueManager = createIssueManager();
    vi.mocked(retryGate.evaluateChallengeRetryEligibility).mockResolvedValueOnce({
      eligible: true,
      reason: "ready-to-retry",
      attemptCount: 1,
      cooldownRemainingMs: 0,
      openCorrectiveIssueNumbers: [],
      addLabels: ["challenge:ready-to-retry"],
      removeLabels: [],
    });
    vi.mocked(issueManager.updateLabels).mockResolvedValueOnce({
      ok: true,
      message: "updated",
      issue: updatedIssue,
    });

    const eligible = await applyChallengeRetryGate({
      issueManager,
      openIssues: [issue],
      issues: [issue],
      cycle: 7,
      onBlockedTransition: vi.fn(async () => {}),
    });

    expect(eligible).toEqual([updatedIssue]);
    expect(issueManager.updateLabels).toHaveBeenCalledWith(issue.number, {
      add: ["challenge:ready-to-retry"],
      remove: [],
    });
  });

  it("blocks max-attempt challenges and adds lifecycle gate comment", async () => {
    const issue = createIssue({ number: 60 });
    const issueManager = createIssueManager();
    const onBlockedTransition = vi.fn(async () => {});
    vi.mocked(retryGate.evaluateChallengeRetryEligibility).mockResolvedValueOnce({
      eligible: false,
      reason: "max-attempts-reached",
      attemptCount: 3,
      cooldownRemainingMs: 0,
      openCorrectiveIssueNumbers: [501],
      addLabels: [],
      removeLabels: [],
    });

    const eligible = await applyChallengeRetryGate({
      issueManager,
      openIssues: [issue],
      issues: [issue],
      cycle: 12,
      onBlockedTransition,
    });

    expect(eligible).toEqual([]);
    expect(onBlockedTransition).toHaveBeenCalledWith(issue, 12, "max-attempts-reached");
    expect(issueLifecyclePresentation.addIssueLifecycleComment).toHaveBeenCalledWith(
      issueManager,
      issue.number,
      expect.stringContaining("Challenge Retry Gate"),
    );
  });

  it("builds retry gate comment with cooldown and corrective issue details", () => {
    const comment = buildChallengeRetryGateComment(createIssue({ number: 70 }), {
      eligible: false,
      reason: "cooldown-active",
      attemptCount: 2,
      cooldownRemainingMs: 30_000,
      openCorrectiveIssueNumbers: [801, 802],
      addLabels: [],
      removeLabels: [],
    });

    expect(comment).toContain("Issue #70 was evaluated by retry gating.");
    expect(comment).toContain("Cooldown remaining: 30000ms");
    expect(comment).toContain("Open corrective issues: #801, #802");
  });
});
