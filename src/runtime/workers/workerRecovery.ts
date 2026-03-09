import type { GitHubProjectsV2Client } from "../../github/githubProjectsV2.js";
import type { TaskIssueManager } from "../../issues/taskIssueManager.js";
import {
  readProjectRegistry,
  type DefaultProjectContext,
} from "../../projects/projectRegistry.js";
import {
  releaseCodingLease,
  setProjectCurrentWorkItem,
} from "../../projects/projectActivityState.js";
import type { ProjectWorkflowStage } from "../../projects/projectWorkflow.js";
import { buildWorkerInventory } from "./boardQueries.js";
import {
  DEFAULT_WORKER_HEARTBEAT_TTL_MS,
  isWorkerHeartbeatExpired,
} from "./workerHeartbeat.js";
import type { WorkerProcessRecord } from "./workerTypes.js";

function parseProjectSlugFromQueueKey(queueKey: string | null): string | null {
  if (!queueKey) {
    return null;
  }

  const separatorIndex = queueKey.indexOf("#");
  if (separatorIndex <= 0) {
    return null;
  }

  const projectSlug = queueKey.slice(0, separatorIndex).trim();
  return projectSlug.length > 0 ? projectSlug : null;
}

function getClaimRecoveryStage(stage: string | null): ProjectWorkflowStage | null {
  switch (stage) {
    case "In Dev":
      return "Ready for Dev";
    case "In Review":
      return "Ready for Review";
    case "Releasing":
      return "Ready for Release";
    default:
      return null;
  }
}

function resolveClaimProjectSlug(worker: Pick<WorkerProcessRecord, "projectSlug" | "currentClaim">): string | null {
  return worker.projectSlug ?? parseProjectSlugFromQueueKey(worker.currentClaim?.queueKey ?? null);
}

async function clearDevProjectLeaseState(options: {
  workDir: string;
  projectSlug: string;
}): Promise<void> {
  await releaseCodingLease({
    workDir: options.workDir,
    slug: options.projectSlug,
  });
  await setProjectCurrentWorkItem({
    workDir: options.workDir,
    slug: options.projectSlug,
    workItem: null,
  });
}

export async function recoverExpiredWorkflowWorkerClaims(options: {
  workDir: string;
  currentWorkers: WorkerProcessRecord[];
  defaultProject: DefaultProjectContext;
  boardsClient: Pick<GitHubProjectsV2Client, "listProjectIssueItems" | "moveProjectItemToStage">;
  now?: string;
  heartbeatTimeoutMs?: number;
}): Promise<number> {
  const registry = await readProjectRegistry(options.workDir, options.defaultProject);
  const projectsBySlug = new Map(registry.projects.map((project) => [project.slug, project] as const));
  const expiredWorkers = options.currentWorkers.filter((worker) => isWorkerHeartbeatExpired({
    worker,
    now: options.now,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? DEFAULT_WORKER_HEARTBEAT_TTL_MS,
  }));

  let recoveredCount = 0;
  for (const worker of expiredWorkers) {
    const issueNumber = worker.currentClaim?.issueNumber ?? null;
    const claimedStage = worker.currentClaim?.stage ?? null;
    const recoveryStage = getClaimRecoveryStage(claimedStage);
    const projectSlug = resolveClaimProjectSlug(worker);
    if (issueNumber === null || !claimedStage || !recoveryStage || !projectSlug) {
      continue;
    }

    const project = projectsBySlug.get(projectSlug) ?? null;
    if (project === null) {
      continue;
    }

    const boardItems = await options.boardsClient.listProjectIssueItems(project);
    const boardItem = boardItems.find((item) => item.issueNumber === issueNumber) ?? null;
    if (boardItem === null || boardItem.stage !== claimedStage) {
      continue;
    }

    await options.boardsClient.moveProjectItemToStage(project, boardItem.itemId, recoveryStage);
    if (worker.role === "dev") {
      await clearDevProjectLeaseState({
        workDir: options.workDir,
        projectSlug,
      });
    }

    recoveredCount += 1;
    console.log(
      `[supervisor] recovered stale claim ${worker.workerId} #${issueNumber} ${claimedStage} -> ${recoveryStage}.`,
    );
  }

  return recoveredCount;
}

export async function reconcileStaleDevProjectLeases(options: {
  workDir: string;
  inventory: Awaited<ReturnType<typeof buildWorkerInventory>>;
}): Promise<number> {
  let clearedCount = 0;

  for (const projectInventory of options.inventory.projects) {
    const currentLease = projectInventory.activity?.currentCodingLease;
    if (!currentLease) {
      continue;
    }

    const matchingInDevItem = projectInventory.items.find((item) =>
      item.issueNumber === currentLease.issueNumber && item.stage === "In Dev"
    ) ?? null;
    if (matchingInDevItem) {
      continue;
    }

    await clearDevProjectLeaseState({
      workDir: options.workDir,
      projectSlug: projectInventory.project.slug,
    });
    clearedCount += 1;
    console.log(
      `[supervisor] cleared stale dev lease for ${projectInventory.project.slug} #${currentLease.issueNumber} because board state is no longer In Dev.`,
    );
  }

  return clearedCount;
}

export async function reconcileWorkflowSupervisorState(options: {
  workDir: string;
  currentWorkers: WorkerProcessRecord[];
  defaultProject: DefaultProjectContext;
  trackerIssueManager: TaskIssueManager;
  boardsClient: Pick<GitHubProjectsV2Client, "listProjectIssueItems" | "moveProjectItemToStage" | "ensureRepositoryIssueItem">;
  now?: string;
  heartbeatTimeoutMs?: number;
}): Promise<{ recoveredClaims: number; clearedStaleLeases: number }> {
  const recoveredClaims = await recoverExpiredWorkflowWorkerClaims({
    workDir: options.workDir,
    currentWorkers: options.currentWorkers,
    defaultProject: options.defaultProject,
    boardsClient: options.boardsClient,
    now: options.now,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs,
  });
  const inventory = await buildWorkerInventory({
    workDir: options.workDir,
    defaultProject: options.defaultProject,
    trackerIssueManager: options.trackerIssueManager,
    boardsClient: options.boardsClient,
  });
  const clearedStaleLeases = await reconcileStaleDevProjectLeases({
    workDir: options.workDir,
    inventory,
  });

  return {
    recoveredClaims,
    clearedStaleLeases,
  };
}