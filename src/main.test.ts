import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubApiError } from "./github/githubClient.js";

const runCodingAgentMock = vi.fn();
const runIssueCommandMock = vi.fn();
const getGitHubConfigMock = vi.fn();
const listOpenIssuesMock = vi.fn();
const markInProgressMock = vi.fn();
const markCompletedMock = vi.fn();
const addProgressCommentMock = vi.fn();
const closeIssueMock = vi.fn();
const replenishSelfImprovementIssuesMock = vi.fn();
const generateStartupIssueTemplatesMock = vi.fn();
const runPostMergeSelfRestartMock = vi.fn();
const recordChallengeAttemptMetricsMock = vi.fn();
const formatChallengeMetricsReportMock = vi.fn();
const evaluateChallengeRetryEligibilityMock = vi.fn();
const recordChallengeAttemptOutcomeMock = vi.fn();
const persistChallengeAttemptArtifactMock = vi.fn();
const updateLabelsMock = vi.fn();
const createIssueMock = vi.fn();
const transitionCanonicalLifecycleStateMock = vi.fn();
const buildLifecycleStateCommentMock = vi.fn();
const writeRuntimeReadinessSignalMock = vi.fn();

const DEFAULT_RUN_RESULT = {
  mergedPullRequest: false,
  summary: {
    inspectedAreas: [],
    editedFiles: ["src/main.ts"],
    validationCommands: [],
    failedValidationCommands: [],
    reviewOutcome: "accepted" as const,
    pullRequestCreated: false,
    externalRepositories: [],
    externalPullRequests: [],
    mergedExternalPullRequest: false,
    finalResponse: "done",
  },
};

vi.mock("./environment.js", () => ({
  GITHUB_OWNER: "owner",
  GITHUB_REPO: "repo",
}));

vi.mock("./constants/workDir.js", () => ({
  WORK_DIR: "/tmp/evolvo",
}));

vi.mock("./agents/runCodingAgent.js", () => ({
  runCodingAgent: runCodingAgentMock,
}));

vi.mock("./runtime/selfRestart.js", () => ({
  runPostMergeSelfRestart: runPostMergeSelfRestartMock,
}));

vi.mock("./issues/startupIssueBootstrap.js", () => ({
  generateStartupIssueTemplates: generateStartupIssueTemplatesMock,
}));

vi.mock("./challenges/challengeMetrics.js", () => ({
  recordChallengeAttemptMetrics: recordChallengeAttemptMetricsMock,
  formatChallengeMetricsReport: formatChallengeMetricsReportMock,
}));

vi.mock("./challenges/retryGate.js", () => ({
  CHALLENGE_BLOCKED_LABEL: "challenge:blocked",
  CHALLENGE_FAILED_LABEL: "challenge:failed",
  CHALLENGE_READY_TO_RETRY_LABEL: "challenge:ready-to-retry",
  evaluateChallengeRetryEligibility: evaluateChallengeRetryEligibilityMock,
  recordChallengeAttemptOutcome: recordChallengeAttemptOutcomeMock,
}));

vi.mock("./challenges/challengeAttemptArtifacts.js", () => ({
  persistChallengeAttemptArtifact: persistChallengeAttemptArtifactMock,
}));

vi.mock("./runtime/lifecycleState.js", () => ({
  transitionCanonicalLifecycleState: transitionCanonicalLifecycleStateMock,
  buildLifecycleStateComment: buildLifecycleStateCommentMock,
}));

vi.mock("./runtime/runtimeReadiness.js", () => ({
  writeRuntimeReadinessSignal: writeRuntimeReadinessSignalMock,
}));

vi.mock("./issues/runIssueCommand.js", () => ({
  runIssueCommand: runIssueCommandMock,
}));

vi.mock("./github/githubConfig.js", () => ({
  getGitHubConfig: getGitHubConfigMock,
}));

vi.mock("./github/githubClient.js", async () => {
  const actual = await vi.importActual<typeof import("./github/githubClient.js")>(
    "./github/githubClient.js",
  );

  return {
    ...actual,
    GitHubClient: class {},
  };
});

vi.mock("./issues/taskIssueManager.js", () => ({
  TaskIssueManager: class {
    listOpenIssues = listOpenIssuesMock;
    markInProgress = markInProgressMock;
    markCompleted = markCompletedMock;
    addProgressComment = addProgressCommentMock;
    closeIssue = closeIssueMock;
    replenishSelfImprovementIssues = replenishSelfImprovementIssuesMock;
    updateLabels = updateLabelsMock;
    createIssue = createIssueMock;
  },
}));

