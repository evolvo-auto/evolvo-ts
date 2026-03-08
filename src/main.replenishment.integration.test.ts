import { promises as fs } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runCodingAgentMock = vi.fn();
const configureCodingAgentExecutionContextMock = vi.fn();
const runPlannerAgentMock = vi.fn();
const generateStartupIssueTemplatesMock = vi.fn();
const runIssueCommandMock = vi.fn();
const getGitHubConfigMock = vi.fn();
const runPostMergeSelfRestartMock = vi.fn();
const recordChallengeAttemptMetricsMock = vi.fn();
const formatChallengeMetricsReportMock = vi.fn();
const evaluateChallengeRetryEligibilityMock = vi.fn();
const recordChallengeAttemptOutcomeMock = vi.fn();
const persistChallengeAttemptArtifactMock = vi.fn();
const transitionCanonicalLifecycleStateMock = vi.fn();
const buildLifecycleStateCommentMock = vi.fn();
const writeRuntimeReadinessSignalMock = vi.fn();
const tryResolveRepositoryDefaultBranchMock = vi.fn();
const ensureProjectRegistryMock = vi.fn();
const readProjectRegistryMock = vi.fn();
const readActiveProjectStateMock = vi.fn();
const readActiveProjectsStateMock = vi.fn();
const activateProjectInStateMock = vi.fn();
const deactivateProjectInStateMock = vi.fn();
const stopActiveProjectStateMock = vi.fn();
const clearActiveProjectStateMock = vi.fn();
const resolveProjectExecutionContextForIssueMock = vi.fn();
const buildProjectRoutingBlockedCommentMock = vi.fn();
const buildUnifiedIssueQueueMock = vi.fn();
const selectIssueForWorkWithOpenAiMock = vi.fn();
const ensureProjectBoardsForRegistryMock = vi.fn();

const TEST_WORK_DIR = "/tmp/evolvo";
const TEST_STATE_DIR = `${TEST_WORK_DIR}/.evolvo`;
const DISABLED_OPERATOR_ENV_KEYS = [
  "DISCORD_BOT_TOKEN",
  "DISCORD_CONTROL_GUILD_ID",
  "DISCORD_CONTROL_CHANNEL_ID",
  "DISCORD_OPERATOR_USER_ID",
  "DISCORD_OPERATOR_TIMEOUT_MS",
  "DISCORD_OPERATOR_POLL_INTERVAL_MS",
  "DISCORD_CYCLE_EXTENSION",
  "EVOLVO_RESTART_TOKEN",
  "EVOLVO_READINESS_FILE",
] as const;
const originalOperatorEnv = new Map(
  DISABLED_OPERATOR_ENV_KEYS.map((key) => [key, process.env[key]]),
);

