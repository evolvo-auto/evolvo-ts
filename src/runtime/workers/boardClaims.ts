import type { GitHubProjectsV2Client, ProjectBoardIssueItem } from "../../github/githubProjectsV2.js";
import type { ProjectRecord } from "../../projects/projectRegistry.js";
import type { ProjectWorkflowStage } from "../../projects/projectWorkflow.js";
import { getWorkflowWorkerRecord } from "./workflowWorkerState.js";
import { heartbeatWorkflowWorker } from "./workerHeartbeat.js";
import type { WorkerClaim } from "./workerTypes.js";

type WorkflowBoardClient = Pick<GitHubProjectsV2Client, "listProjectIssueItems" | "moveProjectItemToStage">;

export type BoardItemClaimResult = {
  claimed: boolean;
  reason: "claimed" | "worker-not-registered" | "item-not-found" | "stage-mismatch";
  item: ProjectBoardIssueItem | null;
  claim: WorkerClaim | null;
};

export function listProjectBoardItemsInStage(
  items: ProjectBoardIssueItem[],
  stage: ProjectWorkflowStage,
): ProjectBoardIssueItem[] {
  return items
    .filter((item) => item.stage === stage)
    .sort((left, right) => left.issueNumber - right.issueNumber);
}

export function selectNextProjectBoardItemInStage(
  items: ProjectBoardIssueItem[],
  stage: ProjectWorkflowStage,
): ProjectBoardIssueItem | null {
  return listProjectBoardItemsInStage(items, stage)[0] ?? null;
}

export function buildWorkerClaimFromBoardItem(options: {
  item: Pick<ProjectBoardIssueItem, "issueNumber" | "stage"> & { queueKey?: string | null };
  stage: ProjectWorkflowStage;
  claimedAt?: string;
  pullRequestNumber?: number | null;
}): WorkerClaim {
  return {
    issueNumber: options.item.issueNumber,
    pullRequestNumber: options.pullRequestNumber ?? null,
    queueKey: options.item.queueKey ?? null,
    stage: options.stage,
    claimedAt: options.claimedAt ?? new Date().toISOString(),
  };
}

export async function claimProjectBoardItemForWorker(options: {
  workDir: string;
  workerId: string;
  project: ProjectRecord;
  boardsClient: WorkflowBoardClient;
  itemId: string;
  fromStage: ProjectWorkflowStage;
  toStage: ProjectWorkflowStage;
  claimedAt?: string;
  pullRequestNumber?: number | null;
}): Promise<BoardItemClaimResult> {
  const existingWorker = await getWorkflowWorkerRecord(options.workDir, options.workerId);
  if (existingWorker === null) {
    return {
      claimed: false,
      reason: "worker-not-registered",
      item: null,
      claim: null,
    };
  }

  const currentItems = await options.boardsClient.listProjectIssueItems(options.project);
  const currentItem = currentItems.find((item) => item.itemId === options.itemId) ?? null;
  if (currentItem === null) {
    return {
      claimed: false,
      reason: "item-not-found",
      item: null,
      claim: null,
    };
  }

  if (currentItem.stage !== options.fromStage) {
    return {
      claimed: false,
      reason: "stage-mismatch",
      item: currentItem,
      claim: null,
    };
  }

  await options.boardsClient.moveProjectItemToStage(options.project, currentItem.itemId, options.toStage);

  const refreshedItems = await options.boardsClient.listProjectIssueItems(options.project);
  const claimedItem = refreshedItems.find((item) => item.itemId === options.itemId) ?? null;
  if (claimedItem === null) {
    return {
      claimed: false,
      reason: "item-not-found",
      item: null,
      claim: null,
    };
  }

  const claim = buildWorkerClaimFromBoardItem({
    item: {
      issueNumber: claimedItem.issueNumber,
      stage: claimedItem.stage,
      queueKey: `${options.project.slug}#${claimedItem.issueNumber}`,
    },
    stage: options.toStage,
    claimedAt: options.claimedAt,
    pullRequestNumber: options.pullRequestNumber,
  });

  await heartbeatWorkflowWorker({
    workDir: options.workDir,
    workerId: options.workerId,
    heartbeatAt: claim.claimedAt ?? options.claimedAt ?? new Date().toISOString(),
    currentClaim: claim,
  });

  return {
    claimed: true,
    reason: "claimed",
    item: claimedItem,
    claim,
  };
}

export async function clearWorkflowWorkerClaim(options: {
  workDir: string;
  workerId: string;
  heartbeatAt?: string;
}): Promise<boolean> {
  const updated = await heartbeatWorkflowWorker({
    workDir: options.workDir,
    workerId: options.workerId,
    heartbeatAt: options.heartbeatAt,
    currentClaim: null,
  });

  return updated !== null;
}