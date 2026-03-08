import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StagedProjectInventory, StagedWorkInventory, StagedWorkItem } from "../../issues/stagedWorkInventory.js";
import type { ProjectRecord } from "../../projects/projectRegistry.js";
import { createDefaultProjectWorkflow } from "../../projects/projectWorkflow.js";

vi.mock("../../environment.js", () => ({
  OPENAI_API_KEY: "test-key",
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

describe("issueGeneratorWorker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("tops up inbox and planning backlog to five items per active project", async () => {
    const { runIssueGeneratorWorkerPass } = await import("./issueGeneratorWorker.js");
    const project = createProject();
    const inventory = createInventory(project, [
      createItem(project, 1, "Planning"),
      createItem(project, 2, "Planning"),
    ]);

    const createIssue = vi.fn()
      .mockResolvedValueOnce({ ok: true, issue: { number: 101 } })
      .mockResolvedValueOnce({ ok: true, issue: { number: 102 } })
      .mockResolvedValueOnce({ ok: true, issue: { number: 103 } });
    const trackerIssueManager = {
      forRepository: vi.fn().mockReturnValue({
        listOpenIssues: vi.fn().mockResolvedValue([]),
        listRecentClosedIssues: vi.fn().mockResolvedValue([]),
        createIssue,
      }),
    };
    const boardsClient = {
      ensureRepositoryIssueItem: vi.fn()
        .mockResolvedValueOnce({ itemId: "item-101" })
        .mockResolvedValueOnce({ itemId: "item-102" })
        .mockResolvedValueOnce({ itemId: "item-103" }),
      moveProjectItemToStage: vi.fn().mockResolvedValue(undefined),
    };
    const issueGeneratorAgent = vi.fn().mockResolvedValue([
      { title: "Idea 1", description: "Desc 1" },
      { title: "Idea 2", description: "Desc 2" },
      { title: "Idea 3", description: "Desc 3" },
    ]);

    await expect(runIssueGeneratorWorkerPass({
      inventory,
      trackerIssueManager: trackerIssueManager as never,
      boardsClient: boardsClient as never,
      issueGeneratorAgent,
    })).resolves.toBe(3);

    expect(issueGeneratorAgent).toHaveBeenCalledWith(expect.objectContaining({
      maxIssues: 3,
      projectSlug: "evolvo-web",
    }));
    expect(createIssue).toHaveBeenCalledTimes(3);
    expect(boardsClient.moveProjectItemToStage).toHaveBeenCalledWith(project, "item-101", "Inbox");
    expect(boardsClient.moveProjectItemToStage).toHaveBeenCalledWith(project, "item-102", "Inbox");
    expect(boardsClient.moveProjectItemToStage).toHaveBeenCalledWith(project, "item-103", "Inbox");
  });

  it("skips projects whose backlog already meets the idea-stage target", async () => {
    const { runIssueGeneratorWorkerPass } = await import("./issueGeneratorWorker.js");
    const project = createProject();
    const inventory = createInventory(project, [
      createItem(project, 1, "Inbox"),
      createItem(project, 2, "Inbox"),
      createItem(project, 3, "Planning"),
      createItem(project, 4, "Planning"),
      createItem(project, 5, "Planning"),
    ]);

    const issueGeneratorAgent = vi.fn();

    await expect(runIssueGeneratorWorkerPass({
      inventory,
      trackerIssueManager: { forRepository: vi.fn() } as never,
      boardsClient: {
        ensureRepositoryIssueItem: vi.fn(),
        moveProjectItemToStage: vi.fn(),
      } as never,
      issueGeneratorAgent,
    })).resolves.toBe(0);

    expect(issueGeneratorAgent).not.toHaveBeenCalled();
  });
});