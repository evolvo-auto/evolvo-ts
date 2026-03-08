import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubApiError } from "./github/githubClient.js";

const runCodingAgentMock = vi.fn();
const runPlannerAgentMock = vi.fn();
const generateStartupIssueTemplatesMock = vi.fn();
const replenishSelfImprovementIssuesMock = vi.fn();
const runIssueCommandMock = vi.fn();
const getGitHubConfigMock = vi.fn();
const listOpenIssuesMock = vi.fn();
const unauthorizedIssueClosuresMock = vi.fn();
const markInProgressMock = vi.fn();
const markCompletedMock = vi.fn();
const addProgressCommentMock = vi.fn();
const closeIssueMock = vi.fn();
const runPostMergeSelfRestartMock = vi.fn();
const readChallengeMetricsMock = vi.fn();
const recordChallengeAttemptMetricsMock = vi.fn();
const formatChallengeMetricsReportMock = vi.fn();
const writeChallengeMetricsMock = vi.fn();
const evaluateChallengeRetryEligibilityMock = vi.fn();
const recordChallengeAttemptOutcomeMock = vi.fn();
const persistChallengeAttemptArtifactMock = vi.fn();
const updateLabelsMock = vi.fn();
const createIssueMock = vi.fn();
const transitionCanonicalLifecycleStateMock = vi.fn();
const buildLifecycleStateCommentMock = vi.fn();
const writeRuntimeReadinessSignalMock = vi.fn();
const requestCycleLimitDecisionFromOperatorMock = vi.fn();
const runDiscordOperatorControlStartupCheckMock = vi.fn();
const notifyCycleLimitDecisionAppliedInDiscordMock = vi.fn();
const notifyDeferredProjectStopTriggeredInDiscordMock = vi.fn();
const notifyIssueStartedInDiscordMock = vi.fn();
const notifyRuntimeQuittingInDiscordMock = vi.fn();
const pollDiscordGracefulShutdownCommandMock = vi.fn();
const startDiscordGracefulShutdownListenerMock = vi.fn();
const stopDiscordGracefulShutdownListenerMock = vi.fn();
const readGracefulShutdownRequestMock = vi.fn();
const markGracefulShutdownRequestEnforcedMock = vi.fn();
const tryResolveRepositoryDefaultBranchMock = vi.fn();
const configureCodingAgentExecutionContextMock = vi.fn();
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
const inspectProjectRepositoryIssuesMock = vi.fn();
const buildProjectRepositoryIssueInspectionLogLinesMock = vi.fn();
const buildProjectRepositoryIssuePromptSectionMock = vi.fn();
const handleStartProjectCommandMock = vi.fn();
const executeProjectProvisioningIssueMock = vi.fn();
const isProjectProvisioningRequestIssueMock = vi.fn();
const buildProjectProvisioningOutcomeCommentMock = vi.fn();
const buildProjectProvisioningCompletionSummaryMock = vi.fn();
const buildUnifiedIssueQueueMock = vi.fn();
const selectIssueForWorkWithOpenAiMock = vi.fn();

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

