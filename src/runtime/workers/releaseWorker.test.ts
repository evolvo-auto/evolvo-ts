import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StagedProjectInventory, StagedWorkInventory, StagedWorkItem } from "../../issues/stagedWorkInventory.js";
import type { ProjectRecord } from "../../projects/projectRegistry.js";
import { createDefaultProjectWorkflow } from "../../projects/projectWorkflow.js";
import { registerWorkflowWorker } from "./workerHeartbeat.js";
import { getWorkflowWorkerRecord } from "./workflowWorkerState.js";

const {
  getWorkflowWorkItemRecordMock,
  readWorkflowAgentStateMock,
  updateWorkflowAgentStateMock,
  recordProjectFailureMock,
} = vi.hoisted(() => ({
  getWorkflowWorkItemRecordMock: vi.fn(),
  readWorkflowAgentStateMock: vi.fn(),
  updateWorkflowAgentStateMock: vi.fn(),
  recordProjectFailureMock: vi.fn(),
}));

vi.mock("../workflowWorkItemState.js", () => ({
  getWorkflowWorkItemRecord: getWorkflowWorkItemRecordMock,
}));

vi.mock("../workflowAgentState.js", () => ({
  readWorkflowAgentState: readWorkflowAgentStateMock,
  updateWorkflowAgentState: updateWorkflowAgentStateMock,
}));

vi.mock("../../projects/projectActivityState.js", () => ({
  recordProjectFailure: recordProjectFailureMock,
}));

function createProject(slug = "evolvo-web"): ProjectRecord {
  return {
    slug,
    displayName: slug,
    kind: "managed",
    issueLabel: `project:${slug}`,
    trackerRepo: {
      owner: "Evolvo-org",
      repo: "evolvo-ts",
      url: "https://github.com/Evolvo-org/evolvo-ts",
    },
    executionRepo: {
      owner: "Evolvo-org",
      repo: slug,
      url: `https://github.com/Evolvo-org/${slug}`,
      defaultBranch: "main",
    },
    cwd: `/tmp/${slug}`,
    status: "active",
    sourceIssueNumber: 101,
    createdAt: "2026-03-08T00:00:00.000Z",
    updatedAt: "2026-03-08T00:00:00.000Z",
    provisioning: {
      labelCreated: true,
      repoCreated: true,
      workspacePrepared: true,
      lastError: null,
    },
    workflow: createDefaultProjectWorkflow("Evolvo-org"),
  };
}

function createItem(project: ProjectRecord, issueNumber: number, stage: StagedWorkItem["stage"]): StagedWorkItem {
  return {
    queueKey: `${project.slug}#${issueNumber}`,
    project,
    issueNumber,
    issueUrl: `https://github.com/${project.executionRepo.owner}/${project.executionRepo.repo}/issues/${issueNumber}`,
    title: `Issue ${issueNumber}`,
    description: `Description ${issueNumber}`,
    labels: [],
    stage,
    boardItemId: `item-${issueNumber}`,
    issueNodeId: `issue-node-${issueNumber}`,
    repository: {
      owner: project.executionRepo.owner,
      repo: project.executionRepo.repo,
      url: project.executionRepo.url,
      reference: `${project.executionRepo.owner}/${project.executionRepo.repo}`,
    },
  };
}

function createInventory(project: ProjectRecord, items: StagedWorkItem[]): StagedWorkInventory {
  const projectInventory: StagedProjectInventory = {
    project,
    activity: {
      slug: project.slug,
      activityState: "active",
      deferredStopMode: null,
      requestedBy: "operator",
      updatedAt: "2026-03-08T00:00:00.000Z",
      currentCodingLease: null,
      currentWorkItem: null,
      lastStageTransition: null,
      schedulingEligibility: { eligible: true, reason: null, lastScheduledAt: null },
      lastFailure: null,
    },
    items,
    countsByStage: {
      Inbox: items.filter((item) => item.stage === "Inbox").length,
      Planning: items.filter((item) => item.stage === "Planning").length,
      "Ready for Dev": items.filter((item) => item.stage === "Ready for Dev").length,
      "In Dev": items.filter((item) => item.stage === "In Dev").length,
      "Ready for Review": items.filter((item) => item.stage === "Ready for Review").length,
      "In Review": items.filter((item) => item.stage === "In Review").length,
      "Ready for Release": items.filter((item) => item.stage === "Ready for Release").length,
      Releasing: items.filter((item) => item.stage === "Releasing").length,
      Blocked: items.filter((item) => item.stage === "Blocked").length,
      Done: items.filter((item) => item.stage === "Done").length,
    },
  };

  return {
    projects: [projectInventory],
    activityState: {
      version: 1,
      projects: [projectInventory.activity],
    },
  };
}

async function createTempWorkDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "release-worker-"));
}