type MockIssue = {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: Array<{ name: string }>;
  user?: { login?: string | null };
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

function withApprovedAuthor<T extends MockIssue>(issue: T): T & { user: { login: string } } {
  return {
    ...issue,
    user: {
      login: issue.user?.login?.trim() || "evolvo-auto",
    },
  };
}

async function resetRuntimeState(): Promise<void> {
  await fs.mkdir(TEST_WORK_DIR, { recursive: true });
  await fs.rm(TEST_STATE_DIR, { recursive: true, force: true });
}

function disableOperatorEnv(): void {
  for (const key of DISABLED_OPERATOR_ENV_KEYS) {
    delete process.env[key];
  }
}

function restoreOperatorEnv(): void {
  for (const key of DISABLED_OPERATOR_ENV_KEYS) {
    const value = originalOperatorEnv.get(key);
    if (typeof value === "string") {
      process.env[key] = value;
      continue;
    }

    delete process.env[key];
  }
}

vi.mock("./environment.js", () => ({
  GITHUB_OWNER: "owner",
  GITHUB_REPO: "repo",
  OPENAI_API_KEY: "test-openai-key",
}));

vi.mock("./constants/workDir.js", () => ({
  WORK_DIR: "/tmp/evolvo",
}));

vi.mock("./agents/runCodingAgent.js", () => ({
  configureCodingAgentExecutionContext: configureCodingAgentExecutionContextMock,
  runCodingAgent: runCodingAgentMock,
}));

vi.mock("./agents/plannerAgent.js", () => ({
  runPlannerAgent: runPlannerAgentMock,
}));

vi.mock("./issues/runIssueCommand.js", () => ({
  runIssueCommand: runIssueCommandMock,
}));

vi.mock("./runtime/selfRestart.js", () => ({
  runPostMergeSelfRestart: runPostMergeSelfRestartMock,
}));

vi.mock("./runtime/defaultBranch.js", () => ({
  buildMergedPullRequestReason: (defaultBranch: string | null | undefined) =>
    defaultBranch && defaultBranch.trim().length > 0
      ? `pull request merged into ${defaultBranch.trim()}`
      : "pull request merged into repository default branch",
  describeRepositoryDefaultBranch: (defaultBranch: string | null | undefined) =>
    defaultBranch && defaultBranch.trim().length > 0
      ? `\`${defaultBranch.trim()}\``
      : "the repository default branch",
  tryResolveRepositoryDefaultBranch: tryResolveRepositoryDefaultBranchMock,
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

vi.mock("./projects/projectBoards.js", () => ({
  ensureProjectBoardsForRegistry: ensureProjectBoardsForRegistryMock,
}));

vi.mock("./projects/projectRegistry.js", () => ({
  buildDefaultProjectContext: (context: {
    owner: string;
    repo: string;
    workDir: string;
    defaultBranch?: string | null;
  }) => ({
    owner: context.owner,
    repo: context.repo,
    workDir: context.workDir,
    defaultBranch: context.defaultBranch ?? null,
  }),
  ensureProjectRegistry: ensureProjectRegistryMock,
  readProjectRegistry: readProjectRegistryMock,
  findProjectBySlug: (registry: { projects: Array<{ slug: string }> }, slug: string) =>
    registry.projects.find((project) => project.slug === slug) ?? null,
}));

vi.mock("./projects/activeProjectState.js", () => ({
  clearActiveProjectState: clearActiveProjectStateMock,
  readActiveProjectState: readActiveProjectStateMock,
  stopActiveProjectState: stopActiveProjectStateMock,
}));

vi.mock("./projects/activeProjectsState.js", () => ({
  activateProjectInState: activateProjectInStateMock,
  deactivateProjectInState: deactivateProjectInStateMock,
  readActiveProjectsState: readActiveProjectsStateMock,
}));

vi.mock("./projects/projectExecutionContext.js", () => ({
  PROJECT_ROUTING_BLOCKED_LABEL: "blocked",
  buildProjectRoutingBlockedComment: buildProjectRoutingBlockedCommentMock,
  buildProjectExecutionContext: (project: {
    trackerRepo: { owner: string; repo: string };
    executionRepo: { owner: string; repo: string };
  }) => ({
    project,
    trackerRepository: `${project.trackerRepo.owner}/${project.trackerRepo.repo}`,
    executionRepository: `${project.executionRepo.owner}/${project.executionRepo.repo}`,
  }),
  resolveProjectExecutionContextForIssue: resolveProjectExecutionContextForIssueMock,
}));

vi.mock("./issues/unifiedIssueQueue.js", () => ({
  buildUnifiedIssueQueue: buildUnifiedIssueQueueMock,
}));

vi.mock("./agents/issueSelectionOpenAi.js", () => ({
  selectIssueForWorkWithOpenAi: selectIssueForWorkWithOpenAiMock,
}));

vi.mock("./github/githubConfig.js", () => ({
  getGitHubConfig: getGitHubConfigMock,
}));

vi.mock("./github/githubClient.js", async () => {
  const actual = await vi.importActual<typeof import("./github/githubClient.js")>("./github/githubClient.js");

  class FakeGitHubClient {
    public async get<T>(path: string): Promise<T> {
      if (path.startsWith("?state=open")) {
        return mockApiState.issues
          .filter((issue) => issue.state === "open")
          .map((issue) => withApprovedAuthor(issue)) as T;
      }

      if (path.startsWith("?state=closed")) {
        return mockApiState.issues
          .filter((issue) => issue.state === "closed")
          .map((issue) => withApprovedAuthor(issue)) as T;
      }

      if (path.startsWith("/")) {
        return withApprovedAuthor(findIssue(parseIssueNumberFromPath(path))) as T;
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
          user: { login: "evolvo-auto" },
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

    public async getApi<T>(path: string): Promise<T> {
      const normalized = path.replace(/^\/repos\/[^/]+\/[^/]+\/issues/, "");
      return this.get<T>(normalized);
    }

    public async postApi<T>(path: string, body: { title?: string; body?: string }): Promise<T> {
      const normalized = path.replace(/^\/repos\/[^/]+\/[^/]+\/issues/, "");
      return this.post<T>(normalized, body);
    }

    public async patchApi<T>(path: string, body: { labels?: string[]; state?: "open" | "closed" }): Promise<T> {
      const normalized = path.replace(/^\/repos\/[^/]+\/[^/]+\/issues/, "");
      return this.patch<T>(normalized, body);
    }
  }

  return {
    ...actual,
    GitHubClient: FakeGitHubClient,
  };
});

describe("main replenishment integration", () => {
  const originalArgv = process.argv;

  beforeEach(async () => {
    vi.resetModules();
    await resetRuntimeState();
    disableOperatorEnv();
    resetMockApiState();
    runIssueCommandMock.mockReset();
    runIssueCommandMock.mockResolvedValue(false);
    runCodingAgentMock.mockReset();
    configureCodingAgentExecutionContextMock.mockReset();
    configureCodingAgentExecutionContextMock.mockImplementation(() => undefined);
    ensureProjectBoardsForRegistryMock.mockReset();
    ensureProjectBoardsForRegistryMock.mockResolvedValue({
      registry: {
        version: 1,
        projects: [],
      },
      results: [],
    });
    runPlannerAgentMock.mockReset();
    generateStartupIssueTemplatesMock.mockReset();
    generateStartupIssueTemplatesMock.mockResolvedValue([]);
    buildUnifiedIssueQueueMock.mockReset();
    buildUnifiedIssueQueueMock.mockImplementation(async () => ({
      issues: mockApiState.issues
        .filter((issue) => issue.state === "open")
        .map((issue) => ({
          number: issue.number,
          title: issue.title,
          description: issue.body,
          state: issue.state,
          labels: issue.labels.map((label) => label.name),
          queueKey: `tracker:owner/repo#${issue.number}`,
          sourceKind: "tracker",
          projectSlug: null,
          repository: {
            owner: "owner",
            repo: "repo",
            url: "https://github.com/owner/repo",
            reference: "owner/repo",
          },
          project: null,
        })),
      unauthorizedClosures: [],
      activeManagedProject: null,
    }));
    selectIssueForWorkWithOpenAiMock.mockReset();
    selectIssueForWorkWithOpenAiMock.mockImplementation(async (options: {
      issues: import("./issues/unifiedIssueQueue.js").UnifiedIssue[];
      activeProjectSlug?: string | null;
      stoppedProjectSlug?: string | null;
    }) => {
      const { prioritizeIssuesForWork } = await import("./runtime/loopUtils.js");
      return prioritizeIssuesForWork(options.issues, {
        activeProjectSlug: options.activeProjectSlug,
        stoppedProjectSlug: options.stoppedProjectSlug,
      });
    });
    runPlannerAgentMock.mockImplementation(async (input: {
      cycle: number;
      openIssueCount: number;
      minimumIssueCount: number;
      workDir: string;
      issueManager: {
        createIssue: (title: string, description: string) => Promise<{
          issue?: import("./issues/taskIssueManager.js").IssueSummary;
        }>;
      };
    }) => {
      const startupBootstrap = input.cycle === 1 && input.openIssueCount === 0;
      const templates = await generateStartupIssueTemplatesMock(input.workDir, {
        targetCount: input.minimumIssueCount,
      });
      const created: import("./issues/taskIssueManager.js").IssueSummary[] = [];
      for (const template of templates) {
        const result = await input.issueManager.createIssue(template.title, template.description);
        if (result.issue) {
          created.push(result.issue);
        }
      }
      return { created, startupBootstrap };
    });
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
    tryResolveRepositoryDefaultBranchMock.mockReset();
    tryResolveRepositoryDefaultBranchMock.mockResolvedValue("main");
    ensureProjectRegistryMock.mockReset();
    ensureProjectRegistryMock.mockResolvedValue({
      version: 1,
      projects: [
        {
          slug: "evolvo",
          displayName: "Evolvo",
          kind: "default",
          issueLabel: "project:evolvo",
          trackerRepo: {
            owner: "owner",
            repo: "repo",
            url: "https://github.com/owner/repo",
          },
          executionRepo: {
            owner: "owner",
            repo: "repo",
            url: "https://github.com/owner/repo",
            defaultBranch: "main",
          },
          cwd: "/tmp/evolvo",
          status: "active",
          sourceIssueNumber: null,
          createdAt: "2026-03-07T12:00:00.000Z",
          updatedAt: "2026-03-07T12:00:00.000Z",
          provisioning: {
            labelCreated: false,
            repoCreated: true,
            workspacePrepared: true,
            lastError: null,
          },
        },
      ],
    });
    readProjectRegistryMock.mockReset();
    readProjectRegistryMock.mockResolvedValue({
      version: 1,
      projects: [
        {
          slug: "evolvo",
          displayName: "Evolvo",
          kind: "default",
          issueLabel: "project:evolvo",
          trackerRepo: {
            owner: "owner",
            repo: "repo",
            url: "https://github.com/owner/repo",
          },
          executionRepo: {
            owner: "owner",
            repo: "repo",
            url: "https://github.com/owner/repo",
            defaultBranch: "main",
          },
          cwd: "/tmp/evolvo",
          status: "active",
          sourceIssueNumber: null,
          createdAt: "2026-03-07T12:00:00.000Z",
          updatedAt: "2026-03-07T12:00:00.000Z",
          provisioning: {
            labelCreated: false,
            repoCreated: true,
            workspacePrepared: true,
            lastError: null,
          },
        },
      ],
    });
    readActiveProjectStateMock.mockReset();
    readActiveProjectStateMock.mockResolvedValue({
      version: 2,
      activeProjectSlug: null,
      selectionState: null,
      deferredStopMode: null,
      updatedAt: null,
      requestedBy: null,
      source: null,
    });
    readActiveProjectsStateMock.mockReset();
    readActiveProjectsStateMock.mockResolvedValue({
      version: 1,
      projects: [],
    });
    activateProjectInStateMock.mockReset();
    activateProjectInStateMock.mockResolvedValue({
      version: 1,
      projects: [],
    });
    deactivateProjectInStateMock.mockReset();
    deactivateProjectInStateMock.mockResolvedValue({
      version: 1,
      projects: [],
    });
    stopActiveProjectStateMock.mockReset();
    stopActiveProjectStateMock.mockResolvedValue({
      status: "no-active-project",
      state: {
        version: 2,
        activeProjectSlug: null,
        selectionState: null,
        deferredStopMode: null,
        updatedAt: null,
        requestedBy: null,
        source: null,
      },
    });
    clearActiveProjectStateMock.mockReset();
    clearActiveProjectStateMock.mockResolvedValue({
      version: 2,
      activeProjectSlug: null,
      selectionState: null,
      deferredStopMode: null,
      updatedAt: null,
      requestedBy: null,
      source: null,
    });
    resolveProjectExecutionContextForIssueMock.mockReset();
    resolveProjectExecutionContextForIssueMock.mockResolvedValue({
      ok: true,
      context: {
        project: {
          slug: "evolvo",
          displayName: "Evolvo",
          kind: "default",
          issueLabel: "project:evolvo",
          trackerRepo: {
            owner: "owner",
            repo: "repo",
            url: "https://github.com/owner/repo",
          },
          executionRepo: {
            owner: "owner",
            repo: "repo",
            url: "https://github.com/owner/repo",
            defaultBranch: "main",
          },
          cwd: "/tmp/evolvo",
          status: "active",
          sourceIssueNumber: null,
          createdAt: "2026-03-07T12:00:00.000Z",
          updatedAt: "2026-03-07T12:00:00.000Z",
          provisioning: {
            labelCreated: false,
            repoCreated: true,
            workspacePrepared: true,
            lastError: null,
          },
        },
        trackerRepository: "owner/repo",
        executionRepository: "owner/repo",
      },
    });
    buildProjectRoutingBlockedCommentMock.mockReset();
    buildProjectRoutingBlockedCommentMock.mockReturnValue("## Project Routing Blocked");
    getGitHubConfigMock.mockReset();
    getGitHubConfigMock.mockReturnValue({
      token: "token",
      owner: "owner",
      repo: "repo",
      apiBaseUrl: "https://api.github.com",
    });
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

  afterEach(async () => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
    restoreOperatorEnv();
    await resetRuntimeState();
  });

  it("replenishes a drained queue by creating issues and continues processing", async () => {
    generateStartupIssueTemplatesMock.mockResolvedValueOnce([
      { title: "Generated A", description: "desc A" },
      { title: "Generated B", description: "desc B" },
      { title: "Generated C", description: "desc C" },
    ]);
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
  }, 10000);

  it("replenishes a completed-only open queue and continues processing without exiting", async () => {
    mockApiState.issues = [
      {
        number: 90,
        title: "Already done",
        body: "completed work item",
        state: "open",
        labels: [{ name: "completed" }],
      },
    ];
    mockApiState.nextIssueNumber = 100;
    mockApiState.createdIssueTitles = [];
    generateStartupIssueTemplatesMock.mockResolvedValueOnce([
      { title: "Generated A", description: "desc A" },
      { title: "Generated B", description: "desc B" },
      { title: "Generated C", description: "desc C" },
    ]);
    const { DEFAULT_PROMPT, main } = await import("./main.js");

    await main();

    expect(mockApiState.createdIssueTitles).toHaveLength(3);
    expect(console.log).toHaveBeenCalledWith(
      "Cycle 1 queue health: open=1 selected=none queueAction=replenish created=3 outcome=continue",
    );
    expect(runCodingAgentMock).toHaveBeenCalledTimes(2);
    const firstPrompt = runCodingAgentMock.mock.calls[0]?.[0];
    expect(firstPrompt).toContain(`Issue #100: ${mockApiState.createdIssueTitles[0]}`);
    expect(console.log).not.toHaveBeenCalledWith(DEFAULT_PROMPT);
    expect(console.log).not.toHaveBeenCalledWith(
      "No actionable open issues remaining and no new issues were created. Issue loop stopped.",
    );
    expect(runPostMergeSelfRestartMock).toHaveBeenCalledWith("/tmp/evolvo");
  });

  it("stops creating replenishment issues when mid-run repository analysis fails", async () => {
    const { DEFAULT_PROMPT, main } = await import("./main.js");
    generateStartupIssueTemplatesMock.mockRejectedValueOnce(new Error("analysis unavailable mid-run"));

    await main();

    expect(generateStartupIssueTemplatesMock).toHaveBeenCalledWith("/tmp/evolvo", { targetCount: 3 });
    expect(console.error).toHaveBeenCalledWith(
      "GitHub issue sync unavailable: analysis unavailable mid-run",
    );
    expect(mockApiState.createdIssueTitles).toHaveLength(0);
    expect(runCodingAgentMock).toHaveBeenCalledTimes(1);
    expect(console.log).not.toHaveBeenCalledWith(DEFAULT_PROMPT);
    expect(runPostMergeSelfRestartMock).not.toHaveBeenCalled();
  });

  it("replenishes a drained queue with exact new titles and keeps processing", async () => {
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
    generateStartupIssueTemplatesMock.mockResolvedValueOnce([
      { title: "Add regression test for empty-queue issue replenishment flow", description: "from analysis" },
      { title: "Generated B", description: "desc B" },
      { title: "Generated C", description: "desc C" },
    ]);
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
      "Add regression test for empty-queue issue replenishment flow",
    );
    expect(console.log).not.toHaveBeenCalledWith(DEFAULT_PROMPT);
    expect(console.log).not.toHaveBeenCalledWith(
      "No actionable open issues remaining and no new issues were created. Issue loop stopped.",
    );
    expect(runPostMergeSelfRestartMock).toHaveBeenCalledWith("/tmp/evolvo");
  }, 10000);

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

  it("bootstraps exact startup issues even when matching titles exist in closed history", async () => {
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

    expect(mockApiState.createdIssueTitles).toEqual(["Bootstrap issue A", "Bootstrap issue B", "Bootstrap issue C"]);
    expect(console.log).toHaveBeenCalledWith(
      "Cycle 1 queue health: open=0 selected=none queueAction=bootstrap created=3 outcome=continue",
    );
    expect(console.log).toHaveBeenCalledWith("Cycle 2 queue health: open=3 selected=#100");
    expect(runCodingAgentMock).toHaveBeenNthCalledWith(1, "Issue #100: Bootstrap issue A\n\nfrom startup analysis");
  });

  it("stops startup bootstrapping when analysis fails", async () => {
    resetMockApiStateToEmptyQueue();
    generateStartupIssueTemplatesMock.mockRejectedValueOnce(new Error("analysis unavailable"));
    const { DEFAULT_PROMPT, main } = await import("./main.js");

    await main();

    expect(console.error).toHaveBeenCalledWith("GitHub issue sync unavailable: analysis unavailable");
    expect(mockApiState.createdIssueTitles).toHaveLength(0);
    expect(runCodingAgentMock).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(DEFAULT_PROMPT);
    expect(runPostMergeSelfRestartMock).not.toHaveBeenCalled();
  });
});
