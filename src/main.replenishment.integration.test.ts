import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runCodingAgentMock = vi.fn();
const runIssueCommandMock = vi.fn();
const getGitHubConfigMock = vi.fn();
const runPostMergeSelfRestartMock = vi.fn();
const generateStartupIssueTemplatesMock = vi.fn();
const recordChallengeAttemptMetricsMock = vi.fn();
const formatChallengeMetricsReportMock = vi.fn();
const evaluateChallengeRetryEligibilityMock = vi.fn();
const recordChallengeAttemptOutcomeMock = vi.fn();
const persistChallengeAttemptArtifactMock = vi.fn();
const transitionCanonicalLifecycleStateMock = vi.fn();
const buildLifecycleStateCommentMock = vi.fn();
const writeRuntimeReadinessSignalMock = vi.fn();

type MockIssue = {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: Array<{ name: string }>;
  pull_request?: unknown;
};

type MockApiState = {
  issues: MockIssue[];
  nextIssueNumber: number;
  createdIssueTitles: string[];
};

const mockApiState: MockApiState = {
  issues: [],
  nextIssueNumber: 100,
  createdIssueTitles: [],
};

function resetMockApiState(): void {
  mockApiState.issues = [
    {
      number: 10,
      title: "Initial work item",
      body: "first pass",
      state: "open",
      labels: [],
    },
  ];
  mockApiState.nextIssueNumber = 11;
  mockApiState.createdIssueTitles = [];
}

function resetMockApiStateToEmptyQueue(): void {
  mockApiState.issues = [];
  mockApiState.nextIssueNumber = 100;
  mockApiState.createdIssueTitles = [];
}

function resetMockApiStateToEmptyQueueWithClosedTitles(titles: string[]): void {
  mockApiState.issues = titles.map((title, index) => ({
    number: index + 1,
    title,
    body: "closed historical issue",
    state: "closed",
    labels: [{ name: "completed" }],
  }));
  mockApiState.nextIssueNumber = 100;
  mockApiState.createdIssueTitles = [];
}

function findIssue(issueNumber: number): MockIssue {
  const issue = mockApiState.issues.find((candidate) => candidate.number === issueNumber);
  if (!issue) {
    throw new Error(`Issue #${issueNumber} not found in fake GitHub API.`);
  }

  return issue;
}

function parseIssueNumberFromPath(path: string): number {
  const match = path.match(/^\/(\d+)(?:\/comments)?$/);
  if (!match) {
    throw new Error(`Unsupported GitHub API path: ${path}`);
  }

  return Number(match[1]);
}

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

