import {
  configureCodingAgentExecutionContext,
  runCodingAgent,
  type CodingAgentRunResult,
} from "../../agents/runCodingAgent.js";
import type { GitHubProjectsV2Client } from "../../github/githubProjectsV2.js";
import type { StagedProjectInventory, StagedWorkInventory } from "../../issues/stagedWorkInventory.js";
import {
  acquireCodingLease,
  recordProjectFailure,
  releaseCodingLease,
  setProjectCurrentWorkItem,
} from "../../projects/projectActivityState.js";
import { buildPromptFromIssue } from "../loopUtils.js";
import { upsertWorkflowWorkItemRecord } from "../workflowWorkItemState.js";
import { claimProjectBoardItemForWorker, clearWorkflowWorkerClaim } from "./boardClaims.js";
import { isWorkerActiveProject, selectLowestIssueStageItem } from "./boardQueries.js";

const IN_DEV_LIMIT_PER_PROJECT = 1;

function logDevWorker(projectSlug: string, message: string): void {
  console.log(`[worker][dev][${projectSlug}] ${message}`);
}

function findRunnableProject(inventory: StagedWorkInventory, projectSlug: string): StagedProjectInventory | null {
  const projectInventory = inventory.projects.find((project) => project.project.slug === projectSlug) ?? null;
  if (!projectInventory || !isWorkerActiveProject(projectInventory)) {
    return null;
  }

  if (projectInventory.activity?.currentCodingLease !== null) {
    return null;
  }

  if (projectInventory.countsByStage["In Dev"] >= IN_DEV_LIMIT_PER_PROJECT) {
    return null;
  }

  return projectInventory;
}

export async function runDevWorkerPass(options: {
  workDir: string;
  workerId: string;
  projectSlug: string;
  inventory: StagedWorkInventory;
  boardsClient: Pick<GitHubProjectsV2Client, "listProjectIssueItems" | "moveProjectItemToStage">;
  codingAgent?: (prompt: string) => Promise<CodingAgentRunResult>;
}): Promise<boolean> {
  const projectInventory = findRunnableProject(options.inventory, options.projectSlug);
  if (!projectInventory) {
    return false;
  }

  const readyItem = selectLowestIssueStageItem(projectInventory.items, "Ready for Dev");
  if (!readyItem) {
    return false;
  }

  const claimResult = await claimProjectBoardItemForWorker({
    workDir: options.workDir,
    workerId: options.workerId,
    project: projectInventory.project,
    boardsClient: options.boardsClient,
    itemId: readyItem.boardItemId,
    fromStage: "Ready for Dev",
    toStage: "In Dev",
  });
  if (!claimResult.claimed) {
    return false;
  }

  await acquireCodingLease({
    workDir: options.workDir,
    slug: projectInventory.project.slug,
    issueNumber: readyItem.issueNumber,
    holder: "dev-agent",
  });
  await setProjectCurrentWorkItem({
    workDir: options.workDir,
    slug: projectInventory.project.slug,
    workItem: {
      issueNumber: readyItem.issueNumber,
      issueUrl: readyItem.issueUrl,
      stage: "In Dev",
      branchName: null,
      pullRequestUrl: null,
    },
  });
  logDevWorker(projectInventory.project.slug, `claimed #${readyItem.issueNumber} and moved it to In Dev.`);

  try {
    configureCodingAgentExecutionContext({
      workDir: projectInventory.project.cwd,
      internalRepositoryUrls: [
        projectInventory.project.executionRepo.url,
        projectInventory.project.trackerRepo.url,
      ],
    });
    const runResult = await (options.codingAgent ?? runCodingAgent)(buildPromptFromIssue({
      number: readyItem.issueNumber,
      title: readyItem.title,
      description: readyItem.description,
      state: "open",
      labels: readyItem.labels,
    }));
    const pullRequestUrl = runResult.summary.pullRequestUrls[0] ?? null;
    const nextStage = pullRequestUrl ? "Ready for Review" : "Blocked";
    await options.boardsClient.moveProjectItemToStage(projectInventory.project, readyItem.boardItemId, nextStage);
    await upsertWorkflowWorkItemRecord(options.workDir, {
      queueKey: readyItem.queueKey,
      projectSlug: projectInventory.project.slug,
      issueNumber: readyItem.issueNumber,
      branchName: null,
      pullRequestUrl,
      validationCommands: runResult.summary.validationCommands,
      failedValidationCommands: runResult.summary.failedValidationCommands,
      implementationSummary: runResult.summary.finalResponse,
      reviewOutcome: null,
      reviewSummary: null,
      updatedAt: new Date().toISOString(),
    });
    await setProjectCurrentWorkItem({
      workDir: options.workDir,
      slug: projectInventory.project.slug,
      workItem: {
        issueNumber: readyItem.issueNumber,
        issueUrl: readyItem.issueUrl,
        stage: nextStage,
        branchName: null,
        pullRequestUrl,
      },
    });
    logDevWorker(projectInventory.project.slug, `finished #${readyItem.issueNumber} and moved it to ${nextStage}.`);
    return true;
  } catch (error) {
    await options.boardsClient.moveProjectItemToStage(projectInventory.project, readyItem.boardItemId, "Blocked");
    await recordProjectFailure({
      workDir: options.workDir,
      slug: projectInventory.project.slug,
      stage: "dev",
      message: error instanceof Error ? error.message : String(error),
    });
    logDevWorker(projectInventory.project.slug, `blocked #${readyItem.issueNumber} after execution failure.`);
    return false;
  } finally {
    await releaseCodingLease({
      workDir: options.workDir,
      slug: projectInventory.project.slug,
    });
    await clearWorkflowWorkerClaim({
      workDir: options.workDir,
      workerId: options.workerId,
    });
  }
}