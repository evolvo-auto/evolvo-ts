import { runReleaseAgent, type ReleaseAgentRunResult } from "../../agents/runReleaseAgent.js";
import type { GitHubProjectsV2Client } from "../../github/githubProjectsV2.js";
import type { StagedWorkInventory } from "../../issues/stagedWorkInventory.js";
import type { TaskIssueManager } from "../../issues/taskIssueManager.js";
import { recordProjectFailure } from "../../projects/projectActivityState.js";
import { getWorkflowWorkItemRecord } from "../workflowWorkItemState.js";
import { readWorkflowAgentState, updateWorkflowAgentState } from "../workflowAgentState.js";
import { chooseRoundRobinProjectStageItem } from "./boardQueries.js";
import { claimProjectBoardItemForWorker, clearWorkflowWorkerClaim } from "./boardClaims.js";

function logReleaseWorker(projectSlug: string, message: string): void {
  console.log(`[worker][release][${projectSlug}] ${message}`);
}

function createRepositoryIssueManager(trackerIssueManager: TaskIssueManager, owner: string, repo: string): TaskIssueManager {
  return trackerIssueManager.forRepository({ owner, repo });
}

export async function runReleaseWorkerPass(options: {
  workDir: string;
  workerId: string;
  inventory: StagedWorkInventory;
  boardsClient: Pick<GitHubProjectsV2Client, "moveProjectItemToStage" | "listProjectIssueItems">;
  trackerIssueManager: TaskIssueManager;
  releaseAgent?: (input: Parameters<typeof runReleaseAgent>[0]) => Promise<ReleaseAgentRunResult>;
}): Promise<boolean> {
  const workflowAgentState = await readWorkflowAgentState(options.workDir);
  const selection = chooseRoundRobinProjectStageItem(
    options.inventory.projects,
    workflowAgentState.releaseCursorProjectSlug,
    "Ready for Release",
  );
  if (!selection) {
    return false;
  }

  const record = await getWorkflowWorkItemRecord(options.workDir, selection.item.queueKey);
  if (!record?.pullRequestUrl) {
    await options.boardsClient.moveProjectItemToStage(selection.project.project, selection.item.boardItemId, "Blocked");
    await recordProjectFailure({
      workDir: options.workDir,
      slug: selection.project.project.slug,
      stage: "release",
      message: `Missing PR metadata for ${selection.item.queueKey}.`,
    });
    await updateWorkflowAgentState(options.workDir, {
      releaseCursorProjectSlug: selection.project.project.slug,
    });
    logReleaseWorker(selection.project.project.slug, `blocked #${selection.item.issueNumber} because no PR metadata was recorded.`);
    return true;
  }

  const claimResult = await claimProjectBoardItemForWorker({
    workDir: options.workDir,
    workerId: options.workerId,
    project: selection.project.project,
    boardsClient: options.boardsClient,
    itemId: selection.item.boardItemId,
    fromStage: "Ready for Release",
    toStage: "Releasing",
  });
  if (!claimResult.claimed) {
    return false;
  }

  try {
    const releaseResult = await (options.releaseAgent ?? runReleaseAgent)({
      workDir: selection.project.project.cwd,
      pullRequestUrl: record.pullRequestUrl,
      defaultBranch: selection.project.project.executionRepo.defaultBranch,
    });

    if (releaseResult.mergedPullRequest) {
      const issueManager = createRepositoryIssueManager(
        options.trackerIssueManager,
        selection.project.project.executionRepo.owner,
        selection.project.project.executionRepo.repo,
      );
      await issueManager.closeIssue(selection.item.issueNumber);
      await options.boardsClient.moveProjectItemToStage(selection.project.project, selection.item.boardItemId, "Done");
      logReleaseWorker(selection.project.project.slug, `merged PR for #${selection.item.issueNumber} and moved it to Done.`);
    } else {
      await options.boardsClient.moveProjectItemToStage(selection.project.project, selection.item.boardItemId, "Blocked");
      await recordProjectFailure({
        workDir: options.workDir,
        slug: selection.project.project.slug,
        stage: "release",
        message: `Release agent could not merge PR for ${selection.item.queueKey}.`,
      });
      logReleaseWorker(selection.project.project.slug, `blocked #${selection.item.issueNumber} because merge did not complete.`);
    }

    await updateWorkflowAgentState(options.workDir, {
      releaseCursorProjectSlug: selection.project.project.slug,
    });
    return true;
  } finally {
    await clearWorkflowWorkerClaim({
      workDir: options.workDir,
      workerId: options.workerId,
    });
  }
}