vi.mock("./issues/runIssueCommand.js", () => ({
  runIssueCommand: runIssueCommandMock,
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

vi.mock("./github/githubConfig.js", () => ({
  getGitHubConfig: getGitHubConfigMock,
}));

vi.mock("./github/githubClient.js", async () => {
  const actual = await vi.importActual<typeof import("./github/githubClient.js")>("./github/githubClient.js");

  class FakeGitHubClient {
    public async get<T>(path: string): Promise<T> {
      if (path.startsWith("?state=open")) {
        return mockApiState.issues.filter((issue) => issue.state === "open") as T;
      }

      if (path.startsWith("?state=closed")) {
        return mockApiState.issues.filter((issue) => issue.state === "closed") as T;
      }

      if (path.startsWith("/")) {
        return findIssue(parseIssueNumberFromPath(path)) as T;
      }

      throw new Error(`Unsupported GET path in fake GitHub client: ${path}`);
    }

    public async post<T>(path: string, body: { title?: string; body?: string }): Promise<T> {
      if (path === "") {
        const issue: MockIssue = {
          number: mockApiState.nextIssueNumber,
          title: body.title ?? "untitled",
          body: body.body ?? "",
          state: "open",
          labels: [],
        };
        mockApiState.nextIssueNumber += 1;
        mockApiState.issues.push(issue);
        mockApiState.createdIssueTitles.push(issue.title);
        return issue as T;
      }

      if (path.endsWith("/comments")) {
        const issue = findIssue(parseIssueNumberFromPath(path));
        if (body.body?.includes("## Task Execution Log")) {
          issue.state = "closed";
        }
        return {} as T;
      }

      throw new Error(`Unsupported POST path in fake GitHub client: ${path}`);
    }

    public async patch<T>(path: string, body: { labels?: string[]; state?: "open" | "closed" }): Promise<T> {
      const issue = findIssue(parseIssueNumberFromPath(path));
      if (body.labels) {
        issue.labels = body.labels.map((name) => ({ name }));
      }
      if (body.state) {
        issue.state = body.state;
      }
      return issue as T;
    }
  }

  return {
    ...actual,
    GitHubClient: FakeGitHubClient,
  };
});

describe("main replenishment integration", () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.resetModules();
    resetMockApiState();
    runIssueCommandMock.mockReset();
    runIssueCommandMock.mockResolvedValue(false);
    runCodingAgentMock.mockReset();
    runCodingAgentMock
      .mockResolvedValueOnce({
        mergedPullRequest: false,
        summary: {
          inspectedAreas: [],
          editedFiles: [],
          validationCommands: [],
          failedValidationCommands: [],
          reviewOutcome: "accepted",
          pullRequestCreated: false,
          externalRepositories: [],
          externalPullRequests: [],
          mergedExternalPullRequest: false,
          finalResponse: "first complete",
        },
      })
      .mockResolvedValueOnce({
        mergedPullRequest: true,
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
          finalResponse: "second complete",
        },
      });
    runPostMergeSelfRestartMock.mockReset();
    runPostMergeSelfRestartMock.mockResolvedValue(undefined);
    getGitHubConfigMock.mockReset();
    getGitHubConfigMock.mockReturnValue({
      token: "token",
      owner: "owner",
      repo: "repo",
      apiBaseUrl: "https://api.github.com",
    });
    generateStartupIssueTemplatesMock.mockReset();
    generateStartupIssueTemplatesMock.mockResolvedValue([]);
    recordChallengeAttemptMetricsMock.mockReset();
    recordChallengeAttemptMetricsMock.mockResolvedValue({
      total: 0,
      success: 0,
      failure: 0,
      attemptsToSuccess: { total: 0, samples: 0, average: 0 },
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
      relativePath: ".evolvo/challenge-attempts/0/0001.json",
      absolutePath: "/tmp/evolvo/.evolvo/challenge-attempts/0/0001.json",
      artifact: { attempt: 1, outcome: "success", executionSummary: { reviewOutcome: "accepted" }, runtimeError: null },
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

  it("replenishes a drained queue by creating issues and continues processing", async () => {
    const { DEFAULT_PROMPT, main } = await import("./main.js");

    await main();

    expect(mockApiState.createdIssueTitles).toHaveLength(3);
    expect(console.log).toHaveBeenCalledWith(
      "Cycle 2 queue health: open=0 selected=none queueAction=replenish created=3 outcome=continue",
    );
    expect(runCodingAgentMock).toHaveBeenCalledTimes(2);
    expect(runCodingAgentMock).toHaveBeenNthCalledWith(1, "Issue #10: Initial work item\n\nfirst pass");
    const secondPrompt = runCodingAgentMock.mock.calls[1]?.[0];
    expect(secondPrompt).toContain(`Issue #11: ${mockApiState.createdIssueTitles[0]}`);
    expect(console.log).not.toHaveBeenCalledWith(DEFAULT_PROMPT);
    expect(console.log).not.toHaveBeenCalledWith(
      "No actionable open issues remaining and no new issues were created. Issue loop stopped.",
    );
    expect(runPostMergeSelfRestartMock).toHaveBeenCalledWith("/tmp/evolvo");
  });

  it("replenishes a drained queue with follow-up issue titles and keeps processing", async () => {
    resetMockApiState();
    mockApiState.issues.unshift(
      {
        number: 2,
        title: "Add regression test for empty-queue issue replenishment flow",
        body: "already completed once",
        state: "closed",
        labels: [{ name: "completed" }],
      },
      {
        number: 3,
        title: "Add regression test for empty-queue issue replenishment flow (follow-up 1)",
        body: "already completed twice",
        state: "closed",
        labels: [{ name: "completed" }],
      },
    );
    const { DEFAULT_PROMPT, main } = await import("./main.js");

    await main();

    expect(console.log).toHaveBeenCalledWith(
      "Cycle 2 queue health: open=0 selected=none queueAction=replenish created=3 outcome=continue",
    );
    expect(runCodingAgentMock).toHaveBeenCalledTimes(2);
    expect(runCodingAgentMock).toHaveBeenNthCalledWith(1, "Issue #10: Initial work item\n\nfirst pass");
    const secondPrompt = runCodingAgentMock.mock.calls[1]?.[0];
    expect(secondPrompt).toContain(`Issue #11: ${mockApiState.createdIssueTitles[0]}`);
    expect(mockApiState.createdIssueTitles).toContain(
      "Add regression test for empty-queue issue replenishment flow (follow-up 2)",
    );
    const followUpIssue = mockApiState.issues.find(
      (issue) => issue.title === "Add regression test for empty-queue issue replenishment flow (follow-up 2)",
    );
    expect(followUpIssue?.body).toContain("Follow-up: address remaining gaps discovered after earlier work.");
    expect(console.log).not.toHaveBeenCalledWith(DEFAULT_PROMPT);
    expect(console.log).not.toHaveBeenCalledWith(
      "No actionable open issues remaining and no new issues were created. Issue loop stopped.",
    );
    expect(runPostMergeSelfRestartMock).toHaveBeenCalledWith("/tmp/evolvo");
  });

  it("bootstraps startup issues for an empty queue and proceeds into normal issue selection", async () => {
    resetMockApiStateToEmptyQueue();
    generateStartupIssueTemplatesMock.mockResolvedValueOnce([
      { title: "Bootstrap issue A", description: "from startup analysis" },
      { title: "Bootstrap issue B", description: "from startup analysis" },
      { title: "Bootstrap issue C", description: "from startup analysis" },
    ]);
    const { DEFAULT_PROMPT, main } = await import("./main.js");

    await main();

    expect(generateStartupIssueTemplatesMock).toHaveBeenCalledWith("/tmp/evolvo", { targetCount: 3 });
    expect(mockApiState.createdIssueTitles).toEqual([
      "Bootstrap issue A",
      "Bootstrap issue B",
      "Bootstrap issue C",
    ]);
    expect(console.log).toHaveBeenCalledWith(
      "Cycle 1 queue health: open=0 selected=none queueAction=bootstrap created=3 outcome=continue",
    );
    expect(console.log).toHaveBeenCalledWith(
      "No open issues found on startup. Bootstrapped issue queue from repository analysis.",
    );
    expect(console.log).toHaveBeenCalledWith("Cycle 2 queue health: open=3 selected=#100");
    expect(runCodingAgentMock).toHaveBeenCalledTimes(2);
    expect(runCodingAgentMock).toHaveBeenNthCalledWith(1, "Issue #100: Bootstrap issue A\n\nfrom startup analysis");
    expect(console.log).not.toHaveBeenCalledWith(DEFAULT_PROMPT);
    expect(runPostMergeSelfRestartMock).toHaveBeenCalledWith("/tmp/evolvo");
  });

  it("bootstraps follow-up startup issues when matching titles already exist in closed history", async () => {
    resetMockApiStateToEmptyQueueWithClosedTitles([
      "Bootstrap issue A",
      "Bootstrap issue A (follow-up 1)",
    ]);
    generateStartupIssueTemplatesMock.mockResolvedValueOnce([
      { title: "Bootstrap issue A", description: "from startup analysis" },
      { title: "Bootstrap issue B", description: "from startup analysis" },
      { title: "Bootstrap issue C", description: "from startup analysis" },
    ]);
    const { main } = await import("./main.js");

    await main();

    expect(mockApiState.createdIssueTitles).toEqual([
      "Bootstrap issue A (follow-up 2)",
      "Bootstrap issue B",
      "Bootstrap issue C",
    ]);
    expect(console.log).toHaveBeenCalledWith(
      "Cycle 1 queue health: open=0 selected=none queueAction=bootstrap created=3 outcome=continue",
    );
    expect(console.log).toHaveBeenCalledWith("Cycle 2 queue health: open=3 selected=#100");
    expect(runCodingAgentMock).toHaveBeenNthCalledWith(
      1,
      "Issue #100: Bootstrap issue A (follow-up 2)\n\nfrom startup analysis\n\nFollow-up: address remaining gaps discovered after earlier work.",
    );
  });
});
