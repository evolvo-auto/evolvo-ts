import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectBoardIssueItem } from "../../github/githubProjectsV2.js";
import { buildDefaultProjectRecord } from "../../projects/projectRegistry.js";
import {
  buildWorkerClaimFromBoardItem,
  claimProjectBoardItemForWorker,
  clearWorkflowWorkerClaim,
  listProjectBoardItemsInStage,
  selectNextProjectBoardItemInStage,
} from "./boardClaims.js";
import { registerWorkflowWorker } from "./workerHeartbeat.js";
import { getWorkflowWorkerRecord } from "./workflowWorkerState.js";

async function createTempWorkDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "board-claims-"));
}

function createBoardItem(overrides: Partial<ProjectBoardIssueItem> = {}): ProjectBoardIssueItem {
  return {
    itemId: overrides.itemId ?? "item-1",
    issueNodeId: overrides.issueNodeId ?? "issue-node-1",
    issueNumber: overrides.issueNumber ?? 1,
    title: overrides.title ?? "Issue 1",
    body: overrides.body ?? "Issue body",
    state: overrides.state ?? "OPEN",
    url: overrides.url ?? "https://github.com/Evolvo-org/evolvo-ts/issues/1",
    labels: overrides.labels ?? [],
    repository: overrides.repository ?? {
      owner: "Evolvo-org",
      repo: "evolvo-ts",
      url: "https://github.com/Evolvo-org/evolvo-ts",
      reference: "Evolvo-org/evolvo-ts",
    },
    stage: overrides.stage ?? "Ready for Dev",
    stageOptionId: overrides.stageOptionId ?? "option-1",
  };
}

describe("boardClaims", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("filters stage items and selects the lowest issue number first", () => {
    const items = [
      createBoardItem({ issueNumber: 12, stage: "In Dev" }),
      createBoardItem({ itemId: "item-2", issueNodeId: "issue-node-2", issueNumber: 3, stage: "In Dev" }),
      createBoardItem({ itemId: "item-3", issueNodeId: "issue-node-3", issueNumber: 7, stage: "Ready for Review" }),
    ];

    expect(listProjectBoardItemsInStage(items, "In Dev").map((item) => item.issueNumber)).toEqual([3, 12]);
    expect(selectNextProjectBoardItemInStage(items, "In Dev")?.issueNumber).toBe(3);
    expect(selectNextProjectBoardItemInStage(items, "Blocked")).toBeNull();
  });

  it("claims a board item and records the worker claim", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    const project = buildDefaultProjectRecord({
      owner: "Evolvo-org",
      repo: "evolvo-ts",
      workDir,
      defaultBranch: "main",
    });

    await registerWorkflowWorker({
      workDir,
      role: "dev",
      projectSlug: project.slug,
      pid: 4242,
      startedAt: "2026-03-08T10:00:00.000Z",
      heartbeatAt: "2026-03-08T10:00:00.000Z",
    });

    let items = [createBoardItem({ itemId: "item-77", issueNodeId: "issue-node-77", issueNumber: 77, stage: "Ready for Dev" })];
    const moveProjectItemToStage = vi.fn(async (_project, itemId: string, stage) => {
      items = items.map((item) => item.itemId === itemId ? { ...item, stage } : item);
    });
    const boardsClient = {
      listProjectIssueItems: vi.fn(async () => items),
      moveProjectItemToStage,
    };

    const result = await claimProjectBoardItemForWorker({
      workDir,
      workerId: "dev:evolvo",
      project,
      boardsClient,
      itemId: "item-77",
      fromStage: "Ready for Dev",
      toStage: "In Dev",
      claimedAt: "2026-03-08T10:01:00.000Z",
    });

    expect(result).toEqual({
      claimed: true,
      reason: "claimed",
      item: expect.objectContaining({
        itemId: "item-77",
        issueNumber: 77,
        stage: "In Dev",
      }),
      claim: expect.objectContaining({
        issueNumber: 77,
        queueKey: "evolvo#77",
        stage: "In Dev",
        claimedAt: "2026-03-08T10:01:00.000Z",
      }),
    });
    expect(moveProjectItemToStage).toHaveBeenCalledWith(project, "item-77", "In Dev");

    await expect(getWorkflowWorkerRecord(workDir, "dev:evolvo")).resolves.toEqual(expect.objectContaining({
      currentClaim: expect.objectContaining({
        issueNumber: 77,
        stage: "In Dev",
      }),
      heartbeatAt: "2026-03-08T10:01:00.000Z",
    }));
  });

  it("does not claim when the board item stage already changed", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    const project = buildDefaultProjectRecord({
      owner: "Evolvo-org",
      repo: "evolvo-ts",
      workDir,
      defaultBranch: "main",
    });

    await registerWorkflowWorker({
      workDir,
      role: "review",
      pid: 9090,
      startedAt: "2026-03-08T10:00:00.000Z",
      heartbeatAt: "2026-03-08T10:00:00.000Z",
    });

    const boardsClient = {
      listProjectIssueItems: vi.fn(async () => [
        createBoardItem({ itemId: "item-21", issueNodeId: "issue-node-21", issueNumber: 21, stage: "In Review" }),
      ]),
      moveProjectItemToStage: vi.fn(),
    };

    const result = await claimProjectBoardItemForWorker({
      workDir,
      workerId: "review",
      project,
      boardsClient,
      itemId: "item-21",
      fromStage: "Ready for Review",
      toStage: "In Review",
    });

    expect(result).toEqual({
      claimed: false,
      reason: "stage-mismatch",
      item: expect.objectContaining({
        itemId: "item-21",
        stage: "In Review",
      }),
      claim: null,
    });
    expect(boardsClient.moveProjectItemToStage).not.toHaveBeenCalled();
    await expect(getWorkflowWorkerRecord(workDir, "review")).resolves.toEqual(expect.objectContaining({
      currentClaim: null,
    }));
  });

  it("clears the worker claim by writing a null claim heartbeat", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    await registerWorkflowWorker({
      workDir,
      role: "release",
      pid: 1111,
      startedAt: "2026-03-08T10:00:00.000Z",
      heartbeatAt: "2026-03-08T10:00:00.000Z",
      currentClaim: buildWorkerClaimFromBoardItem({
        item: {
          issueNumber: 18,
          stage: "Releasing",
          queueKey: "evolvo#18",
        },
        stage: "Releasing",
        claimedAt: "2026-03-08T10:00:00.000Z",
        pullRequestNumber: 91,
      }),
    });

    await expect(clearWorkflowWorkerClaim({
      workDir,
      workerId: "release",
      heartbeatAt: "2026-03-08T10:02:00.000Z",
    })).resolves.toBe(true);

    await expect(getWorkflowWorkerRecord(workDir, "release")).resolves.toEqual(expect.objectContaining({
      currentClaim: null,
      heartbeatAt: "2026-03-08T10:02:00.000Z",
    }));
  });
});