describe("releaseWorker", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    readWorkflowAgentStateMock.mockResolvedValue({
      version: 1,
      reviewCursorProjectSlug: null,
      releaseCursorProjectSlug: null,
    });
    updateWorkflowAgentStateMock.mockResolvedValue(undefined);
    recordProjectFailureMock.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("claims, merges, closes the issue, and moves the item to Done", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    const project = createProject();
    const inventory = createInventory(project, [createItem(project, 33, "Ready for Release")]);
    const { runReleaseWorkerPass } = await import("./releaseWorker.js");

    await registerWorkflowWorker({
      workDir,
      role: "release",
      pid: 8001,
      startedAt: "2026-03-08T10:00:00.000Z",
      heartbeatAt: "2026-03-08T10:00:00.000Z",
    });

    getWorkflowWorkItemRecordMock.mockResolvedValue({
      queueKey: "evolvo-web#33",
      projectSlug: "evolvo-web",
      issueNumber: 33,
      branchName: null,
      pullRequestUrl: "https://github.com/Evolvo-org/evolvo-web/pull/22",
      validationCommands: [],
      failedValidationCommands: [],
      implementationSummary: "Implemented feature.",
      reviewOutcome: "approved",
      reviewSummary: "Looks good.",
      updatedAt: "2026-03-08T10:00:00.000Z",
    });

    let boardItems = [{
      itemId: "item-33",
      issueNodeId: "issue-node-33",
      issueNumber: 33,
      title: "Issue 33",
      body: "Description 33",
      state: "OPEN" as const,
      url: "https://github.com/Evolvo-org/evolvo-web/issues/33",
      labels: [],
      repository: {
        owner: "Evolvo-org",
        repo: "evolvo-web",
        url: "https://github.com/Evolvo-org/evolvo-web",
        reference: "Evolvo-org/evolvo-web",
      },
      stage: "Ready for Release" as const,
      stageOptionId: "option-release",
    }];
    const boardsClient = {
      listProjectIssueItems: vi.fn(async () => boardItems),
      moveProjectItemToStage: vi.fn(async (_project, itemId: string, stage) => {
        boardItems = boardItems.map((item) => item.itemId === itemId ? { ...item, stage } : item);
      }),
    };
    const closeIssue = vi.fn().mockResolvedValue(undefined);
    const trackerIssueManager = {
      forRepository: vi.fn().mockReturnValue({ closeIssue }),
    };
    const releaseAgent = vi.fn().mockResolvedValue({
      mergedPullRequest: true,
      finalResponse: "merged",
    });

    await expect(runReleaseWorkerPass({
      workDir,
      workerId: "release",
      inventory,
      boardsClient,
      trackerIssueManager: trackerIssueManager as never,
      releaseAgent,
    })).resolves.toBe(true);

    expect(boardsClient.moveProjectItemToStage).toHaveBeenCalledWith(project, "item-33", "Releasing");
    expect(boardsClient.moveProjectItemToStage).toHaveBeenCalledWith(project, "item-33", "Done");
    expect(closeIssue).toHaveBeenCalledWith(33);
    expect(updateWorkflowAgentStateMock).toHaveBeenCalledWith(workDir, {
      releaseCursorProjectSlug: "evolvo-web",
    });
    await expect(getWorkflowWorkerRecord(workDir, "release")).resolves.toEqual(expect.objectContaining({
      currentClaim: null,
    }));
  });

  it("blocks releases that do not merge successfully", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    const project = createProject();
    const inventory = createInventory(project, [createItem(project, 34, "Ready for Release")]);
    const { runReleaseWorkerPass } = await import("./releaseWorker.js");

    await registerWorkflowWorker({
      workDir,
      role: "release",
      pid: 8002,
      startedAt: "2026-03-08T10:00:00.000Z",
      heartbeatAt: "2026-03-08T10:00:00.000Z",
    });

    getWorkflowWorkItemRecordMock.mockResolvedValue({
      queueKey: "evolvo-web#34",
      projectSlug: "evolvo-web",
      issueNumber: 34,
      branchName: null,
      pullRequestUrl: "https://github.com/Evolvo-org/evolvo-web/pull/23",
      validationCommands: [],
      failedValidationCommands: [],
      implementationSummary: "Implemented feature.",
      reviewOutcome: "approved",
      reviewSummary: "Looks good.",
      updatedAt: "2026-03-08T10:00:00.000Z",
    });

    let boardItems = [{
      itemId: "item-34",
      issueNodeId: "issue-node-34",
      issueNumber: 34,
      title: "Issue 34",
      body: "Description 34",
      state: "OPEN" as const,
      url: "https://github.com/Evolvo-org/evolvo-web/issues/34",
      labels: [],
      repository: {
        owner: "Evolvo-org",
        repo: "evolvo-web",
        url: "https://github.com/Evolvo-org/evolvo-web",
        reference: "Evolvo-org/evolvo-web",
      },
      stage: "Ready for Release" as const,
      stageOptionId: "option-release",
    }];
    const boardsClient = {
      listProjectIssueItems: vi.fn(async () => boardItems),
      moveProjectItemToStage: vi.fn(async (_project, itemId: string, stage) => {
        boardItems = boardItems.map((item) => item.itemId === itemId ? { ...item, stage } : item);
      }),
    };
    const trackerIssueManager = {
      forRepository: vi.fn().mockReturnValue({ closeIssue: vi.fn() }),
    };
    const releaseAgent = vi.fn().mockResolvedValue({
      mergedPullRequest: false,
      finalResponse: "not merged",
    });

    await expect(runReleaseWorkerPass({
      workDir,
      workerId: "release",
      inventory,
      boardsClient,
      trackerIssueManager: trackerIssueManager as never,
      releaseAgent,
    })).resolves.toBe(true);

    expect(boardsClient.moveProjectItemToStage).toHaveBeenCalledWith(project, "item-34", "Releasing");
    expect(boardsClient.moveProjectItemToStage).toHaveBeenCalledWith(project, "item-34", "Blocked");
    expect(recordProjectFailureMock).toHaveBeenCalledWith(expect.objectContaining({
      slug: "evolvo-web",
      stage: "release",
    }));
  });
});