const DEFAULT_PROJECT_EXECUTION_CONTEXT = {
  project: {
    slug: "evolvo",
    displayName: "Evolvo",
    kind: "default" as const,
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
    status: "active" as const,
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
};

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
  readChallengeMetrics: readChallengeMetricsMock,
  recordChallengeAttemptMetrics: recordChallengeAttemptMetricsMock,
  formatChallengeMetricsReport: formatChallengeMetricsReportMock,
  writeChallengeMetrics: writeChallengeMetricsMock,
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

vi.mock("./runtime/gracefulShutdown.js", () => ({
  markGracefulShutdownRequestEnforced: markGracefulShutdownRequestEnforcedMock,
  readGracefulShutdownRequest: readGracefulShutdownRequestMock,
}));

vi.mock("./runtime/operatorControl.js", () => ({
  notifyCycleLimitDecisionAppliedInDiscord: notifyCycleLimitDecisionAppliedInDiscordMock,
  notifyDeferredProjectStopTriggeredInDiscord: notifyDeferredProjectStopTriggeredInDiscordMock,
  notifyIssueStartedInDiscord: notifyIssueStartedInDiscordMock,
  notifyRuntimeQuittingInDiscord: notifyRuntimeQuittingInDiscordMock,
  pollDiscordGracefulShutdownCommand: pollDiscordGracefulShutdownCommandMock,
  requestCycleLimitDecisionFromOperator: requestCycleLimitDecisionFromOperatorMock,
  runDiscordOperatorControlStartupCheck: runDiscordOperatorControlStartupCheckMock,
  startDiscordGracefulShutdownListener: startDiscordGracefulShutdownListenerMock,
}));

vi.mock("./projects/projectProvisioning.js", () => ({
  buildProjectProvisioningCompletionSummary: buildProjectProvisioningCompletionSummaryMock,
  buildProjectProvisioningOutcomeComment: buildProjectProvisioningOutcomeCommentMock,
  executeProjectProvisioningIssue: executeProjectProvisioningIssueMock,
  handleStartProjectCommand: handleStartProjectCommandMock,
  isProjectProvisioningRequestIssue: isProjectProvisioningRequestIssueMock,
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

vi.mock("./projects/projectRepositoryIssues.js", () => ({
  ProjectRepositoryIssueInspector: class {
    inspectProject = inspectProjectRepositoryIssuesMock;
  },
  buildProjectRepositoryIssueInspectionLogLines: buildProjectRepositoryIssueInspectionLogLinesMock,
  buildProjectRepositoryIssuePromptSection: buildProjectRepositoryIssuePromptSectionMock,
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
    listAuthorizedOpenIssues = async () => ({
      issues: await listOpenIssuesMock(),
      unauthorizedClosures: await unauthorizedIssueClosuresMock(),
    });
    listOpenIssues = listOpenIssuesMock;
    markInProgress = markInProgressMock;
    markCompleted = markCompletedMock;
    addProgressComment = addProgressCommentMock;
    closeIssue = closeIssueMock;
    updateLabels = updateLabelsMock;
    createIssue = createIssueMock;
    forRepository = () => this;
  },
}));

vi.mock("./issues/unifiedIssueQueue.js", () => ({
  buildUnifiedIssueQueue: buildUnifiedIssueQueueMock,
}));

vi.mock("./agents/issueSelectionOpenAi.js", () => ({
  selectIssueForWorkWithOpenAi: selectIssueForWorkWithOpenAiMock,
}));

describe("main", () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.EVOLVO_RESTART_TOKEN;
    delete process.env.EVOLVO_READINESS_FILE;
    runCodingAgentMock.mockReset();
    runCodingAgentMock.mockResolvedValue(DEFAULT_RUN_RESULT);
    configureCodingAgentExecutionContextMock.mockReset();
    configureCodingAgentExecutionContextMock.mockImplementation(() => undefined);
    runPlannerAgentMock.mockReset();
    generateStartupIssueTemplatesMock.mockReset();
    generateStartupIssueTemplatesMock.mockResolvedValue([]);
    replenishSelfImprovementIssuesMock.mockReset();
    replenishSelfImprovementIssuesMock.mockResolvedValue({ created: [] });
    buildUnifiedIssueQueueMock.mockReset();
    buildUnifiedIssueQueueMock.mockImplementation(async () => ({
      issues: (await listOpenIssuesMock()).map((issue: {
        number: number;
        title: string;
        description: string;
        state: "open" | "closed";
        labels: string[];
      }) => ({
        ...issue,
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
      unauthorizedClosures: await unauthorizedIssueClosuresMock(),
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
      maximumOpenIssues: number;
      workDir: string;
    }) => {
      const startupBootstrap = input.cycle === 1 && input.openIssueCount === 0;
      const templates = await generateStartupIssueTemplatesMock(input.workDir, {
        targetCount: input.minimumIssueCount,
      });
      const replenishment = await replenishSelfImprovementIssuesMock({
        minimumIssueCount: input.minimumIssueCount,
        maximumOpenIssues: input.maximumOpenIssues,
        templates,
      });
      return {
        created: replenishment.created ?? [],
        startupBootstrap,
      };
    });
    runPostMergeSelfRestartMock.mockReset();
    runPostMergeSelfRestartMock.mockResolvedValue(undefined);
    tryResolveRepositoryDefaultBranchMock.mockReset();
    tryResolveRepositoryDefaultBranchMock.mockResolvedValue("main");
    handleStartProjectCommandMock.mockReset();
    handleStartProjectCommandMock.mockResolvedValue({
      ok: true,
      action: "created",
      message: "Created provisioning issue #400 for project `habit-cli`.",
      project: {
        displayName: "Habit CLI",
        slug: "habit-cli",
        repositoryName: "habit-cli",
        workspacePath: "/home/paddy/habit-cli",
        status: "provisioning",
      },
      trackerIssue: {
        number: 400,
        url: "https://github.com/owner/repo/issues/400",
        alreadyOpen: false,
      },
    });
    executeProjectProvisioningIssueMock.mockReset();
    executeProjectProvisioningIssueMock.mockResolvedValue({
      ok: true,
      metadata: {
        owner: "owner",
        displayName: "Habit CLI",
        slug: "habit-cli",
        repositoryName: "habit-cli",
        issueLabel: "project:habit-cli",
        workspacePath: "/home/paddy/habit-cli",
        requestedBy: "discord:operator-1",
        requestedAt: "2026-03-07T12:00:00.000Z",
      },
      record: {
        slug: "habit-cli",
        displayName: "Habit CLI",
        kind: "managed",
        issueLabel: "project:habit-cli",
        trackerRepo: {
          owner: "owner",
          repo: "repo",
          url: "https://github.com/owner/repo",
        },
        executionRepo: {
          owner: "owner",
          repo: "habit-cli",
          url: "https://github.com/owner/habit-cli",
          defaultBranch: "main",
        },
        cwd: "/home/paddy/habit-cli",
        status: "active",
        sourceIssueNumber: 400,
        createdAt: "2026-03-07T12:00:00.000Z",
        updatedAt: "2026-03-07T12:00:00.000Z",
        provisioning: {
          labelCreated: true,
          repoCreated: true,
          workspacePrepared: true,
          lastError: null,
        },
      },
      failureStep: null,
      workspaceAction: "created",
      message: "Provisioned project Habit CLI.",
    });
    isProjectProvisioningRequestIssueMock.mockReset();
    isProjectProvisioningRequestIssueMock.mockReturnValue(false);
    buildProjectProvisioningOutcomeCommentMock.mockReset();
    buildProjectProvisioningOutcomeCommentMock.mockReturnValue("## Project Provisioning");
    buildProjectProvisioningCompletionSummaryMock.mockReset();
    buildProjectProvisioningCompletionSummaryMock.mockReturnValue("Provisioning complete summary");
    ensureProjectRegistryMock.mockReset();
    ensureProjectRegistryMock.mockResolvedValue({ version: 1, projects: [DEFAULT_PROJECT_EXECUTION_CONTEXT.project] });
    readProjectRegistryMock.mockReset();
    readProjectRegistryMock.mockResolvedValue({ version: 1, projects: [DEFAULT_PROJECT_EXECUTION_CONTEXT.project] });
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
    stopActiveProjectStateMock.mockReset();
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
      status: "stopped",
      state: {
        version: 2,
        activeProjectSlug: "habit-cli",
        selectionState: "stopped",
        deferredStopMode: null,
        updatedAt: "2026-03-08T10:00:00.000Z",
        requestedBy: "discord:operator-1",
        source: "stop-project-command",
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
      context: DEFAULT_PROJECT_EXECUTION_CONTEXT,
    });
    buildProjectRoutingBlockedCommentMock.mockReset();
    buildProjectRoutingBlockedCommentMock.mockReturnValue("## Project Routing Blocked");
    inspectProjectRepositoryIssuesMock.mockReset();
    inspectProjectRepositoryIssuesMock.mockResolvedValue({
      projectSlug: "habit-cli",
      repository: {
        owner: "owner",
        repo: "habit-cli",
        reference: "owner/habit-cli",
        url: "https://github.com/owner/habit-cli",
      },
      openIssues: [],
      recentClosedIssues: [],
    });
    buildProjectRepositoryIssueInspectionLogLinesMock.mockReset();
    buildProjectRepositoryIssueInspectionLogLinesMock.mockReturnValue([
      "[project-issues] inspected project=habit-cli repository=owner/habit-cli open=0 recentClosed=0",
    ]);
    buildProjectRepositoryIssuePromptSectionMock.mockReset();
    buildProjectRepositoryIssuePromptSectionMock.mockImplementation((state: { repository: { reference: string } }) => [
      "## Project Repository Issue State",
      `- Project repository: ${state.repository.reference}`,
    ].join("\n"));
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
    unauthorizedIssueClosuresMock.mockReset();
    unauthorizedIssueClosuresMock.mockResolvedValue([]);
    markInProgressMock.mockReset();
    markInProgressMock.mockResolvedValue({ ok: true, message: "ok" });
    markCompletedMock.mockReset();
    markCompletedMock.mockResolvedValue({ ok: true, message: "completed" });
    addProgressCommentMock.mockReset();
    addProgressCommentMock.mockResolvedValue({ ok: true, message: "commented" });
    closeIssueMock.mockReset();
    closeIssueMock.mockResolvedValue({ ok: true, message: "closed" });
    readChallengeMetricsMock.mockReset();
    readChallengeMetricsMock.mockResolvedValue({
      total: 0,
      success: 0,
      failure: 0,
      attemptsToSuccess: { total: 0, samples: 0, average: 0 },
      categoryCounts: {},
      pendingAttemptsByChallenge: {},
    });
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
    writeChallengeMetricsMock.mockReset();
    writeChallengeMetricsMock.mockResolvedValue(undefined);
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
    readGracefulShutdownRequestMock.mockReset();
    readGracefulShutdownRequestMock.mockResolvedValue(null);
    markGracefulShutdownRequestEnforcedMock.mockReset();
    markGracefulShutdownRequestEnforcedMock.mockImplementation(async () => {
      const request = await readGracefulShutdownRequestMock();
      return request === null
        ? null
        : {
            updated: request.enforcedAt === null,
            request: {
              ...request,
              enforcedAt: request.enforcedAt ?? "2026-03-07T12:30:00.000Z",
            },
          };
    });
    pollDiscordGracefulShutdownCommandMock.mockReset();
    pollDiscordGracefulShutdownCommandMock.mockResolvedValue(null);
    requestCycleLimitDecisionFromOperatorMock.mockReset();
    requestCycleLimitDecisionFromOperatorMock.mockResolvedValue(null);
    runDiscordOperatorControlStartupCheckMock.mockReset();
    runDiscordOperatorControlStartupCheckMock.mockResolvedValue(undefined);
    notifyCycleLimitDecisionAppliedInDiscordMock.mockReset();
    notifyCycleLimitDecisionAppliedInDiscordMock.mockResolvedValue(undefined);
    notifyDeferredProjectStopTriggeredInDiscordMock.mockReset();
    notifyDeferredProjectStopTriggeredInDiscordMock.mockResolvedValue(undefined);
    notifyIssueStartedInDiscordMock.mockReset();
    notifyIssueStartedInDiscordMock.mockResolvedValue(undefined);
    notifyRuntimeQuittingInDiscordMock.mockReset();
    notifyRuntimeQuittingInDiscordMock.mockResolvedValue(undefined);
    stopDiscordGracefulShutdownListenerMock.mockReset();
    stopDiscordGracefulShutdownListenerMock.mockResolvedValue(undefined);
    startDiscordGracefulShutdownListenerMock.mockReset();
    startDiscordGracefulShutdownListenerMock.mockResolvedValue({
      stop: stopDiscordGracefulShutdownListenerMock,
    });
    process.argv = ["node", "test-runner.ts"];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.useRealTimers();
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

  it("runs Discord operator control startup preflight during runtime startup", async () => {
    const { main } = await import("./main.js");

    await main();

    expect(runDiscordOperatorControlStartupCheckMock).toHaveBeenCalledTimes(1);
    expect(startDiscordGracefulShutdownListenerMock).toHaveBeenCalledWith(
      "/tmp/evolvo",
      expect.objectContaining({
        onStartProject: expect.any(Function),
      }),
    );
    expect(stopDiscordGracefulShutdownListenerMock).toHaveBeenCalledTimes(1);
  });

  it("routes startProject requests through the create-or-resume project handler", async () => {
    const { main } = await import("./main.js");

    await main();

    const discordHandlers = startDiscordGracefulShutdownListenerMock.mock.calls[0]?.[1];
    const result = await discordHandlers.onStartProject({
      messageId: "7101",
      requestedAt: "2026-03-08T09:00:00.000Z",
      requestedBy: "discord:operator-1",
      displayName: "Habit CLI",
      slug: "habit-cli",
      repositoryName: "habit-cli",
      issueLabel: "project:habit-cli",
      workspacePath: "/home/paddy/habit-cli",
    });

    expect(handleStartProjectCommandMock).toHaveBeenCalledWith({
      issueManager: expect.any(Object),
      workDir: "/tmp/evolvo",
      trackerOwner: "owner",
      trackerRepo: "repo",
      projectName: "Habit CLI",
      requestedBy: "discord:operator-1",
      requestedAt: "2026-03-08T09:00:00.000Z",
    });
    expect(result).toEqual({
      ok: true,
      action: "created",
      message: "Created provisioning issue #400 for project `habit-cli`.",
      project: {
        displayName: "Habit CLI",
        slug: "habit-cli",
        repositoryName: "habit-cli",
        workspacePath: "/home/paddy/habit-cli",
        status: "provisioning",
      },
      trackerIssue: {
        number: 400,
        url: "https://github.com/owner/repo/issues/400",
        alreadyOpen: false,
      },
    });
    expect(activateProjectInStateMock).toHaveBeenCalledWith({
      workDir: "/tmp/evolvo",
      slug: "habit-cli",
      requestedBy: "discord:operator-1",
      source: "start-project-command",
      updatedAt: "2026-03-08T09:00:00.000Z",
    });
    expect(console.log).toHaveBeenCalledWith(
      "[startProject] created new project flow for Habit CLI (habit-cli) at /home/paddy/habit-cli.",
    );
    expect(console.log).toHaveBeenCalledWith(
      "[projects] marked habit-cli as active in the multi-project set.",
    );
  });

  it("routes stopProject requests through the stop-project state handler", async () => {
    readProjectRegistryMock.mockResolvedValueOnce({
      version: 1,
      projects: [
        DEFAULT_PROJECT_EXECUTION_CONTEXT.project,
        {
          ...DEFAULT_PROJECT_EXECUTION_CONTEXT.project,
          slug: "habit-cli",
          displayName: "Habit CLI",
          kind: "managed",
          issueLabel: "project:habit-cli",
          executionRepo: {
            owner: "owner",
            repo: "habit-cli",
            url: "https://github.com/owner/habit-cli",
            defaultBranch: "main",
          },
          cwd: "/home/paddy/habit-cli",
        },
      ],
    });
    const { main } = await import("./main.js");

    await main();

    const discordHandlers = startDiscordGracefulShutdownListenerMock.mock.calls[0]?.[1];
    const result = await discordHandlers.onStopProject({
      messageId: "7201",
      requestedAt: "2026-03-08T10:00:00.000Z",
      requestedBy: "discord:operator-1",
      mode: "now",
    });

    expect(stopActiveProjectStateMock).toHaveBeenCalledWith({
      workDir: "/tmp/evolvo",
      requestedBy: "discord:operator-1",
      mode: "now",
      updatedAt: "2026-03-08T10:00:00.000Z",
    });
    expect(result).toEqual({
      ok: true,
      action: "stopped",
      message: "Project `habit-cli` will not be selected again until `startProject <project-name>` is used.",
      project: {
        displayName: "Habit CLI",
        slug: "habit-cli",
      },
    });
    expect(deactivateProjectInStateMock).toHaveBeenCalledWith("/tmp/evolvo", "habit-cli");
    expect(console.log).toHaveBeenCalledWith("[stopProject] received stop request from discord:operator-1.");
    expect(console.log).toHaveBeenCalledWith(
      "[projects] removed habit-cli from the multi-project active set.",
    );
    expect(console.log).toHaveBeenCalledWith("[stopProject] halted project Habit CLI. Runtime remains online.");
  });

  it("routes deferred stopProject requests through the stop-project state handler", async () => {
    stopActiveProjectStateMock.mockResolvedValueOnce({
      status: "stop-when-complete-scheduled",
      state: {
        version: 2,
        activeProjectSlug: "habit-cli",
        selectionState: "active",
        deferredStopMode: "when-project-complete",
        updatedAt: "2026-03-08T10:05:00.000Z",
        requestedBy: "discord:operator-1",
        source: "stop-project-command",
      },
    });
    readProjectRegistryMock.mockResolvedValueOnce({
      version: 1,
      projects: [
        DEFAULT_PROJECT_EXECUTION_CONTEXT.project,
        {
          ...DEFAULT_PROJECT_EXECUTION_CONTEXT.project,
          slug: "habit-cli",
          displayName: "Habit CLI",
          kind: "managed",
          issueLabel: "project:habit-cli",
          executionRepo: {
            owner: "owner",
            repo: "habit-cli",
            url: "https://github.com/owner/habit-cli",
            defaultBranch: "main",
          },
          cwd: "/home/paddy/habit-cli",
        },
      ],
    });
    const { main } = await import("./main.js");

    await main();

    const discordHandlers = startDiscordGracefulShutdownListenerMock.mock.calls[0]?.[1];
    const result = await discordHandlers.onStopProject({
      messageId: "7202",
      requestedAt: "2026-03-08T10:05:00.000Z",
      requestedBy: "discord:operator-1",
      mode: "when-project-complete",
    });

    expect(stopActiveProjectStateMock).toHaveBeenCalledWith({
      workDir: "/tmp/evolvo",
      requestedBy: "discord:operator-1",
      mode: "when-project-complete",
      updatedAt: "2026-03-08T10:05:00.000Z",
    });
    expect(result).toEqual({
      ok: true,
      action: "stop-when-complete-scheduled",
      message: "Project `habit-cli` will keep running until it has no actionable issues left. Evolvo will then stop it automatically, return to self-work, and remain online.",
      project: {
        displayName: "Habit CLI",
        slug: "habit-cli",
      },
    });
    expect(deactivateProjectInStateMock).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith("[stopProject] received stop request from discord:operator-1.");
    expect(console.log).toHaveBeenCalledWith(
      "[stopProject] project Habit CLI will stop automatically when it runs out of actionable work. Evolvo will then return to self-work.",
    );
  });

  it("reports live self-work status while an issue is executing", async () => {
    let resolveRun: (value: typeof DEFAULT_RUN_RESULT) => void = () => undefined;
    const pendingRun = new Promise<typeof DEFAULT_RUN_RESULT>((resolve) => {
      resolveRun = resolve;
    });
    runCodingAgentMock.mockImplementation(() => pendingRun);
    listOpenIssuesMock
      .mockResolvedValueOnce([
        {
          number: 403,
          title: "Add status command",
          description: "Expose runtime status in Discord.",
          state: "open",
          labels: [],
        },
      ])
      .mockResolvedValue([]);
    const { main } = await import("./main.js");

    const mainPromise = main();
    while (startDiscordGracefulShutdownListenerMock.mock.calls.length === 0) {
      await Promise.resolve();
    }
    while (runCodingAgentMock.mock.calls.length === 0) {
      await Promise.resolve();
    }

    const discordHandlers = startDiscordGracefulShutdownListenerMock.mock.calls[0]?.[1];
    try {
      const status = await discordHandlers.onStatus({
        messageId: "7300",
        requestedAt: "2026-03-08T11:00:00.000Z",
        requestedBy: "discord:operator-1",
      });

      expect(status).toEqual({
        ok: true,
        snapshot: {
          online: true,
        runtimeState: "active",
        workMode: "self-work",
        activitySummary: "Executing issue #403.",
        activeProjects: [
          {
            displayName: "Evolvo",
            slug: "evolvo",
            repository: "owner/repo",
          },
        ],
        activeProject: null,
        activeIssue: {
            number: 403,
            title: "Add status command",
            repository: "owner/repo",
            lifecycleState: "selected -> executing",
          },
          deferredStop: null,
          cycle: {
            current: 1,
            limit: 10,
            remaining: 9,
          },
        },
      });
      expect(console.log).toHaveBeenCalledWith(
        "[status] served runtime status to discord:operator-1: state=active mode=self-work project=none issue=403",
      );
    } finally {
      resolveRun(DEFAULT_RUN_RESULT);
      await mainPromise;
    }
  });

  it("logs and excludes unauthorized issues before normal selection", async () => {
    listOpenIssuesMock.mockResolvedValueOnce([]);
    unauthorizedIssueClosuresMock.mockResolvedValueOnce([
      {
        issueNumber: 91,
        issueTitle: "Untrusted task",
        authorLogin: "intruder-user",
        commentAdded: true,
        closed: true,
        closeMessage: "Issue #91 closed successfully.",
        commentMessage: "Added unauthorized-author closure comment to issue #91.",
      },
    ]);
    const { DEFAULT_PROMPT, main } = await import("./main.js");

    await main();

    expect(runCodingAgentMock).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(
      "Unauthorized issue #91 Untrusted task by intruder-user closed automatically.",
    );
    expect(console.log).toHaveBeenCalledWith(
      "Added unauthorized-author closure comment to issue #91.",
    );
    expect(console.log).toHaveBeenCalledWith(DEFAULT_PROMPT);
  });

  it("processes provisioning issues without invoking the coding agent", async () => {
    listOpenIssuesMock
      .mockResolvedValueOnce([
        {
          number: 77,
          title: "Start project Habit CLI",
          description: "<!-- evolvo:project-provisioning -->",
          state: "open",
          labels: [],
        },
      ])
      .mockResolvedValueOnce([]);
    isProjectProvisioningRequestIssueMock.mockReturnValueOnce(true);
    const { main } = await import("./main.js");

    await main();

    expect(executeProjectProvisioningIssueMock).toHaveBeenCalledWith({
      issue: expect.objectContaining({
        number: 77,
        title: "Start project Habit CLI",
        description: "<!-- evolvo:project-provisioning -->",
        state: "open",
        labels: [],
      }),
      workDir: "/tmp/evolvo",
      trackerOwner: "owner",
      trackerRepo: "repo",
      adminClient: expect.any(Object),
    });
    expect(runCodingAgentMock).not.toHaveBeenCalled();
    expect(addProgressCommentMock).toHaveBeenCalledWith(77, "## Project Provisioning");
    expect(markCompletedMock).toHaveBeenCalledWith(77, "Provisioning complete summary");
    expect(closeIssueMock).toHaveBeenCalledWith(77);
  });

  it("closes failed provisioning issues after writing diagnostics", async () => {
    listOpenIssuesMock
      .mockResolvedValueOnce([
        {
          number: 78,
          title: "Start project Habit CLI",
          description: "<!-- evolvo:project-provisioning -->",
          state: "open",
          labels: [],
        },
      ])
      .mockResolvedValueOnce([]);
    isProjectProvisioningRequestIssueMock.mockReturnValueOnce(true);
    executeProjectProvisioningIssueMock.mockResolvedValueOnce({
      ok: false,
      metadata: {
        owner: "owner",
        displayName: "Habit CLI",
        slug: "habit-cli",
        repositoryName: "habit-cli",
        issueLabel: "project:habit-cli",
        workspacePath: "/home/paddy/habit-cli",
        requestedBy: "discord:operator-1",
        requestedAt: "2026-03-07T12:00:00.000Z",
      },
      record: {
        slug: "habit-cli",
        displayName: "Habit CLI",
        kind: "managed",
        issueLabel: "project:habit-cli",
        trackerRepo: {
          owner: "owner",
          repo: "repo",
          url: "https://github.com/owner/repo",
        },
        executionRepo: {
          owner: "owner",
          repo: "habit-cli",
          url: "https://github.com/owner/habit-cli",
          defaultBranch: "main",
        },
        cwd: "/home/paddy/habit-cli",
        status: "failed",
        sourceIssueNumber: 78,
        createdAt: "2026-03-07T12:00:00.000Z",
        updatedAt: "2026-03-07T12:00:00.000Z",
        provisioning: {
          labelCreated: true,
          repoCreated: true,
          workspacePrepared: false,
          lastError: "workspace failed",
        },
      },
      failureStep: "workspace",
      workspaceAction: null,
      message: "workspace failed",
    });
    const { main } = await import("./main.js");

    await main();

    expect(runCodingAgentMock).not.toHaveBeenCalled();
    expect(markCompletedMock).not.toHaveBeenCalledWith(78, expect.any(String));
    expect(updateLabelsMock).toHaveBeenCalledWith(78, { remove: ["in progress"] });
    expect(closeIssueMock).toHaveBeenCalledWith(78);
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
    expect(notifyIssueStartedInDiscordMock).toHaveBeenCalledWith({
      issue: {
        number: 12,
        title: "Fix login redirect",
        repository: "owner/repo",
        url: "https://github.com/owner/repo/issues/12",
      },
      executionContext: {
        trackerRepository: "owner/repo",
        executionRepository: "owner/repo",
        project: {
          displayName: "Evolvo",
          slug: "evolvo",
        },
      },
      lifecycleState: "selected -> executing",
    });
    expect(configureCodingAgentExecutionContextMock).toHaveBeenCalledWith({
      workDir: "/tmp/evolvo",
      internalRepositoryUrls: [
        "https://github.com/owner/repo",
        "https://github.com/owner/repo",
      ],
    });
    expect(runCodingAgentMock).toHaveBeenCalledWith("Issue #12: Fix login redirect\n\nHandle callback URL.");
    expect(console.log).toHaveBeenCalledWith("Cycle 1 queue health: open=1 selected=#12");
    expect(recordChallengeAttemptMetricsMock).not.toHaveBeenCalled();
    expect(persistChallengeAttemptArtifactMock).not.toHaveBeenCalled();
    expect(replenishSelfImprovementIssuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ minimumIssueCount: 3, maximumOpenIssues: 5 }),
    );
  });

  it("logs issue prioritization reasoning when related issues compete", async () => {
    listOpenIssuesMock
      .mockResolvedValueOnce([
        { number: 101, title: "Planner copy polish", description: "Tidy planner selection copy.", state: "open", labels: [] },
        {
          number: 102,
          title: "Planner dependency ordering",
          description: "Choose the foundational planner selection issue first so it can unblock related planner tasks.",
          state: "open",
          labels: [],
        },
        { number: 103, title: "Planner selection docs", description: "Document planner selection examples.", state: "open", labels: [] },
      ])
      .mockResolvedValueOnce([]);
    const { main } = await import("./main.js");

    await main();

    expect(markInProgressMock).toHaveBeenCalledWith(102);
    expect(runCodingAgentMock).toHaveBeenCalledWith(
      "Issue #102: Planner dependency ordering\n\nChoose the foundational planner selection issue first so it can unblock related planner tasks.",
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining(
        "Issue prioritization selected #102 Planner dependency ordering over 2 other candidate(s):",
      ),
    );
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("dependency or unblock potential"));
  });

  it("resolves managed-project execution context before running the coding agent", async () => {
    listOpenIssuesMock
      .mockResolvedValueOnce([
        { number: 14, title: "Managed repo issue", description: "Use project context", state: "open", labels: ["project:habit-cli"] },
      ])
      .mockResolvedValueOnce([]);
    resolveProjectExecutionContextForIssueMock.mockResolvedValueOnce({
      ok: true,
      context: {
        project: {
          slug: "habit-cli",
          displayName: "Habit CLI",
          kind: "managed",
          issueLabel: "project:habit-cli",
          trackerRepo: {
            owner: "tracker-org",
            repo: "issue-tracker",
            url: "https://github.com/tracker-org/issue-tracker",
          },
          executionRepo: {
            owner: "owner",
            repo: "habit-cli",
            url: "https://github.com/owner/habit-cli",
            defaultBranch: "main",
          },
          cwd: "/home/paddy/habit-cli",
          status: "active",
          sourceIssueNumber: 318,
          createdAt: "2026-03-07T12:00:00.000Z",
          updatedAt: "2026-03-07T12:00:00.000Z",
          provisioning: {
            labelCreated: true,
            repoCreated: true,
            workspacePrepared: true,
            lastError: null,
          },
        },
        trackerRepository: "tracker-org/issue-tracker",
        executionRepository: "owner/habit-cli",
      },
    });
    const { main } = await import("./main.js");

    await main();

    expect(notifyIssueStartedInDiscordMock).toHaveBeenCalledWith({
      issue: {
        number: 14,
        title: "Managed repo issue",
        repository: "owner/repo",
        url: "https://github.com/owner/repo/issues/14",
      },
      executionContext: {
        trackerRepository: "tracker-org/issue-tracker",
        executionRepository: "owner/habit-cli",
        project: {
          displayName: "Habit CLI",
          slug: "habit-cli",
        },
      },
      lifecycleState: "selected -> executing",
    });
    expect(configureCodingAgentExecutionContextMock).toHaveBeenCalledWith({
      workDir: "/home/paddy/habit-cli",
      internalRepositoryUrls: [
        "https://github.com/tracker-org/issue-tracker",
        "https://github.com/owner/habit-cli",
      ],
    });
    expect(addProgressCommentMock).toHaveBeenCalledWith(
      14,
      expect.stringContaining("Execution repository: `owner/habit-cli`."),
    );
    expect(inspectProjectRepositoryIssuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "habit-cli",
      }),
    );
    expect(console.log).toHaveBeenCalledWith(
      "[project-issues] inspected project=habit-cli repository=owner/habit-cli open=0 recentClosed=0",
    );
    expect(runCodingAgentMock).toHaveBeenCalledWith(
      expect.stringContaining("## Project Repository Issue State"),
    );
    expect(runCodingAgentMock).toHaveBeenCalledWith(
      expect.stringContaining("Project repository: owner/habit-cli"),
    );
  });

  it("prefers issues for the active project when one is selected", async () => {
    readActiveProjectStateMock.mockResolvedValueOnce({
      version: 2,
      activeProjectSlug: "habit-cli",
      selectionState: "active",
      deferredStopMode: null,
      updatedAt: "2026-03-08T09:10:00.000Z",
      requestedBy: "discord:operator-1",
      source: "start-project-command",
    });
    listOpenIssuesMock
      .mockResolvedValueOnce([
        { number: 21, title: "Default issue", description: "general", state: "open", labels: [] },
        { number: 22, title: "Managed issue", description: "project", state: "open", labels: ["project:habit-cli"] },
      ])
      .mockResolvedValueOnce([]);
    resolveProjectExecutionContextForIssueMock.mockResolvedValueOnce({
      ok: true,
      context: {
        project: {
          ...DEFAULT_PROJECT_EXECUTION_CONTEXT.project,
          slug: "habit-cli",
          displayName: "Habit CLI",
          kind: "managed",
          issueLabel: "project:habit-cli",
          executionRepo: {
            owner: "owner",
            repo: "habit-cli",
            url: "https://github.com/owner/habit-cli",
            defaultBranch: "main",
          },
          cwd: "/home/paddy/habit-cli",
        },
        trackerRepository: "owner/repo",
        executionRepository: "owner/habit-cli",
      },
    });
    const { main } = await import("./main.js");

    await main();

    expect(markInProgressMock).toHaveBeenCalledWith(22);
    expect(runCodingAgentMock).toHaveBeenCalledWith(
      expect.stringContaining("Issue #22: Managed issue\n\nproject"),
    );
    expect(runCodingAgentMock).toHaveBeenCalledWith(
      expect.stringContaining("## Project Repository Issue State"),
    );
  });

  it("stops a deferred project when it runs out of actionable work and returns to self-work", async () => {
    readActiveProjectStateMock.mockResolvedValueOnce({
      version: 2,
      activeProjectSlug: "habit-cli",
      selectionState: "active",
      deferredStopMode: "when-project-complete",
      updatedAt: "2026-03-08T10:00:00.000Z",
      requestedBy: "discord:operator-1",
      source: "stop-project-command",
    });
    buildUnifiedIssueQueueMock
      .mockResolvedValueOnce({
        issues: [
          {
            number: 30,
            title: "Self issue after project completion",
            description: "self work",
            state: "open",
            labels: [],
            queueKey: "tracker:owner/repo#30",
            sourceKind: "tracker",
            projectSlug: null,
            repository: {
              owner: "owner",
              repo: "repo",
              url: "https://github.com/owner/repo",
              reference: "owner/repo",
            },
            project: null,
          },
        ],
        unauthorizedClosures: [],
        activeManagedProject: {
          ...DEFAULT_PROJECT_EXECUTION_CONTEXT.project,
          slug: "habit-cli",
          displayName: "Habit CLI",
          kind: "managed",
          issueLabel: "project:habit-cli",
          executionRepo: {
            owner: "owner",
            repo: "habit-cli",
            url: "https://github.com/owner/habit-cli",
            defaultBranch: "main",
          },
          cwd: "/home/paddy/habit-cli",
        },
      })
      .mockImplementation(async () => ({
        issues: (await listOpenIssuesMock()).map((issue: {
          number: number;
          title: string;
          description: string;
          state: "open" | "closed";
          labels: string[];
        }) => ({
          ...issue,
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
    listOpenIssuesMock
      .mockResolvedValueOnce([
        { number: 30, title: "Self issue after project completion", description: "self work", state: "open", labels: [] },
      ])
      .mockResolvedValueOnce([]);
    const { main } = await import("./main.js");

    await main();

    expect(runPlannerAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      openIssueCount: 0,
      workDir: "/home/paddy/habit-cli",
    }));
    expect(clearActiveProjectStateMock).toHaveBeenCalledWith("/tmp/evolvo");
    expect(deactivateProjectInStateMock).toHaveBeenCalledWith("/tmp/evolvo", "habit-cli");
    expect(notifyDeferredProjectStopTriggeredInDiscordMock).toHaveBeenCalledWith({
      displayName: "Habit CLI",
      slug: "habit-cli",
    });
    expect(console.log).toHaveBeenCalledWith(
      "[projects] removed habit-cli from the multi-project active set after deferred completion.",
    );
    expect(console.log).toHaveBeenCalledWith(
      "[stopProject] project habit-cli reached completion with deferred stop active. No actionable project work remains.",
    );
    expect(console.log).toHaveBeenCalledWith(
      "[stopProject] switched from project Habit CLI (habit-cli) back to Evolvo self-work. Runtime remains online.",
    );
    expect(runCodingAgentMock).toHaveBeenCalledWith("Issue #30: Self issue after project completion\n\nself work");
  });

  it("keeps a deferred project active when project planner replenishment creates more work", async () => {
    readActiveProjectStateMock.mockResolvedValueOnce({
      version: 2,
      activeProjectSlug: "habit-cli",
      selectionState: "active",
      deferredStopMode: "when-project-complete",
      updatedAt: "2026-03-08T10:10:00.000Z",
      requestedBy: "discord:operator-1",
      source: "stop-project-command",
    });
    replenishSelfImprovementIssuesMock.mockResolvedValueOnce({
      created: [
        {
          number: 31,
          title: "Generated project follow-up",
          description: "project work",
          state: "open",
          labels: [],
        },
      ],
    });
    buildUnifiedIssueQueueMock
      .mockResolvedValueOnce({
        issues: [
          {
            number: 30,
            title: "Self issue after project queue drained",
            description: "self work",
            state: "open",
            labels: [],
            queueKey: "tracker:owner/repo#30",
            sourceKind: "tracker",
            projectSlug: null,
            repository: {
              owner: "owner",
              repo: "repo",
              url: "https://github.com/owner/repo",
              reference: "owner/repo",
            },
            project: null,
          },
        ],
        unauthorizedClosures: [],
        activeManagedProject: {
          ...DEFAULT_PROJECT_EXECUTION_CONTEXT.project,
          slug: "habit-cli",
          displayName: "Habit CLI",
          kind: "managed",
          issueLabel: "project:habit-cli",
          executionRepo: {
            owner: "owner",
            repo: "habit-cli",
            url: "https://github.com/owner/habit-cli",
            defaultBranch: "main",
          },
          cwd: "/home/paddy/habit-cli",
        },
      })
      .mockResolvedValueOnce({
        issues: [
          {
            number: 31,
            title: "Generated project follow-up",
            description: "project work",
            state: "open",
            labels: [],
            queueKey: "project:habit-cli#31",
            sourceKind: "project-repo",
            projectSlug: "habit-cli",
            repository: {
              owner: "owner",
              repo: "habit-cli",
              url: "https://github.com/owner/habit-cli",
              reference: "owner/habit-cli",
            },
            project: {
              ...DEFAULT_PROJECT_EXECUTION_CONTEXT.project,
              slug: "habit-cli",
              displayName: "Habit CLI",
              kind: "managed",
              issueLabel: "project:habit-cli",
              executionRepo: {
                owner: "owner",
                repo: "habit-cli",
                url: "https://github.com/owner/habit-cli",
                defaultBranch: "main",
              },
              cwd: "/home/paddy/habit-cli",
            },
          },
        ],
        unauthorizedClosures: [],
        activeManagedProject: {
          ...DEFAULT_PROJECT_EXECUTION_CONTEXT.project,
          slug: "habit-cli",
          displayName: "Habit CLI",
          kind: "managed",
          issueLabel: "project:habit-cli",
          executionRepo: {
            owner: "owner",
            repo: "habit-cli",
            url: "https://github.com/owner/habit-cli",
            defaultBranch: "main",
          },
          cwd: "/home/paddy/habit-cli",
        },
      })
      .mockResolvedValueOnce({
        issues: [],
        unauthorizedClosures: [],
        activeManagedProject: {
          ...DEFAULT_PROJECT_EXECUTION_CONTEXT.project,
          slug: "habit-cli",
          displayName: "Habit CLI",
          kind: "managed",
          issueLabel: "project:habit-cli",
          executionRepo: {
            owner: "owner",
            repo: "habit-cli",
            url: "https://github.com/owner/habit-cli",
            defaultBranch: "main",
          },
          cwd: "/home/paddy/habit-cli",
        },
      });

    const { main } = await import("./main.js");

    await main();

    expect(runPlannerAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      openIssueCount: 0,
      workDir: "/home/paddy/habit-cli",
    }));
    expect(notifyIssueStartedInDiscordMock).toHaveBeenCalledWith(expect.objectContaining({
      issue: {
        number: 31,
        title: "Generated project follow-up",
        repository: "owner/habit-cli",
        url: "https://github.com/owner/habit-cli/issues/31",
      },
    }));
    expect(markInProgressMock).toHaveBeenCalledWith(31);
    expect(runCodingAgentMock).toHaveBeenCalledWith(
      expect.stringContaining("Issue #31: Generated project follow-up\n\nproject work"),
    );
    expect(clearActiveProjectStateMock).toHaveBeenCalledWith("/tmp/evolvo");
    expect(deactivateProjectInStateMock).toHaveBeenCalledWith("/tmp/evolvo", "habit-cli");
    expect(notifyDeferredProjectStopTriggeredInDiscordMock).toHaveBeenCalledWith({
      displayName: "Habit CLI",
      slug: "habit-cli",
    });
  });

  it("keeps the runtime online and idle when the active project is stopped", async () => {
    vi.useFakeTimers();
    readActiveProjectStateMock.mockResolvedValueOnce({
      version: 2,
      activeProjectSlug: "habit-cli",
      selectionState: "stopped",
      deferredStopMode: null,
      updatedAt: "2026-03-08T10:05:00.000Z",
      requestedBy: "discord:operator-1",
      source: "stop-project-command",
    });
    listOpenIssuesMock.mockResolvedValueOnce([
      { number: 23, title: "Stopped project issue", description: "halted", state: "open", labels: ["project:habit-cli"] },
    ]);
    readGracefulShutdownRequestMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        version: 1,
        source: "discord",
        command: "quit after current task",
        mode: "after-current-task",
        messageId: "9901",
        requestedAt: "2026-03-08T10:06:00.000Z",
        enforcedAt: null,
      });
    const { main } = await import("./main.js");

    const mainPromise = main();
    await vi.advanceTimersByTimeAsync(1000);
    await mainPromise;

    expect(runCodingAgentMock).not.toHaveBeenCalled();
    expect(runPlannerAgentMock).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(
      "[stopProject] project habit-cli is halted. Runtime remains online and is waiting for further operator instructions.",
    );
    expect(notifyRuntimeQuittingInDiscordMock).toHaveBeenCalledWith(
      "Graceful shutdown via quit after current task is being enforced. Stopping before starting a new task.",
    );
  });

  it("blocks issues with invalid project labels before execution", async () => {
    listOpenIssuesMock
      .mockResolvedValueOnce([
        { number: 15, title: "Broken project labels", description: "bad", state: "open", labels: ["project:missing"] },
        { number: 16, title: "Fallback issue", description: "good", state: "open", labels: [] },
      ])
      .mockResolvedValueOnce([
        { number: 15, title: "Broken project labels", description: "bad", state: "open", labels: ["project:missing", "blocked"] },
        { number: 16, title: "Fallback issue", description: "good", state: "open", labels: [] },
      ])
      .mockResolvedValueOnce([]);
    resolveProjectExecutionContextForIssueMock
      .mockResolvedValueOnce({
        ok: false,
        code: "unknown-project",
        message: "No project registry entry exists for label `project:missing`.",
        projectLabels: ["project:missing"],
      })
      .mockResolvedValue({
        ok: true,
        context: DEFAULT_PROJECT_EXECUTION_CONTEXT,
      });
    const { main } = await import("./main.js");

    await main();

    expect(runCodingAgentMock).toHaveBeenCalledTimes(1);
    expect(runCodingAgentMock).toHaveBeenCalledWith("Issue #16: Fallback issue\n\ngood");
    expect(addProgressCommentMock).toHaveBeenCalledWith(15, "## Project Routing Blocked");
    expect(updateLabelsMock).toHaveBeenCalledWith(15, {
      add: ["blocked"],
      remove: ["in progress"],
    });
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
      expect.stringContaining("`pnpm validate` (name=pnpm, command_name=pnpm, status=1, elapsed=321ms"),
    );
    expect(addProgressCommentMock).toHaveBeenCalledWith(
      13,
      expect.stringContaining("exit_code=1"),
    );
    expect(addProgressCommentMock).toHaveBeenCalledWith(
      13,
      expect.stringContaining("command_name=pnpm"),
    );
    expect(addProgressCommentMock).toHaveBeenCalledWith(
      13,
      expect.stringContaining("duration_ms=321"),
    );
    expect(addProgressCommentMock).toHaveBeenCalledWith(
      13,
      expect.stringContaining("outcome=failed"),
    );
  });

  it("derives lifecycle validation command name from env-prefixed command text", async () => {
    listOpenIssuesMock
      .mockResolvedValueOnce([
        { number: 18, title: "Validation name fallback", description: "Check env command names", state: "open", labels: [] },
      ])
      .mockResolvedValueOnce([]);
    runCodingAgentMock.mockResolvedValueOnce({
      ...DEFAULT_RUN_RESULT,
      summary: {
        ...DEFAULT_RUN_RESULT.summary,
        validationCommands: [{ command: "CI=1 pnpm test", commandName: "", exitCode: 0, durationMs: 155 }],
        failedValidationCommands: [],
      },
    });
    const { main } = await import("./main.js");

    await main();

    expect(addProgressCommentMock).toHaveBeenCalledWith(
      18,
      expect.stringContaining("`CI=1 pnpm test` (name=pnpm, command_name=pnpm, status=0, elapsed=155ms"),
    );
  });

  it("logs unknown validation status and duration fields when command metadata is missing", async () => {
    listOpenIssuesMock
      .mockResolvedValueOnce([
        { number: 20, title: "Validation unknown fields", description: "unknown status", state: "open", labels: [] },
      ])
      .mockResolvedValueOnce([]);
    runCodingAgentMock.mockResolvedValueOnce({
      ...DEFAULT_RUN_RESULT,
      summary: {
        ...DEFAULT_RUN_RESULT.summary,
        validationCommands: [{ command: "pnpm test", commandName: "", exitCode: null, durationMs: null }],
        failedValidationCommands: [{ command: "pnpm test", commandName: "", exitCode: null, durationMs: null }],
        reviewOutcome: "amended",
      },
    });
    const { main } = await import("./main.js");

    await main();

    expect(addProgressCommentMock).toHaveBeenCalledWith(
      20,
      expect.stringContaining("`pnpm test` (name=pnpm, command_name=pnpm, status=unknown, elapsed=unknown, exit_code=unknown, duration_ms=unknown, outcome=unknown)"),
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
    expect(notifyIssueStartedInDiscordMock).not.toHaveBeenCalled();
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
    tryResolveRepositoryDefaultBranchMock.mockResolvedValueOnce("release");
    runCodingAgentMock.mockResolvedValueOnce({
      ...DEFAULT_RUN_RESULT,
      mergedPullRequest: true,
      summary: { ...DEFAULT_RUN_RESULT.summary, pullRequestCreated: true },
    });
    const { main } = await import("./main.js");

    await main();

    expect(addProgressCommentMock).toHaveBeenCalledWith(11, expect.stringContaining("merged into `release`"));
    expect(transitionCanonicalLifecycleStateMock).toHaveBeenCalledWith(
      "/tmp/evolvo",
      expect.objectContaining({
        nextState: "merged",
        reason: "pull request merged into release",
      }),
    );
    expect(runPostMergeSelfRestartMock).toHaveBeenCalledWith("/tmp/evolvo");
    expect(notifyRuntimeQuittingInDiscordMock).toHaveBeenCalledWith(
      "Post-merge restart workflow completed. This runtime is quitting so the restarted runtime can take over.",
    );
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
    expect(notifyRuntimeQuittingInDiscordMock).toHaveBeenCalledWith(
      "Post-merge restart workflow failed, and this runtime is still quitting after the merged pull request.",
    );
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
    expect(notifyRuntimeQuittingInDiscordMock).toHaveBeenCalledWith(
      "No actionable open issues remain and no new work was created, so Evolvo is shutting down.",
    );
    expect(console.log).toHaveBeenCalledWith(
      "Cycle 1 queue health: open=0 selected=none queueAction=bootstrap created=1 outcome=continue",
    );
    expect(console.log).toHaveBeenCalledWith(
      "No open issues found on startup. Bootstrapped issue queue from repository analysis.",
    );
  });

  it("processes startup-bootstrapped issues before any empty-queue exit path", async () => {
    process.argv = ["node", "test-runner.ts"];
    generateStartupIssueTemplatesMock.mockResolvedValueOnce([
      { title: "Startup issue", description: "from repo analysis" },
      { title: "Startup issue 2", description: "from repo analysis" },
      { title: "Startup issue 3", description: "from repo analysis" },
    ]);
    listOpenIssuesMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { number: 73, title: "Generated startup", description: "generated", state: "open", labels: [] },
      ])
      .mockResolvedValueOnce([]);
    replenishSelfImprovementIssuesMock.mockResolvedValueOnce({
      created: [{ number: 73, title: "Generated startup", description: "generated", state: "open", labels: [] }],
    });
    const { DEFAULT_PROMPT, main } = await import("./main.js");

    await main();

    expect(runCodingAgentMock).toHaveBeenCalledWith("Issue #73: Generated startup\n\ngenerated");
    expect(console.log).not.toHaveBeenCalledWith(DEFAULT_PROMPT);
    const generatedIssueCycleIndex = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.findIndex(
      (call) => call[0] === "Cycle 2 queue health: open=1 selected=#73",
    );
    const stopLogIndex = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.findIndex(
      (call) => call[0] === "No actionable open issues remaining and no new issues were created. Issue loop stopped.",
    );
    expect(generatedIssueCycleIndex).toBeGreaterThan(-1);
    expect(stopLogIndex).toBeGreaterThan(generatedIssueCycleIndex);
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
    expect(console.log).toHaveBeenCalledWith(
      "Cycle 1 queue health: open=0 selected=none queueAction=bootstrap created=0 outcome=stop",
    );
    expect(console.log).toHaveBeenCalledWith(DEFAULT_PROMPT);
    expect(notifyRuntimeQuittingInDiscordMock).toHaveBeenCalledWith(
      "No open issues are available, so Evolvo is shutting down until more work is created.",
    );
  });

  it("logs diagnostics and stops when startup repository analysis throws", async () => {
    generateStartupIssueTemplatesMock.mockRejectedValueOnce(new Error("analysis boom"));
    const { DEFAULT_PROMPT, main } = await import("./main.js");

    await main();

    expect(console.error).toHaveBeenCalledWith("GitHub issue sync unavailable: analysis boom");
    expect(replenishSelfImprovementIssuesMock).not.toHaveBeenCalled();
    expect(runCodingAgentMock).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(DEFAULT_PROMPT);
  });

  it("logs actionable startup diagnostics when repository analysis fails at startup", async () => {
    generateStartupIssueTemplatesMock.mockRejectedValueOnce(new Error("analysis boom"));
    const { DEFAULT_PROMPT, main } = await import("./main.js");

    await main();

    expect(console.error).toHaveBeenCalledWith("GitHub issue sync unavailable: analysis boom");
    expect(console.log).toHaveBeenCalledWith(DEFAULT_PROMPT);
    expect(runCodingAgentMock).not.toHaveBeenCalled();
  });

  it("logs actionable startup diagnostics when startup analysis yields no candidates", async () => {
    generateStartupIssueTemplatesMock.mockResolvedValueOnce([]);
    const { DEFAULT_PROMPT, main } = await import("./main.js");

    await main();

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
    const { main } = await import("./main.js");

    await main();

    expect(runCodingAgentMock).not.toHaveBeenCalled();
    expect(markInProgressMock).not.toHaveBeenCalled();
    expect(replenishSelfImprovementIssuesMock).toHaveBeenCalledWith({
      minimumIssueCount: 3,
      maximumOpenIssues: 5,
      templates: [],
    });
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

    expect(generateStartupIssueTemplatesMock).toHaveBeenCalledWith("/tmp/evolvo", { targetCount: 3 });
    expect(replenishSelfImprovementIssuesMock).toHaveBeenCalledWith({
      minimumIssueCount: 3,
      maximumOpenIssues: 5,
      templates: [],
    });
    expect(console.log).toHaveBeenCalledWith(
      "Cycle 1 queue health: open=1 selected=none queueAction=replenish created=1 outcome=continue",
    );
    expect(runCodingAgentMock).toHaveBeenCalledWith("Issue #24: Generated\n\ngenerated");
  });

  it("continues through completed-only queue replenishment without hitting startup default prompt", async () => {
    process.argv = ["node", "test-runner.ts"];
    listOpenIssuesMock
      .mockResolvedValueOnce([
        { number: 25, title: "Done", description: "done", state: "open", labels: ["completed"] },
      ])
      .mockResolvedValueOnce([
        { number: 26, title: "Replenished", description: "from queue", state: "open", labels: [] },
      ])
      .mockResolvedValueOnce([]);
    replenishSelfImprovementIssuesMock.mockResolvedValueOnce({
      created: [{ number: 26, title: "Replenished", description: "from queue", state: "open", labels: [] }],
    });
    const { DEFAULT_PROMPT, main } = await import("./main.js");

    await main();

    expect(runCodingAgentMock).toHaveBeenCalledWith("Issue #26: Replenished\n\nfrom queue");
    expect(console.log).not.toHaveBeenCalledWith(DEFAULT_PROMPT);
    const replenishedCycleIndex = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.findIndex(
      (call) => call[0] === "Cycle 2 queue health: open=1 selected=#26",
    );
    const stopLogIndex = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.findIndex(
      (call) => call[0] === "No actionable open issues remaining and no new issues were created. Issue loop stopped.",
    );
    expect(replenishedCycleIndex).toBeGreaterThan(-1);
    expect(stopLogIndex).toBeGreaterThan(replenishedCycleIndex);
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

    expect(replenishSelfImprovementIssuesMock).toHaveBeenCalledWith({
      minimumIssueCount: 3,
      maximumOpenIssues: 5,
      templates: [],
    });
    expect(console.log).toHaveBeenCalledWith(
      "Cycle 2 queue health: open=0 selected=none queueAction=replenish created=1 outcome=continue",
    );
    expect(runCodingAgentMock).toHaveBeenNthCalledWith(1, "Issue #31: Initial\n\nfirst");
    expect(runCodingAgentMock).toHaveBeenNthCalledWith(2, "Issue #32: Replenished\n\nsecond");
  });

  it("uses codebase analysis templates when replenishing a non-startup empty queue", async () => {
    process.argv = ["node", "test-runner.ts"];
    generateStartupIssueTemplatesMock.mockResolvedValueOnce([
      { title: "Analysis issue A", description: "from analysis" },
      { title: "Analysis issue B", description: "from analysis" },
      { title: "Analysis issue C", description: "from analysis" },
    ]);
    listOpenIssuesMock
      .mockResolvedValueOnce([
        { number: 33, title: "Initial", description: "first", state: "open", labels: [] },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { number: 34, title: "Analysis Replenished", description: "second", state: "open", labels: [] },
      ])
      .mockResolvedValueOnce([]);
    replenishSelfImprovementIssuesMock.mockResolvedValueOnce({
      created: [{ number: 34, title: "Analysis Replenished", description: "second", state: "open", labels: [] }],
    });
    const { main } = await import("./main.js");

    await main();

    expect(generateStartupIssueTemplatesMock).toHaveBeenCalledWith("/tmp/evolvo", { targetCount: 3 });
    expect(replenishSelfImprovementIssuesMock).toHaveBeenCalledWith({
      minimumIssueCount: 3,
      maximumOpenIssues: 5,
      templates: [
        { title: "Analysis issue A", description: "from analysis" },
        { title: "Analysis issue B", description: "from analysis" },
        { title: "Analysis issue C", description: "from analysis" },
      ],
    });
    expect(runCodingAgentMock).toHaveBeenNthCalledWith(1, "Issue #33: Initial\n\nfirst");
    expect(runCodingAgentMock).toHaveBeenNthCalledWith(2, "Issue #34: Analysis Replenished\n\nsecond");
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
      templates: [],
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

  it("resets transient retry attempts between cycles after recovery", async () => {
    process.argv = ["node", "test-runner.ts"];
    listOpenIssuesMock
      .mockRejectedValueOnce(new GitHubApiError("GitHub API request failed (503): Service Unavailable", 503, null))
      .mockResolvedValueOnce([
        { number: 71, title: "Cycle one recovery", description: "recover in cycle 1", state: "open", labels: [] },
      ])
      .mockRejectedValueOnce(new GitHubApiError("GitHub API request failed (503): Service Unavailable", 503, null))
      .mockResolvedValueOnce([
        { number: 72, title: "Cycle two recovery", description: "recover in cycle 2", state: "open", labels: [] },
      ])
      .mockResolvedValueOnce([]);
    const { main } = await import("./main.js");

    await main();

    expect(runCodingAgentMock).toHaveBeenNthCalledWith(1, "Issue #71: Cycle one recovery\n\nrecover in cycle 1");
    expect(runCodingAgentMock).toHaveBeenNthCalledWith(2, "Issue #72: Cycle two recovery\n\nrecover in cycle 2");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Transient GitHub issue sync failure on cycle 1 (attempt 1/2). Retrying in 50ms."),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Transient GitHub issue sync failure on cycle 2 (attempt 1/2). Retrying in 50ms."),
    );
    expect(console.error).not.toHaveBeenCalledWith(
      expect.stringContaining("Transient GitHub issue sync failure on cycle 2 (attempt 2/2)."),
    );
  });

  it("retries transient GitHub bootstrap failures in the run loop and recovers", async () => {
    process.argv = ["node", "test-runner.ts"];
    generateStartupIssueTemplatesMock.mockResolvedValue([
      { title: "Bootstrap A", description: "A" },
      { title: "Bootstrap B", description: "B" },
      { title: "Bootstrap C", description: "C" },
    ]);
    listOpenIssuesMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { number: 68, title: "Recover after bootstrap retry", description: "bootstrap retry", state: "open", labels: [] },
      ])
      .mockResolvedValueOnce([]);
    replenishSelfImprovementIssuesMock.mockRejectedValueOnce(
      new GitHubApiError("GitHub API request failed (503): Service Unavailable", 503, null),
    );
    const { main } = await import("./main.js");

    await main();

    expect(listOpenIssuesMock).toHaveBeenCalledTimes(3);
    expect(replenishSelfImprovementIssuesMock).toHaveBeenCalledTimes(2);
    expect(runCodingAgentMock).toHaveBeenCalledWith("Issue #68: Recover after bootstrap retry\n\nbootstrap retry");
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

  it("stops after bounded retries when transient GitHub bootstrap failures persist", async () => {
    process.argv = ["node", "test-runner.ts"];
    generateStartupIssueTemplatesMock.mockResolvedValue([
      { title: "Bootstrap A", description: "A" },
      { title: "Bootstrap B", description: "B" },
      { title: "Bootstrap C", description: "C" },
    ]);
    listOpenIssuesMock.mockResolvedValue([]);
    replenishSelfImprovementIssuesMock.mockRejectedValue(
      new GitHubApiError("GitHub API request failed (503): Service Unavailable", 503, null),
    );
    const { DEFAULT_PROMPT, main } = await import("./main.js");

    await main();

    expect(listOpenIssuesMock).toHaveBeenCalledTimes(3);
    expect(replenishSelfImprovementIssuesMock).toHaveBeenCalledTimes(3);
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

  it("retries transient network TypeError failures and recovers", async () => {
    process.argv = ["node", "test-runner.ts"];
    listOpenIssuesMock
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce([
        { number: 60, title: "Network recovery", description: "retry typeerror", state: "open", labels: [] },
      ])
      .mockResolvedValueOnce([]);
    const { main } = await import("./main.js");

    await main();

    expect(listOpenIssuesMock).toHaveBeenCalledTimes(3);
    expect(runCodingAgentMock).toHaveBeenCalledWith("Issue #60: Network recovery\n\nretry typeerror");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Transient GitHub issue sync failure on cycle 1 (attempt 1/2). Retrying in 50ms."),
    );
  });

  it("retries transient timeout errors and recovers", async () => {
    process.argv = ["node", "test-runner.ts"];
    listOpenIssuesMock
      .mockRejectedValueOnce(new Error("GitHub API request timed out after 5000ms"))
      .mockResolvedValueOnce([
        { number: 61, title: "Timeout recovery", description: "retry timeout", state: "open", labels: [] },
      ])
      .mockResolvedValueOnce([]);
    const { main } = await import("./main.js");

    await main();

    expect(listOpenIssuesMock).toHaveBeenCalledTimes(3);
    expect(runCodingAgentMock).toHaveBeenCalledWith("Issue #61: Timeout recovery\n\nretry timeout");
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

  it("continues with an extended cycle budget when Discord operator chooses continue", async () => {
    let listCalls = 0;
    listOpenIssuesMock.mockImplementation(async () => {
      listCalls += 1;
      if (listCalls <= 100) {
        return [
          { number: 201, title: "Long-running task", description: "still open", state: "open", labels: [] },
        ];
      }
      return [];
    });
    requestCycleLimitDecisionFromOperatorMock.mockResolvedValueOnce({
      decision: "continue",
      additionalCycles: 2,
      source: "discord",
    });
    const { main } = await import("./main.js");

    await main();

    expect(requestCycleLimitDecisionFromOperatorMock).toHaveBeenCalledWith(10);
    expect(console.log).toHaveBeenCalledWith(
      "Operator decision via Discord: continue (+2 cycles). New limit=12.",
    );
    expect(notifyCycleLimitDecisionAppliedInDiscordMock).toHaveBeenCalledWith({
      decision: "continue",
      currentLimit: 10,
      additionalCycles: 2,
      newLimit: 12,
    });
    expect(runCodingAgentMock).toHaveBeenCalledTimes(11);
  });

  it("quits cleanly at cycle limit when Discord operator chooses quit", async () => {
    listOpenIssuesMock.mockResolvedValue([
      { number: 202, title: "Long-running task", description: "still open", state: "open", labels: [] },
    ]);
    requestCycleLimitDecisionFromOperatorMock.mockResolvedValueOnce({
      decision: "quit",
      additionalCycles: 0,
      source: "discord",
    });
    const { main } = await import("./main.js");

    await main();

    expect(requestCycleLimitDecisionFromOperatorMock).toHaveBeenCalledWith(10);
    expect(console.error).toHaveBeenCalledWith("Operator decision via Discord: quit.");
    expect(console.error).toHaveBeenCalledWith("Reached the maximum number of issue cycles (10).");
    expect(notifyCycleLimitDecisionAppliedInDiscordMock).toHaveBeenCalledWith({
      decision: "quit",
      currentLimit: 10,
    });
  });

  it("sends a pre-quit notification when the cycle limit is reached without a continue decision", async () => {
    listOpenIssuesMock.mockResolvedValue([
      { number: 203, title: "Long-running task", description: "still open", state: "open", labels: [] },
    ]);
    const { main } = await import("./main.js");

    await main();

    expect(requestCycleLimitDecisionFromOperatorMock).toHaveBeenCalledWith(10);
    expect(console.error).toHaveBeenCalledWith("Reached the maximum number of issue cycles (10).");
    expect(notifyRuntimeQuittingInDiscordMock).toHaveBeenCalledWith(
      "Cycle limit of 10 was reached and no continue decision was applied.",
    );
  });

  it("stops before starting a new task when a graceful shutdown request is already pending", async () => {
    readGracefulShutdownRequestMock.mockResolvedValueOnce({
      version: 1,
      source: "discord",
      command: "quit after current task",
      mode: "after-current-task",
      messageId: "9001",
      requestedAt: "2026-03-07T12:00:00.000Z",
      enforcedAt: null,
    });
    const { main } = await import("./main.js");

    await main();

    expect(listOpenIssuesMock).not.toHaveBeenCalled();
    expect(runCodingAgentMock).not.toHaveBeenCalled();
    expect(markGracefulShutdownRequestEnforcedMock).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(
      "Graceful shutdown requested via Discord quit after current task. Stopping before starting a new task. Shutdown intent remains persisted so later restarts do not resume work unexpectedly.",
    );
    expect(notifyRuntimeQuittingInDiscordMock).toHaveBeenCalledWith(
      "Graceful shutdown via quit after current task is being enforced. Stopping before starting a new task.",
    );
  });

  it("finishes the current task and stops before selecting another issue after quit after current task is requested", async () => {
    listOpenIssuesMock
      .mockResolvedValueOnce([
        { number: 301, title: "Current task", description: "finish this", state: "open", labels: [] },
      ])
      .mockResolvedValueOnce([
        { number: 302, title: "Next task", description: "should not start", state: "open", labels: [] },
      ]);
    readGracefulShutdownRequestMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        version: 1,
        source: "discord",
        command: "quit after current task",
        mode: "after-current-task",
        messageId: "9002",
        requestedAt: "2026-03-07T12:05:00.000Z",
        enforcedAt: null,
      });
    const { main } = await import("./main.js");

    await main();

    expect(runCodingAgentMock).toHaveBeenCalledTimes(1);
    expect(runCodingAgentMock).toHaveBeenCalledWith("Issue #301: Current task\n\nfinish this");
    expect(markInProgressMock).toHaveBeenCalledWith(301);
    expect(markInProgressMock).not.toHaveBeenCalledWith(302);
    expect(markGracefulShutdownRequestEnforcedMock).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(
      "Graceful shutdown requested via Discord quit after current task. Current task completed. Stopping before starting another issue. Shutdown intent remains persisted so later restarts do not resume work unexpectedly.",
    );
    expect(notifyRuntimeQuittingInDiscordMock).toHaveBeenCalledWith(
      "Graceful shutdown via quit after current task is being enforced. Current task completed. Stopping before starting another issue.",
    );
  });

  it("drains existing issues and suppresses planner replenishment after quit after tasks", async () => {
    listOpenIssuesMock
      .mockResolvedValueOnce([
        { number: 401, title: "First queued task", description: "one", state: "open", labels: [] },
        { number: 402, title: "Second queued task", description: "two", state: "open", labels: [] },
      ])
      .mockResolvedValueOnce([
        { number: 402, title: "Second queued task", description: "two", state: "open", labels: [] },
      ])
      .mockResolvedValueOnce([]);
    readGracefulShutdownRequestMock.mockResolvedValue({
      version: 1,
      source: "discord",
      command: "quit after tasks",
      mode: "after-tasks",
      messageId: "9010",
      requestedAt: "2026-03-07T12:10:00.000Z",
      enforcedAt: null,
    });
    const { main } = await import("./main.js");

    await main();

    expect(runCodingAgentMock).toHaveBeenCalledTimes(2);
    expect(runCodingAgentMock).toHaveBeenNthCalledWith(1, "Issue #401: First queued task\n\none");
    expect(runCodingAgentMock).toHaveBeenNthCalledWith(2, "Issue #402: Second queued task\n\ntwo");
    expect(runPlannerAgentMock).not.toHaveBeenCalled();
    expect(markGracefulShutdownRequestEnforcedMock).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(
      "Graceful shutdown requested via Discord quit after tasks. Queue-drain shutdown is active. Planning and replenishment are disabled, so no new work will be started. Shutdown intent remains persisted so later restarts do not resume work unexpectedly.",
    );
    expect(notifyRuntimeQuittingInDiscordMock).toHaveBeenCalledWith(
      "Graceful shutdown via quit after tasks is being enforced. Queue-drain shutdown is active. Planning and replenishment are disabled, so no new work will be started.",
    );
  });

  it("keeps honoring an already-enforced queue-drain shutdown request after restart", async () => {
    readGracefulShutdownRequestMock.mockResolvedValue({
      version: 1,
      source: "discord",
      command: "quit after tasks",
      mode: "after-tasks",
      messageId: "9011",
      requestedAt: "2026-03-07T12:15:00.000Z",
      enforcedAt: "2026-03-07T12:20:00.000Z",
    });
    const { main } = await import("./main.js");

    await main();

    expect(listOpenIssuesMock).not.toHaveBeenCalled();
    expect(runCodingAgentMock).not.toHaveBeenCalled();
    expect(markGracefulShutdownRequestEnforcedMock).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(
      "Graceful shutdown requested via Discord quit after tasks. Stopping before starting a new task. Shutdown intent remains persisted so later restarts do not resume work unexpectedly.",
    );
    expect(notifyRuntimeQuittingInDiscordMock).toHaveBeenCalledWith(
      "Graceful shutdown via quit after tasks is being enforced. Stopping before starting a new task.",
    );
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
    expect(transitionCanonicalLifecycleStateMock).toHaveBeenCalledWith(
      "/tmp/evolvo",
      expect.objectContaining({
        issueNumber: 88,
        nextState: "completed",
      }),
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
    expect(transitionCanonicalLifecycleStateMock).toHaveBeenCalledWith(
      "/tmp/evolvo",
      expect.objectContaining({
        issueNumber: 92,
        nextState: "amended",
      }),
    );
    expect(transitionCanonicalLifecycleStateMock).not.toHaveBeenCalledWith(
      "/tmp/evolvo",
      expect.objectContaining({
        issueNumber: 92,
        nextState: "rejected",
      }),
    );
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