describe("main", () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.EVOLVO_RESTART_TOKEN;
    delete process.env.EVOLVO_READINESS_FILE;
    runCodingAgentMock.mockReset();
    runCodingAgentMock.mockResolvedValue(DEFAULT_RUN_RESULT);
    runPostMergeSelfRestartMock.mockReset();
    runPostMergeSelfRestartMock.mockResolvedValue(undefined);
    runIssueCommandMock.mockReset();
    runIssueCommandMock.mockResolvedValue(false);
    getGitHubConfigMock.mockReset();
    getGitHubConfigMock.mockReturnValue({
      token: "token",
      owner: "owner",
      repo: "repo",
      apiBaseUrl: "https://api.github.com",
    });
    listOpenIssuesMock.mockReset();
    listOpenIssuesMock.mockResolvedValue([]);
    markInProgressMock.mockReset();
    markInProgressMock.mockResolvedValue({ ok: true, message: "ok" });
    markCompletedMock.mockReset();
    markCompletedMock.mockResolvedValue({ ok: true, message: "completed" });
    addProgressCommentMock.mockReset();
    addProgressCommentMock.mockResolvedValue({ ok: true, message: "commented" });
    closeIssueMock.mockReset();
    closeIssueMock.mockResolvedValue({ ok: true, message: "closed" });
    replenishSelfImprovementIssuesMock.mockReset();
    replenishSelfImprovementIssuesMock.mockResolvedValue({ created: [] });
    generateStartupIssueTemplatesMock.mockReset();
    generateStartupIssueTemplatesMock.mockResolvedValue([]);
    recordChallengeAttemptMetricsMock.mockReset();
    recordChallengeAttemptMetricsMock.mockResolvedValue({
      total: 1,
      success: 1,
      failure: 0,
      attemptsToSuccess: { total: 1, samples: 1, average: 1 },
      categoryCounts: {},
      pendingAttemptsByChallenge: {},
    });
    formatChallengeMetricsReportMock.mockReset();
    formatChallengeMetricsReportMock.mockReturnValue("## Challenge Metrics");
    evaluateChallengeRetryEligibilityMock.mockReset();
    evaluateChallengeRetryEligibilityMock.mockResolvedValue({
      eligible: true,
      reason: "not-challenge",
      attemptCount: 0,
      cooldownRemainingMs: 0,
      openCorrectiveIssueNumbers: [],
      addLabels: [],
      removeLabels: [],
    });
    recordChallengeAttemptOutcomeMock.mockReset();
    recordChallengeAttemptOutcomeMock.mockResolvedValue({ failuresByChallenge: {} });
    persistChallengeAttemptArtifactMock.mockReset();
    persistChallengeAttemptArtifactMock.mockResolvedValue({
      relativePath: ".evolvo/challenge-attempts/88/0001.json",
      absolutePath: "/tmp/evolvo/.evolvo/challenge-attempts/88/0001.json",
      artifact: {
        attempt: 1,
        outcome: "success",
        executionSummary: {
          reviewOutcome: "accepted",
        },
        runtimeError: null,
      },
    });
    updateLabelsMock.mockReset();
    updateLabelsMock.mockResolvedValue({ ok: true, message: "labels updated" });
    createIssueMock.mockReset();
    createIssueMock.mockResolvedValue({
      ok: true,
      message: "Created issue #100.",
      issue: { number: 100, title: "Generated", description: "body", state: "open", labels: [] },
    });
    transitionCanonicalLifecycleStateMock.mockReset();
    transitionCanonicalLifecycleStateMock.mockResolvedValue({
      ok: true,
      issueNumber: 1,
      previousState: null,
      entry: {
        issueNumber: 1,
        kind: "issue",
        state: "selected",
        updatedAt: "2026-03-07T00:00:00.000Z",
        transitionCount: 1,
        history: [],
      },
      message: "ok",
    });
    buildLifecycleStateCommentMock.mockReset();
    buildLifecycleStateCommentMock.mockReturnValue("## Canonical Lifecycle State");
    writeRuntimeReadinessSignalMock.mockReset();
    writeRuntimeReadinessSignalMock.mockResolvedValue("/tmp/evolvo/.evolvo/runtime-readiness.json");
    process.argv = ["node", "test-runner.ts"];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });

  it("handles issue commands directly", async () => {
    process.argv = ["node", "src/main.ts", "issues", "list"];
    runIssueCommandMock.mockResolvedValue(true);
    const { main } = await import("./main.js");

    await main();

    expect(runIssueCommandMock).toHaveBeenCalledWith(["issues", "list"]);
    expect(runCodingAgentMock).not.toHaveBeenCalled();
    expect(listOpenIssuesMock).not.toHaveBeenCalled();
  });

  it("writes startup readiness signal when restart token is present", async () => {
    process.env.EVOLVO_RESTART_TOKEN = "restart-token";
    process.env.EVOLVO_READINESS_FILE = "/tmp/evolvo/.evolvo/runtime-readiness.json";
    const { main } = await import("./main.js");

    await main();

    expect(writeRuntimeReadinessSignalMock).toHaveBeenCalledWith({
      workDir: "/tmp/evolvo",
      token: "restart-token",
      signalPath: "/tmp/evolvo/.evolvo/runtime-readiness.json",
    });
    delete process.env.EVOLVO_RESTART_TOKEN;
    delete process.env.EVOLVO_READINESS_FILE;
  });

  it("selects an open issue and uses it as the prompt", async () => {
    listOpenIssuesMock
      .mockResolvedValueOnce([
        { number: 12, title: "Fix login redirect", description: "Handle callback URL.", state: "open", labels: [] },
      ])
      .mockResolvedValueOnce([]);
    const { main } = await import("./main.js");

    await main();

    expect(runIssueCommandMock).toHaveBeenCalledWith([]);
    expect(markInProgressMock).toHaveBeenCalledWith(12);
    expect(addProgressCommentMock).toHaveBeenCalledWith(12, expect.stringContaining("## Canonical Lifecycle State"));
    expect(addProgressCommentMock).toHaveBeenCalledWith(12, expect.stringContaining("## Task Start"));
    expect(addProgressCommentMock).toHaveBeenCalledWith(12, expect.stringContaining("## Task Execution Log"));
    expect(runCodingAgentMock).toHaveBeenCalledWith("Issue #12: Fix login redirect\n\nHandle callback URL.");
    expect(console.log).toHaveBeenCalledWith("Cycle 1 queue health: open=1 selected=#12");
    expect(recordChallengeAttemptMetricsMock).not.toHaveBeenCalled();
    expect(persistChallengeAttemptArtifactMock).not.toHaveBeenCalled();
    expect(replenishSelfImprovementIssuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ minimumIssueCount: 3, maximumOpenIssues: 5 }),
    );
  });

  it("logs validation command name, status, and elapsed time in lifecycle comments", async () => {
    listOpenIssuesMock
      .mockResolvedValueOnce([
        { number: 13, title: "Validation detail", description: "Check logs", state: "open", labels: [] },
      ])
      .mockResolvedValueOnce([]);
    runCodingAgentMock.mockResolvedValueOnce({
      ...DEFAULT_RUN_RESULT,
      summary: {
        ...DEFAULT_RUN_RESULT.summary,
        validationCommands: [{ command: "pnpm validate", commandName: "pnpm", exitCode: 1, durationMs: 321 }],
        failedValidationCommands: [{ command: "pnpm validate", commandName: "pnpm", exitCode: 1, durationMs: 321 }],
        reviewOutcome: "amended",
      },
    });
    const { main } = await import("./main.js");

    await main();

    expect(addProgressCommentMock).toHaveBeenCalledWith(
      13,
      expect.stringContaining("`pnpm validate` (name=pnpm, status=1, elapsed=321ms)"),
    );
  });

  it("prefers an issue already in progress", async () => {
    listOpenIssuesMock
      .mockResolvedValueOnce([
        { number: 5, title: "A", description: "A", state: "open", labels: [] },
        { number: 9, title: "B", description: "B", state: "open", labels: ["in progress"] },
      ])
      .mockResolvedValueOnce([]);
    const { main } = await import("./main.js");

    await main();

    expect(markInProgressMock).not.toHaveBeenCalled();
    expect(addProgressCommentMock).not.toHaveBeenCalledWith(9, expect.stringContaining("## Task Start"));
    expect(addProgressCommentMock).toHaveBeenCalledWith(9, expect.stringContaining("## Task Execution Log"));
    expect(runCodingAgentMock).toHaveBeenCalledWith("Issue #9: B\n\nB");
  });

  it("prioritizes challenge first-attempt issues over self-improvement issues", async () => {
    process.argv = ["node", "test-runner.ts"];
    listOpenIssuesMock
      .mockResolvedValueOnce([
        { number: 14, title: "Self task", description: "normal", state: "open", labels: ["in progress"] },
        { number: 15, title: "Challenge task", description: "challenge", state: "open", labels: ["challenge"] },
      ])
      .mockResolvedValueOnce([]);
    const { main } = await import("./main.js");

    await main();

    expect(runCodingAgentMock).toHaveBeenCalledWith("Issue #15: Challenge task\n\nchallenge");
  });

  it("prioritizes retry-ready challenge issues over other challenge issues", async () => {
    process.argv = ["node", "test-runner.ts"];
    listOpenIssuesMock
      .mockResolvedValueOnce([
        { number: 16, title: "Challenge first", description: "first", state: "open", labels: ["challenge"] },
        {
          number: 17,
          title: "Challenge retry",
          description: "retry",
          state: "open",
          labels: ["challenge", "challenge:ready-to-retry"],
        },
      ])
      .mockResolvedValueOnce([]);
    const { main } = await import("./main.js");

    await main();

    expect(runCodingAgentMock).toHaveBeenCalledWith("Issue #17: Challenge retry\n\nretry");
  });

  it("detects challenge issues from metadata and prioritizes them", async () => {
    process.argv = ["node", "test-runner.ts"];
    listOpenIssuesMock
      .mockResolvedValueOnce([
        { number: 18, title: "Self task", description: "normal", state: "open", labels: ["in progress"] },
        {
          number: 19,
          title: "Metadata challenge",
          description: "<!-- evolvo:challenge\nid: challenge-19\n-->",
          state: "open",
          labels: [],
        },
      ])
      .mockResolvedValueOnce([]);
    const { main } = await import("./main.js");

    await main();

    expect(runCodingAgentMock).toHaveBeenCalledWith(
      "Issue #19: Metadata challenge\n\n<!-- evolvo:challenge\nid: challenge-19\n-->",
    );
  });

  it("continues to the next issue after a run completes", async () => {
    listOpenIssuesMock
      .mockResolvedValueOnce([
        { number: 7, title: "First", description: "first", state: "open", labels: [] },
      ])
      .mockResolvedValueOnce([
        { number: 8, title: "Second", description: "second", state: "open", labels: [] },
      ])
      .mockResolvedValueOnce([]);
    const { main } = await import("./main.js");

    await main();

    expect(runCodingAgentMock).toHaveBeenNthCalledWith(1, "Issue #7: First\n\nfirst");
    expect(runCodingAgentMock).toHaveBeenNthCalledWith(2, "Issue #8: Second\n\nsecond");
  });

  it("runs post-merge restart workflow when a pull request merge is detected", async () => {
    listOpenIssuesMock.mockResolvedValueOnce([
      { number: 11, title: "Restart flow", description: "Restart", state: "open", labels: [] },
    ]);
    runCodingAgentMock.mockResolvedValueOnce({
      ...DEFAULT_RUN_RESULT,
      mergedPullRequest: true,
      summary: { ...DEFAULT_RUN_RESULT.summary, pullRequestCreated: true },
    });
    const { main } = await import("./main.js");

    await main();

    expect(addProgressCommentMock).toHaveBeenCalledWith(11, expect.stringContaining("## Merge Outcome"));
    expect(runPostMergeSelfRestartMock).toHaveBeenCalledWith("/tmp/evolvo");
  });

  it("logs restart failures clearly and exits current runtime", async () => {
    listOpenIssuesMock.mockResolvedValueOnce([
      { number: 21, title: "Restart fail path", description: "Restart", state: "open", labels: [] },
    ]);
    runCodingAgentMock.mockResolvedValueOnce({
      ...DEFAULT_RUN_RESULT,
      mergedPullRequest: true,
      summary: { ...DEFAULT_RUN_RESULT.summary, pullRequestCreated: true },
    });
    runPostMergeSelfRestartMock.mockRejectedValueOnce(new Error("restart failed"));
    const { main } = await import("./main.js");

    await main();

    expect(console.error).toHaveBeenCalledWith("restart failed");
  });

  it("replenishes issues and continues when queue is empty", async () => {
    generateStartupIssueTemplatesMock.mockResolvedValueOnce([
      { title: "Startup issue", description: "from repo analysis" },
      { title: "Startup issue 2", description: "from repo analysis" },
      { title: "Startup issue 3", description: "from repo analysis" },
    ]);
    listOpenIssuesMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { number: 19, title: "Generated", description: "generated", state: "open", labels: [] },
      ])
      .mockResolvedValueOnce([]);
    replenishSelfImprovementIssuesMock.mockResolvedValueOnce({
      created: [{ number: 19, title: "Generated", description: "generated", state: "open", labels: [] }],
    });
    const { DEFAULT_PROMPT, main } = await import("./main.js");

    await main();

    expect(DEFAULT_PROMPT).toBeDefined();
    expect(generateStartupIssueTemplatesMock).toHaveBeenCalledWith("/tmp/evolvo", { targetCount: 3 });
    expect(replenishSelfImprovementIssuesMock).toHaveBeenCalledWith({
      minimumIssueCount: 3,
      maximumOpenIssues: 5,
      templates: [
        { title: "Startup issue", description: "from repo analysis" },
        { title: "Startup issue 2", description: "from repo analysis" },
        { title: "Startup issue 3", description: "from repo analysis" },
      ],
    });
    expect(runCodingAgentMock).toHaveBeenCalledWith("Issue #19: Generated\n\ngenerated");
    expect(console.log).toHaveBeenCalledWith(
      "Cycle 1 queue health: open=0 selected=none queueAction=bootstrap created=1 outcome=continue",
    );
    expect(console.log).toHaveBeenCalledWith(
      "No open issues found on startup. Bootstrapped issue queue from repository analysis.",
    );
  });

  it("logs and exits when no issues are open and replenishment creates nothing", async () => {
    generateStartupIssueTemplatesMock.mockResolvedValueOnce([
      { title: "Startup issue", description: "from repo analysis" },
      { title: "Startup issue 2", description: "from repo analysis" },
      { title: "Startup issue 3", description: "from repo analysis" },
    ]);
    const { DEFAULT_PROMPT, main } = await import("./main.js");

    await main();

    expect(runCodingAgentMock).not.toHaveBeenCalled();
    expect(replenishSelfImprovementIssuesMock).toHaveBeenCalledWith({
      minimumIssueCount: 3,
      maximumOpenIssues: 5,
      templates: [
        { title: "Startup issue", description: "from repo analysis" },
        { title: "Startup issue 2", description: "from repo analysis" },
        { title: "Startup issue 3", description: "from repo analysis" },
      ],
    });
    expect(console.error).toHaveBeenCalledWith("Startup bootstrap created 0 issues from 3 repository-derived template(s).");
    expect(console.error).toHaveBeenCalledWith("Startup repository-derived bootstrap created 0 issues. Issue queue remains empty.");
    expect(console.error).toHaveBeenCalledWith(
      "Startup bootstrap diagnostics: context=repository-derived bootstrap targetCount=3 templateCount=3 createdCount=0.",
    );
    expect(console.error).toHaveBeenCalledWith(
      "Recovery: verify GitHub token permissions and repository issue settings, then run `pnpm dev -- issues list` and create an issue manually if needed.",
    );
    expect(console.log).toHaveBeenCalledWith(
      "Cycle 1 queue health: open=0 selected=none queueAction=bootstrap created=0 outcome=stop",
    );
    expect(console.log).toHaveBeenCalledWith(DEFAULT_PROMPT);
  });

  it("falls back to default startup issue replenishment when repository analysis throws", async () => {
    generateStartupIssueTemplatesMock.mockRejectedValueOnce(new Error("analysis boom"));
    listOpenIssuesMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { number: 30, title: "Fallback issue", description: "fallback", state: "open", labels: [] },
      ])
      .mockResolvedValueOnce([]);
    replenishSelfImprovementIssuesMock.mockResolvedValueOnce({
      created: [{ number: 30, title: "Fallback issue", description: "fallback", state: "open", labels: [] }],
    });
    const { main } = await import("./main.js");

    await main();

    expect(console.error).toHaveBeenCalledWith("Startup repository analysis failed: analysis boom");
    expect(console.error).toHaveBeenCalledWith(
      "Startup issue bootstrap is falling back to default issue templates (targetCount=3).",
    );
    expect(replenishSelfImprovementIssuesMock).toHaveBeenCalledWith({ minimumIssueCount: 3, maximumOpenIssues: 5 });
    expect(runCodingAgentMock).toHaveBeenCalledWith("Issue #30: Fallback issue\n\nfallback");
  });

  it("logs actionable startup diagnostics when fallback issue creation also fails", async () => {
    generateStartupIssueTemplatesMock.mockRejectedValueOnce(new Error("analysis boom"));
    replenishSelfImprovementIssuesMock.mockRejectedValueOnce(new Error("issue create denied"));
    const { DEFAULT_PROMPT, main } = await import("./main.js");

    await main();

    expect(console.error).toHaveBeenCalledWith("Startup repository analysis failed: analysis boom");
    expect(console.error).toHaveBeenCalledWith(
      "Startup issue bootstrap is falling back to default issue templates (targetCount=3).",
    );
    expect(console.error).toHaveBeenCalledWith("Startup fallback issue creation failed: issue create denied");
    expect(console.error).toHaveBeenCalledWith("Startup fallback bootstrap created 0 issues. Issue queue remains empty.");
    expect(console.error).toHaveBeenCalledWith(
      "Startup bootstrap diagnostics: context=fallback bootstrap targetCount=3 templateCount=default createdCount=0.",
    );
    expect(console.error).toHaveBeenCalledWith(
      "Recovery: verify GitHub token permissions and repository issue settings, then run `pnpm dev -- issues list` and create an issue manually if needed.",
    );
    expect(console.log).toHaveBeenCalledWith(
      "Cycle 1 queue health: open=0 selected=none queueAction=bootstrap created=0 outcome=stop",
    );
    expect(console.log).toHaveBeenCalledWith(DEFAULT_PROMPT);
    expect(runCodingAgentMock).not.toHaveBeenCalled();
  });

  it("logs actionable startup diagnostics when fallback issue creation returns no issues", async () => {
    generateStartupIssueTemplatesMock.mockRejectedValueOnce(new Error("analysis boom"));
    replenishSelfImprovementIssuesMock.mockResolvedValueOnce({ created: [] });
    const { DEFAULT_PROMPT, main } = await import("./main.js");

    await main();

    expect(console.error).toHaveBeenCalledWith("Startup repository analysis failed: analysis boom");
    expect(console.error).toHaveBeenCalledWith(
      "Startup issue bootstrap is falling back to default issue templates (targetCount=3).",
    );
    expect(console.error).toHaveBeenCalledWith("Startup fallback bootstrap created 0 issues. Issue queue remains empty.");
    expect(console.error).toHaveBeenCalledWith(
      "Startup bootstrap diagnostics: context=fallback bootstrap targetCount=3 templateCount=default createdCount=0.",
    );
    expect(console.error).toHaveBeenCalledWith(
      "Recovery: verify GitHub token permissions and repository issue settings, then run `pnpm dev -- issues list` and create an issue manually if needed.",
    );
    expect(console.log).toHaveBeenCalledWith(
      "Cycle 1 queue health: open=0 selected=none queueAction=bootstrap created=0 outcome=stop",
    );
    expect(console.log).toHaveBeenCalledWith(DEFAULT_PROMPT);
    expect(runCodingAgentMock).not.toHaveBeenCalled();
  });

  it("closes outdated issues before selecting work", async () => {
    listOpenIssuesMock
      .mockResolvedValueOnce([
        { number: 2, title: "Old task", description: "N/A", state: "open", labels: ["outdated"] },
        { number: 3, title: "Active task", description: "Do this", state: "open", labels: [] },
      ])
      .mockResolvedValueOnce([]);
    const { main } = await import("./main.js");

    await main();

    expect(closeIssueMock).toHaveBeenCalledWith(2);
    expect(markInProgressMock).toHaveBeenCalledWith(3);
    expect(runCodingAgentMock).toHaveBeenCalledWith("Issue #3: Active task\n\nDo this");
  });

  it("does not run completed issues when no actionable work remains", async () => {
    listOpenIssuesMock.mockResolvedValue([
      { number: 4, title: "Done", description: "Done", state: "open", labels: ["completed"] },
    ]);
    const { DEFAULT_PROMPT, main } = await import("./main.js");

    await main();

    expect(runCodingAgentMock).not.toHaveBeenCalled();
    expect(markInProgressMock).not.toHaveBeenCalled();
    expect(replenishSelfImprovementIssuesMock).toHaveBeenCalledWith({ minimumIssueCount: 3, maximumOpenIssues: 5 });
    expect(console.log).toHaveBeenCalledWith(
      "Cycle 1 queue health: open=1 selected=none queueAction=replenish created=0 outcome=stop",
    );
  });

  it("replenishes completed-only queues and processes created issue on the next cycle", async () => {
    process.argv = ["node", "test-runner.ts"];
    listOpenIssuesMock
      .mockResolvedValueOnce([
        { number: 4, title: "Done", description: "Done", state: "open", labels: ["completed"] },
      ])
      .mockResolvedValueOnce([
        { number: 24, title: "Generated", description: "generated", state: "open", labels: [] },
      ])
      .mockResolvedValueOnce([]);
    replenishSelfImprovementIssuesMock.mockResolvedValueOnce({
      created: [{ number: 24, title: "Generated", description: "generated", state: "open", labels: [] }],
    });
    const { main } = await import("./main.js");

    await main();

    expect(generateStartupIssueTemplatesMock).not.toHaveBeenCalled();
    expect(replenishSelfImprovementIssuesMock).toHaveBeenCalledWith({ minimumIssueCount: 3, maximumOpenIssues: 5 });
    expect(console.log).toHaveBeenCalledWith(
      "Cycle 1 queue health: open=1 selected=none queueAction=replenish created=1 outcome=continue",
    );
    expect(runCodingAgentMock).toHaveBeenCalledWith("Issue #24: Generated\n\ngenerated");
  });

  it("replenishes a drained empty queue and continues processing without exiting", async () => {
    process.argv = ["node", "test-runner.ts"];
    listOpenIssuesMock
      .mockResolvedValueOnce([
        { number: 31, title: "Initial", description: "first", state: "open", labels: [] },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { number: 32, title: "Replenished", description: "second", state: "open", labels: [] },
      ])
      .mockResolvedValueOnce([]);
    replenishSelfImprovementIssuesMock.mockResolvedValueOnce({
      created: [{ number: 32, title: "Replenished", description: "second", state: "open", labels: [] }],
    });
    const { main } = await import("./main.js");

    await main();

    expect(replenishSelfImprovementIssuesMock).toHaveBeenCalledWith({ minimumIssueCount: 3, maximumOpenIssues: 5 });
    expect(console.log).toHaveBeenCalledWith(
      "Cycle 2 queue health: open=0 selected=none queueAction=replenish created=1 outcome=continue",
    );
    expect(runCodingAgentMock).toHaveBeenNthCalledWith(1, "Issue #31: Initial\n\nfirst");
    expect(runCodingAgentMock).toHaveBeenNthCalledWith(2, "Issue #32: Replenished\n\nsecond");
  });

  it("replenishes an empty queue mid-run and keeps processing without hitting exit paths", async () => {
    process.argv = ["node", "test-runner.ts"];
    listOpenIssuesMock
      .mockResolvedValueOnce([
        { number: 41, title: "First", description: "one", state: "open", labels: [] },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { number: 42, title: "Second", description: "two", state: "open", labels: [] },
      ])
      .mockResolvedValueOnce([]);
    replenishSelfImprovementIssuesMock.mockResolvedValueOnce({
      created: [{ number: 42, title: "Second", description: "two", state: "open", labels: [] }],
    });
    const { DEFAULT_PROMPT, main } = await import("./main.js");

    await main();

    expect(replenishSelfImprovementIssuesMock).toHaveBeenCalledTimes(2);
    expect(replenishSelfImprovementIssuesMock).toHaveBeenNthCalledWith(1, {
      minimumIssueCount: 3,
      maximumOpenIssues: 5,
    });
    expect(markInProgressMock).toHaveBeenNthCalledWith(1, 41);
    expect(markInProgressMock).toHaveBeenNthCalledWith(2, 42);
    expect(runCodingAgentMock).toHaveBeenNthCalledWith(1, "Issue #41: First\n\none");
    expect(runCodingAgentMock).toHaveBeenNthCalledWith(2, "Issue #42: Second\n\ntwo");
    expect(console.log).toHaveBeenCalledWith(
      "Cycle 2 queue health: open=0 selected=none queueAction=replenish created=1 outcome=continue",
    );
    expect(console.log).not.toHaveBeenCalledWith(DEFAULT_PROMPT);
    const cycleThreeLogIndex = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.findIndex(
      (call) => call[0] === "Cycle 3 queue health: open=1 selected=#42",
    );
    const stopLogIndex = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.findIndex(
      (call) => call[0] === "No actionable open issues remaining and no new issues were created. Issue loop stopped.",
    );
    expect(cycleThreeLogIndex).toBeGreaterThan(-1);
    expect(stopLogIndex).toBeGreaterThan(cycleThreeLogIndex);
  });

  it("falls back cleanly when GitHub credentials are invalid", async () => {
    listOpenIssuesMock.mockRejectedValue(
      new GitHubApiError("GitHub API request failed (401): Bad credentials", 401, null),
    );
    const { DEFAULT_PROMPT, main } = await import("./main.js");

    await main();

    expect(console.error).toHaveBeenCalledWith(
      "GitHub authentication failed. Check GITHUB_TOKEN and make sure it is a valid token for the configured repository.",
    );
    expect(console.log).toHaveBeenCalledWith(DEFAULT_PROMPT);
    expect(runCodingAgentMock).not.toHaveBeenCalled();
  });

  it("retries transient GitHub API failures in the run loop and recovers", async () => {
    process.argv = ["node", "test-runner.ts"];
    listOpenIssuesMock
      .mockRejectedValueOnce(new GitHubApiError("GitHub API request failed (503): Service Unavailable", 503, null))
      .mockResolvedValueOnce([
        { number: 58, title: "Recover after retry", description: "retry once", state: "open", labels: [] },
      ])
      .mockResolvedValueOnce([]);
    const { main } = await import("./main.js");

    await main();

    expect(listOpenIssuesMock).toHaveBeenCalledTimes(3);
    expect(runCodingAgentMock).toHaveBeenCalledWith("Issue #58: Recover after retry\n\nretry once");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Transient GitHub issue sync failure on cycle 1 (attempt 1/2). Retrying in 50ms."),
    );
  });

  it("stops after bounded retries when transient GitHub API failures persist", async () => {
    process.argv = ["node", "test-runner.ts"];
    listOpenIssuesMock.mockRejectedValue(
      new GitHubApiError("GitHub API request failed (503): Service Unavailable", 503, null),
    );
    const { DEFAULT_PROMPT, main } = await import("./main.js");

    await main();

    expect(listOpenIssuesMock).toHaveBeenCalledTimes(3);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Transient GitHub issue sync failure on cycle 1 (attempt 1/2). Retrying in 50ms."),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Transient GitHub issue sync failure on cycle 1 (attempt 2/2). Retrying in 100ms."),
    );
    expect(console.error).toHaveBeenCalledWith(
      "GitHub issue sync unavailable: GitHub API request failed (503): Service Unavailable",
    );
    expect(console.log).toHaveBeenCalledWith(DEFAULT_PROMPT);
    expect(runCodingAgentMock).not.toHaveBeenCalled();
  });

  it("retries transient GitHub rate-limit failures and recovers", async () => {
    process.argv = ["node", "test-runner.ts"];
    listOpenIssuesMock
      .mockRejectedValueOnce(
        new GitHubApiError(
          "GitHub API request failed (403): API rate limit exceeded for user",
          403,
          { message: "API rate limit exceeded for user." },
        ),
      )
      .mockResolvedValueOnce([
        { number: 59, title: "Rate limit recovery", description: "retry 403", state: "open", labels: [] },
      ])
      .mockResolvedValueOnce([]);
    const { main } = await import("./main.js");

    await main();

    expect(listOpenIssuesMock).toHaveBeenCalledTimes(3);
    expect(runCodingAgentMock).toHaveBeenCalledWith("Issue #59: Rate limit recovery\n\nretry 403");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Transient GitHub issue sync failure on cycle 1 (attempt 1/2). Retrying in 50ms."),
    );
  });

  it("does not retry non-transient GitHub 403 failures", async () => {
    process.argv = ["node", "test-runner.ts"];
    listOpenIssuesMock.mockRejectedValue(
      new GitHubApiError("GitHub API request failed (403): Resource not accessible by integration", 403, null),
    );
    const { DEFAULT_PROMPT, main } = await import("./main.js");

    await main();

    expect(listOpenIssuesMock).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(
      "GitHub issue sync unavailable: GitHub API request failed (403): Resource not accessible by integration",
    );
    expect(console.log).toHaveBeenCalledWith(DEFAULT_PROMPT);
    expect(runCodingAgentMock).not.toHaveBeenCalled();
  });

  it("adds a lifecycle issue comment when agent execution fails", async () => {
    listOpenIssuesMock
      .mockResolvedValueOnce([
        { number: 55, title: "Failure path", description: "Failing", state: "open", labels: [] },
      ])
      .mockResolvedValueOnce([]);
    runCodingAgentMock.mockRejectedValueOnce(new Error("boom"));
    const { main } = await import("./main.js");

    await main();

    expect(addProgressCommentMock).toHaveBeenCalledWith(55, expect.stringContaining("## Task Execution Problem"));
  });

  it("logs external repository evidence in the task execution comment", async () => {
    listOpenIssuesMock
      .mockResolvedValueOnce([
        { number: 57, title: "External work", description: "external", state: "open", labels: [] },
      ])
      .mockResolvedValueOnce([]);
    runCodingAgentMock.mockResolvedValueOnce({
      ...DEFAULT_RUN_RESULT,
      summary: {
        ...DEFAULT_RUN_RESULT.summary,
        externalRepositories: ["https://github.com/other-org/other-repo"],
        externalPullRequests: ["https://github.com/other-org/other-repo/pull/12"],
        mergedExternalPullRequest: true,
      },
    });
    const { main } = await import("./main.js");

    await main();

    expect(addProgressCommentMock).toHaveBeenCalledWith(
      57,
      expect.stringContaining("### External Repository Evidence"),
    );
    expect(addProgressCommentMock).toHaveBeenCalledWith(
      57,
      expect.stringContaining("https://github.com/other-org/other-repo/pull/12"),
    );
    expect(addProgressCommentMock).toHaveBeenCalledWith(
      57,
      expect.stringContaining("External pull request merged: yes"),
    );
  });

  it("continues execution when lifecycle comment posting fails", async () => {
    listOpenIssuesMock
      .mockResolvedValueOnce([
        { number: 56, title: "Comment failure", description: "Continue anyway", state: "open", labels: [] },
      ])
      .mockResolvedValueOnce([]);
    addProgressCommentMock.mockRejectedValueOnce(new Error("comment post failed"));
    const { main } = await import("./main.js");

    await main();

    expect(runCodingAgentMock).toHaveBeenCalledWith("Issue #56: Comment failure\n\nContinue anyway");
    expect(console.error).toHaveBeenCalledWith("Could not add lifecycle comment to issue #56: comment post failed");
  });

  it("records challenge metrics for accepted challenge attempts", async () => {
    process.argv = ["node", "test-runner.ts"];
    listOpenIssuesMock
      .mockResolvedValueOnce([
        { number: 88, title: "Challenge pass", description: "solve", state: "open", labels: ["challenge"] },
      ])
      .mockResolvedValueOnce([]);
    runCodingAgentMock.mockResolvedValueOnce({
      ...DEFAULT_RUN_RESULT,
      summary: {
        ...DEFAULT_RUN_RESULT.summary,
        reviewOutcome: "accepted",
      },
    });
    const { main } = await import("./main.js");

    await main();

    expect(persistChallengeAttemptArtifactMock).toHaveBeenCalledWith("/tmp/evolvo", {
      challengeIssueNumber: 88,
      runResult: expect.objectContaining({
        summary: expect.objectContaining({ reviewOutcome: "accepted" }),
      }),
      runError: null,
    });
    expect(recordChallengeAttemptMetricsMock).toHaveBeenCalledWith("/tmp/evolvo", {
      challengeIssueNumber: 88,
      success: true,
      failureCategory: undefined,
    });
    expect(recordChallengeAttemptOutcomeMock).toHaveBeenCalledWith("/tmp/evolvo", {
      challengeIssueNumber: 88,
      success: true,
    });
    expect(updateLabelsMock).toHaveBeenCalledWith(88, {
      remove: ["challenge:failed", "challenge:ready-to-retry", "challenge:blocked", "learning-generated"],
    });
    expect(formatChallengeMetricsReportMock).toHaveBeenCalled();
    expect(addProgressCommentMock).toHaveBeenCalledWith(88, expect.stringContaining("### Challenge Attempt Artifact"));
    expect(addProgressCommentMock).toHaveBeenCalledWith(
      88,
      expect.stringContaining("`.evolvo/challenge-attempts/88/0001.json`"),
    );
    expect(markCompletedMock).toHaveBeenCalledWith(
      88,
      expect.stringContaining("## Challenge Completion"),
    );
    expect(markCompletedMock).toHaveBeenCalledWith(
      88,
      expect.stringContaining("Lifecycle state: terminal success (`completed`)"),
    );
  });

  it("does not mark challenge as completed when review outcome is amended", async () => {
    process.argv = ["node", "test-runner.ts"];
    listOpenIssuesMock
      .mockResolvedValueOnce([
        { number: 92, title: "Challenge amended", description: "needs fixes", state: "open", labels: ["challenge"] },
      ])
      .mockResolvedValueOnce([]);
    runCodingAgentMock.mockResolvedValueOnce({
      ...DEFAULT_RUN_RESULT,
      summary: {
        ...DEFAULT_RUN_RESULT.summary,
        reviewOutcome: "amended",
        failedValidationCommands: [{ command: "pnpm validate", commandName: "pnpm", exitCode: 1, durationMs: 120 }],
      },
    });
    const { main } = await import("./main.js");

    await main();

    expect(markCompletedMock).not.toHaveBeenCalled();
  });

  it("records challenge metrics for challenge runtime failures", async () => {
    process.argv = ["node", "test-runner.ts"];
    listOpenIssuesMock
      .mockResolvedValueOnce([
        { number: 89, title: "Challenge fail", description: "break", state: "open", labels: ["challenge"] },
      ])
      .mockResolvedValueOnce([]);
    runCodingAgentMock.mockRejectedValueOnce(new Error("run blew up"));
    persistChallengeAttemptArtifactMock.mockResolvedValueOnce({
      relativePath: ".evolvo/challenge-attempts/89/0002.json",
      absolutePath: "/tmp/evolvo/.evolvo/challenge-attempts/89/0002.json",
      artifact: {
        attempt: 2,
        outcome: "failure",
        executionSummary: {
          reviewOutcome: null,
        },
        runtimeError: {
          message: "run blew up",
        },
      },
    });
    const { main } = await import("./main.js");

    await main();

    expect(persistChallengeAttemptArtifactMock).toHaveBeenCalledWith("/tmp/evolvo", {
      challengeIssueNumber: 89,
      runResult: null,
      runError: expect.any(Error),
    });
    expect(recordChallengeAttemptMetricsMock).toHaveBeenCalledWith("/tmp/evolvo", {
      challengeIssueNumber: 89,
      success: false,
      failureCategory: "execution_failure",
    });
    expect(updateLabelsMock).toHaveBeenCalledWith(89, {
      add: ["challenge:failed"],
      remove: ["challenge:ready-to-retry", "challenge:blocked"],
    });
    expect(createIssueMock).toHaveBeenCalled();
    expect(createIssueMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("Relates-to-Challenge: #89"),
    );
    expect(addProgressCommentMock).toHaveBeenCalledWith(89, expect.stringContaining("## Challenge Failure Learning"));
    expect(addProgressCommentMock).toHaveBeenCalledWith(89, expect.stringContaining("Failure classification: `execution_failure`"));
    expect(addProgressCommentMock).toHaveBeenCalledWith(89, expect.stringContaining("### Challenge Attempt Artifact"));
    expect(addProgressCommentMock).toHaveBeenCalledWith(
      89,
      expect.stringContaining("`.evolvo/challenge-attempts/89/0002.json`"),
    );
    expect(updateLabelsMock).toHaveBeenCalledWith(89, {
      add: ["learning-generated"],
    });
  });

  it("skips challenge retries when retry gate is not eligible", async () => {
    listOpenIssuesMock.mockResolvedValue([
      { number: 90, title: "Retry gated", description: "gated", state: "open", labels: ["challenge", "challenge:failed"] },
    ]);
    evaluateChallengeRetryEligibilityMock.mockResolvedValue({
      eligible: false,
      reason: "cooldown-active",
      attemptCount: 1,
      cooldownRemainingMs: 1000,
      openCorrectiveIssueNumbers: [],
      addLabels: [],
      removeLabels: [],
    });
    const { main } = await import("./main.js");

    await main();

    expect(runCodingAgentMock).not.toHaveBeenCalled();
    expect(addProgressCommentMock).toHaveBeenCalledWith(90, expect.stringContaining("## Challenge Retry Gate"));
    expect(addProgressCommentMock).toHaveBeenCalledWith(90, expect.stringContaining("Decision: `cooldown-active`"));
  });

  it("allows challenge retry when retry gate is eligible", async () => {
    listOpenIssuesMock
      .mockResolvedValueOnce([
        {
          number: 91,
          title: "Retry allowed",
          description: "allowed",
          state: "open",
          labels: ["challenge", "challenge:failed"],
        },
      ])
      .mockResolvedValueOnce([]);
    evaluateChallengeRetryEligibilityMock.mockResolvedValueOnce({
      eligible: true,
      reason: "ready-to-retry",
      attemptCount: 1,
      cooldownRemainingMs: 0,
      openCorrectiveIssueNumbers: [],
      addLabels: ["challenge:ready-to-retry"],
      removeLabels: [],
    });
    updateLabelsMock.mockResolvedValueOnce({
      ok: true,
      message: "updated",
      issue: {
        number: 91,
        title: "Retry allowed",
        description: "allowed",
        state: "open",
        labels: ["challenge", "challenge:failed", "challenge:ready-to-retry"],
      },
    });
    const { main } = await import("./main.js");

    await main();

    expect(runCodingAgentMock).toHaveBeenCalledWith("Issue #91: Retry allowed\n\nallowed");
  });

  it("does not evaluate retry gate for completed challenge issues", async () => {
    listOpenIssuesMock.mockResolvedValue([
      { number: 93, title: "Done challenge", description: "already done", state: "open", labels: ["challenge", "completed"] },
    ]);
    const { main } = await import("./main.js");

    await main();

    expect(evaluateChallengeRetryEligibilityMock).not.toHaveBeenCalled();
    expect(runCodingAgentMock).not.toHaveBeenCalled();
  });
});
