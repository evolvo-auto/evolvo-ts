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
  acquireCodingLeaseMock,
  recordProjectFailureMock,
  releaseCodingLeaseMock,
  setProjectCurrentWorkItemMock,
  upsertWorkflowWorkItemRecordMock,
  configureCodingAgentExecutionContextMock,
} = vi.hoisted(() => ({
  acquireCodingLeaseMock: vi.fn(),
  recordProjectFailureMock: vi.fn(),
  releaseCodingLeaseMock: vi.fn(),
  setProjectCurrentWorkItemMock: vi.fn(),
  upsertWorkflowWorkItemRecordMock: vi.fn(),
  configureCodingAgentExecutionContextMock: vi.fn(),
}));

vi.mock("../../projects/projectActivityState.js", () => ({
  acquireCodingLease: acquireCodingLeaseMock,
  recordProjectFailure: recordProjectFailureMock,
  releaseCodingLease: releaseCodingLeaseMock,
  setProjectCurrentWorkItem: setProjectCurrentWorkItemMock,
}));

vi.mock("../workflowWorkItemState.js", () => ({
  upsertWorkflowWorkItemRecord: upsertWorkflowWorkItemRecordMock,
}));

vi.mock("../../agents/runCodingAgent.js", () => ({
  configureCodingAgentExecutionContext: configureCodingAgentExecutionContextMock,
  runCodingAgent: vi.fn(),
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
  return mkdtemp(join(tmpdir(), "dev-worker-"));
}

describe("devWorker", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    acquireCodingLeaseMock.mockResolvedValue(undefined);
    recordProjectFailureMock.mockResolvedValue(undefined);
    releaseCodingLeaseMock.mockResolvedValue(undefined);
    setProjectCurrentWorkItemMock.mockResolvedValue(undefined);
    upsertWorkflowWorkItemRecordMock.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("claims ready work, runs the coding agent, and moves successful work to Ready for Review", async () => {
    const { runDevWorkerPass } = await import("./devWorker.js");
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    const project = createProject();
    const inventory = createInventory(project, [createItem(project, 41, "Ready for Dev")]);

    await registerWorkflowWorker({
      workDir,
      role: "dev",
      projectSlug: "evolvo-web",
      pid: 9001,
      startedAt: "2026-03-08T10:00:00.000Z",
      heartbeatAt: "2026-03-08T10:00:00.000Z",
    });

    let boardItems = [{
      itemId: "item-41",
      issueNodeId: "issue-node-41",
      issueNumber: 41,
      title: "Issue 41",
      body: "Description 41",
      state: "OPEN" as const,
      url: "https://github.com/Evolvo-org/evolvo-web/issues/41",
      labels: [],
      repository: {
        owner: "Evolvo-org",
        repo: "evolvo-web",
        url: "https://github.com/Evolvo-org/evolvo-web",
        reference: "Evolvo-org/evolvo-web",
      },
      stage: "Ready for Dev" as const,
      stageOptionId: "option-dev",
    }];
    const boardsClient = {
      listProjectIssueItems: vi.fn(async () => boardItems),
      moveProjectItemToStage: vi.fn(async (_project, itemId: string, stage) => {
        boardItems = boardItems.map((item) => item.itemId === itemId ? { ...item, stage } : item);
      }),
    };
    const codingAgent = vi.fn().mockResolvedValue({
      mergedPullRequest: false,
      summary: {
        inspectedAreas: [],
        editedFiles: [],
        validationCommands: [],
        failedValidationCommands: [],
        reviewOutcome: "accepted",
        pullRequestCreated: true,
        pullRequestUrls: ["https://github.com/Evolvo-org/evolvo-web/pull/55"],
        externalRepositories: [],
        externalPullRequests: [],
        mergedExternalPullRequest: false,
        finalResponse: "Implemented feature.",
      },
    });

    await expect(runDevWorkerPass({
      workDir,
      workerId: "dev:evolvo-web",
      projectSlug: "evolvo-web",
      inventory,
      boardsClient,
      codingAgent,
    })).resolves.toBe(true);

    expect(boardsClient.moveProjectItemToStage).toHaveBeenCalledWith(project, "item-41", "Ready for Review");
    expect(acquireCodingLeaseMock).toHaveBeenCalledWith(expect.objectContaining({ slug: "evolvo-web", issueNumber: 41 }));
    expect(upsertWorkflowWorkItemRecordMock).toHaveBeenCalledWith(workDir, expect.objectContaining({
      queueKey: "evolvo-web#41",
      pullRequestUrl: "https://github.com/Evolvo-org/evolvo-web/pull/55",
    }));
    await expect(getWorkflowWorkerRecord(workDir, "dev:evolvo-web")).resolves.toEqual(expect.objectContaining({
      currentClaim: null,
    }));
  });

  it("blocks the item and records a failure when the coding agent throws", async () => {
    const { runDevWorkerPass } = await import("./devWorker.js");
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    const project = createProject();
    const inventory = createInventory(project, [createItem(project, 42, "Ready for Dev")]);

    await registerWorkflowWorker({
      workDir,
      role: "dev",
      projectSlug: "evolvo-web",
      pid: 9002,
      startedAt: "2026-03-08T10:00:00.000Z",
      heartbeatAt: "2026-03-08T10:00:00.000Z",
    });

    let boardItems = [{
      itemId: "item-42",
      issueNodeId: "issue-node-42",
      issueNumber: 42,
      title: "Issue 42",
      body: "Description 42",
      state: "OPEN" as const,
      url: "https://github.com/Evolvo-org/evolvo-web/issues/42",
      labels: [],
      repository: {
        owner: "Evolvo-org",
        repo: "evolvo-web",
        url: "https://github.com/Evolvo-org/evolvo-web",
        reference: "Evolvo-org/evolvo-web",
      },
      stage: "Ready for Dev" as const,
      stageOptionId: "option-dev",
    }];
    const boardsClient = {
      listProjectIssueItems: vi.fn(async () => boardItems),
      moveProjectItemToStage: vi.fn(async (_project, itemId: string, stage) => {
        boardItems = boardItems.map((item) => item.itemId === itemId ? { ...item, stage } : item);
      }),
    };
    const codingAgent = vi.fn().mockRejectedValue(new Error("boom"));

    await expect(runDevWorkerPass({
      workDir,
      workerId: "dev:evolvo-web",
      projectSlug: "evolvo-web",
      inventory,
      boardsClient,
      codingAgent,
    })).resolves.toBe(false);

    expect(boardsClient.moveProjectItemToStage).toHaveBeenCalledWith(project, "item-42", "Blocked");
    expect(recordProjectFailureMock).toHaveBeenCalledWith(expect.objectContaining({
      slug: "evolvo-web",
      stage: "dev",
    }));
    expect(releaseCodingLeaseMock).toHaveBeenCalledWith(expect.objectContaining({ slug: "evolvo-web" }));
  });
});