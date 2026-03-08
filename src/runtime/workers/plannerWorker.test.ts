import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StagedProjectInventory, StagedWorkInventory, StagedWorkItem } from "../../issues/stagedWorkInventory.js";
import type { ProjectRecord } from "../../projects/projectRegistry.js";
import { createDefaultProjectWorkflow } from "../../projects/projectWorkflow.js";

const { recordProjectStageTransitionMock } = vi.hoisted(() => ({
  recordProjectStageTransitionMock: vi.fn(),
}));

vi.mock("../../environment.js", () => ({
  OPENAI_API_KEY: "test-key",
}));

vi.mock("../../projects/projectActivityState.js", () => ({
  recordProjectStageTransition: recordProjectStageTransitionMock,
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

describe("plannerWorker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordProjectStageTransitionMock.mockResolvedValue(undefined);
  });

  it("rewrites inbox work, creates split issues, and moves the parent to Planning", async () => {
    const { runPlannerWorkerPass } = await import("./plannerWorker.js");
    const project = createProject();
    const inventory = createInventory(project, [createItem(project, 11, "Inbox")]);

    const issueManager = {
      listOpenIssues: vi.fn().mockResolvedValue([]),
      listRecentClosedIssues: vi.fn().mockResolvedValue([]),
      updateIssue: vi.fn().mockResolvedValue(undefined),
      createIssue: vi.fn().mockResolvedValue({ ok: true, issue: { number: 88 } }),
      updateLabels: vi.fn().mockResolvedValue(undefined),
    };
    const trackerIssueManager = {
      forRepository: vi.fn().mockReturnValue(issueManager),
    };
    const boardsClient = {
      ensureRepositoryIssueItem: vi.fn().mockResolvedValue({ itemId: "item-88" }),
      moveProjectItemToStage: vi.fn().mockResolvedValue(undefined),
    };
    const planningStageAgent = vi.fn().mockResolvedValue([{
      issueNumber: 11,
      decision: "planning",
      title: "Refined issue",
      description: "Refined description",
      splitIssues: [{ title: "Child issue", description: "Child description" }],
      reasons: ["Needs splitting."],
    }]);

    await expect(runPlannerWorkerPass({
      workDir: "/tmp/evolvo-ts",
      inventory,
      trackerIssueManager: trackerIssueManager as never,
      boardsClient: boardsClient as never,
      planningStageAgent,
    })).resolves.toEqual({
      movedToPlanning: 2,
      movedToReadyForDev: 0,
      blocked: 0,
    });

    expect(issueManager.updateIssue).toHaveBeenCalledWith(11, {
      title: "Refined issue",
      description: "Refined description",
    });
    expect(issueManager.createIssue).toHaveBeenCalledWith("Child issue", "Child description");
    expect(boardsClient.moveProjectItemToStage).toHaveBeenCalledWith(project, "item-88", "Planning");
    expect(boardsClient.moveProjectItemToStage).toHaveBeenCalledWith(project, "item-11", "Planning");
  });

  it("moves planning work to Ready for Dev when under the cap", async () => {
    const { runPlannerWorkerPass } = await import("./plannerWorker.js");
    const project = createProject();
    const inventory = createInventory(project, [createItem(project, 12, "Planning")]);

    const issueManager = {
      listOpenIssues: vi.fn().mockResolvedValue([]),
      listRecentClosedIssues: vi.fn().mockResolvedValue([]),
      updateIssue: vi.fn().mockResolvedValue(undefined),
      createIssue: vi.fn(),
      updateLabels: vi.fn().mockResolvedValue(undefined),
    };
    const trackerIssueManager = {
      forRepository: vi.fn().mockReturnValue(issueManager),
    };
    const boardsClient = {
      ensureRepositoryIssueItem: vi.fn(),
      moveProjectItemToStage: vi.fn().mockResolvedValue(undefined),
    };
    const planningStageAgent = vi.fn().mockResolvedValue([{
      issueNumber: 12,
      decision: "ready-for-dev",
      title: "Implementation ready",
      description: "Implementation ready description",
      splitIssues: [],
      reasons: ["Ready now."],
    }]);

    await expect(runPlannerWorkerPass({
      workDir: "/tmp/evolvo-ts",
      inventory,
      trackerIssueManager: trackerIssueManager as never,
      boardsClient: boardsClient as never,
      planningStageAgent,
    })).resolves.toEqual({
      movedToPlanning: 0,
      movedToReadyForDev: 1,
      blocked: 0,
    });

    expect(boardsClient.moveProjectItemToStage).toHaveBeenCalledWith(project, "item-12", "Ready for Dev");
  });
});