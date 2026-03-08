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
  upsertWorkflowWorkItemRecordMock,
  readWorkflowAgentStateMock,
  updateWorkflowAgentStateMock,
  recordProjectFailureMock,
} = vi.hoisted(() => ({
  getWorkflowWorkItemRecordMock: vi.fn(),
  upsertWorkflowWorkItemRecordMock: vi.fn(),
  readWorkflowAgentStateMock: vi.fn(),
  updateWorkflowAgentStateMock: vi.fn(),
  recordProjectFailureMock: vi.fn(),
}));

vi.mock("../../environment.js", () => ({
  OPENAI_API_KEY: "test-key",
}));

vi.mock("../workflowWorkItemState.js", () => ({
  getWorkflowWorkItemRecord: getWorkflowWorkItemRecordMock,
  upsertWorkflowWorkItemRecord: upsertWorkflowWorkItemRecordMock,
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
    displayName: "Evolvo Web",
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
  return mkdtemp(join(tmpdir(), "review-worker-"));
}

describe("reviewWorker", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    readWorkflowAgentStateMock.mockResolvedValue({
      version: 1,
      reviewCursorProjectSlug: null,
      releaseCursorProjectSlug: null,
    });
    updateWorkflowAgentStateMock.mockResolvedValue(undefined);
    upsertWorkflowWorkItemRecordMock.mockResolvedValue(undefined);
    recordProjectFailureMock.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("claims, reviews, and advances an item to Ready for Release", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    const project = createProject();
    const inventory = createInventory(project, [createItem(project, 27, "Ready for Review")]);
    const { runReviewWorkerPass } = await import("./reviewWorker.js");

    await registerWorkflowWorker({
      workDir,
      role: "review",
      pid: 7001,
      startedAt: "2026-03-08T10:00:00.000Z",
      heartbeatAt: "2026-03-08T10:00:00.000Z",
    });

    getWorkflowWorkItemRecordMock.mockResolvedValue({
      queueKey: "evolvo-web#27",
      projectSlug: "evolvo-web",
      issueNumber: 27,
      branchName: null,
      pullRequestUrl: "https://github.com/Evolvo-org/evolvo-web/pull/12",
      validationCommands: [],
      failedValidationCommands: [],
      implementationSummary: "Implemented feature.",
      reviewOutcome: null,
      reviewSummary: null,
      updatedAt: "2026-03-08T10:00:00.000Z",
    });

    let boardItems = [{
      itemId: "item-27",
      issueNodeId: "issue-node-27",
      issueNumber: 27,
      title: "Issue 27",
      body: "Description 27",
      state: "OPEN" as const,
      url: "https://github.com/Evolvo-org/evolvo-web/issues/27",
      labels: [],
      repository: {
        owner: "Evolvo-org",
        repo: "evolvo-web",
        url: "https://github.com/Evolvo-org/evolvo-web",
        reference: "Evolvo-org/evolvo-web",
      },
      stage: "Ready for Review" as const,
      stageOptionId: "option-review",
    }];
    const boardsClient = {
      listProjectIssueItems: vi.fn(async () => boardItems),
      moveProjectItemToStage: vi.fn(async (_project, itemId: string, stage) => {
        boardItems = boardItems.map((item) => item.itemId === itemId ? { ...item, stage } : item);
      }),
    };
    const pullRequestClient = {
      submitReview: vi.fn().mockResolvedValue(undefined),
    };
    const reviewAgent = vi.fn().mockResolvedValue({
      decision: "approve",
      summary: "Looks good.",
      reasons: ["Validation passed."],
      finalResponse: "{}",
    });

    await expect(runReviewWorkerPass({
      workDir,
      workerId: "review",
      inventory,
      boardsClient,
      pullRequestClient,
      reviewAgent,
    })).resolves.toBe(true);

    expect(boardsClient.moveProjectItemToStage).toHaveBeenCalledWith(project, "item-27", "In Review");
    expect(boardsClient.moveProjectItemToStage).toHaveBeenCalledWith(project, "item-27", "Ready for Release");
    expect(pullRequestClient.submitReview).toHaveBeenCalledWith(expect.objectContaining({
      owner: "Evolvo-org",
      repo: "evolvo-web",
      pullNumber: 12,
      event: "APPROVE",
    }));
    expect(upsertWorkflowWorkItemRecordMock).toHaveBeenCalledWith(workDir, expect.objectContaining({
      reviewOutcome: "approved",
      reviewSummary: "Looks good.",
    }));
    expect(updateWorkflowAgentStateMock).toHaveBeenCalledWith(workDir, {
      reviewCursorProjectSlug: "evolvo-web",
    });
    await expect(getWorkflowWorkerRecord(workDir, "review")).resolves.toEqual(expect.objectContaining({
      currentClaim: null,
    }));
  });

  it("blocks items missing PR metadata and advances the cursor", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    const project = createProject();
    const inventory = createInventory(project, [createItem(project, 9, "Ready for Review")]);
    const { runReviewWorkerPass } = await import("./reviewWorker.js");

    await registerWorkflowWorker({
      workDir,
      role: "review",
      pid: 7002,
      startedAt: "2026-03-08T10:00:00.000Z",
      heartbeatAt: "2026-03-08T10:00:00.000Z",
    });

    getWorkflowWorkItemRecordMock.mockResolvedValue(null);

    const boardsClient = {
      listProjectIssueItems: vi.fn(async () => []),
      moveProjectItemToStage: vi.fn().mockResolvedValue(undefined),
    };

    await expect(runReviewWorkerPass({
      workDir,
      workerId: "review",
      inventory,
      boardsClient,
      pullRequestClient: { submitReview: vi.fn() },
      reviewAgent: vi.fn(),
    })).resolves.toBe(true);

    expect(boardsClient.moveProjectItemToStage).toHaveBeenCalledWith(project, "item-9", "Blocked");
    expect(recordProjectFailureMock).toHaveBeenCalledWith(expect.objectContaining({
      slug: "evolvo-web",
      stage: "review",
    }));
    expect(updateWorkflowAgentStateMock).toHaveBeenCalledWith(workDir, {
      reviewCursorProjectSlug: "evolvo-web",
    });
  });
});