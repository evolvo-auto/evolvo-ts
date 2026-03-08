import { OPENAI_API_KEY } from "../../environment.js";
import { runReviewAgent, type ReviewAgentResult } from "../../agents/reviewAgent.js";
import { parseGitHubPullRequestUrl, type GitHubPullRequestClient } from "../../github/githubPullRequests.js";
import type { GitHubProjectsV2Client } from "../../github/githubProjectsV2.js";
import type { StagedWorkInventory } from "../../issues/stagedWorkInventory.js";
import { recordProjectFailure } from "../../projects/projectActivityState.js";
import { getWorkflowWorkItemRecord, upsertWorkflowWorkItemRecord } from "../workflowWorkItemState.js";
import { readWorkflowAgentState, updateWorkflowAgentState } from "../workflowAgentState.js";
import { chooseRoundRobinProjectStageItem } from "./boardQueries.js";
import { claimProjectBoardItemForWorker, clearWorkflowWorkerClaim } from "./boardClaims.js";

function logReviewWorker(projectSlug: string, message: string): void {
  console.log(`[worker][review][${projectSlug}] ${message}`);
}

export async function runReviewWorkerPass(options: {
  workDir: string;
  workerId: string;
  inventory: StagedWorkInventory;
  boardsClient: Pick<GitHubProjectsV2Client, "moveProjectItemToStage" | "listProjectIssueItems">;
  pullRequestClient: Pick<GitHubPullRequestClient, "submitReview">;
  reviewAgent?: (input: Parameters<typeof runReviewAgent>[0]) => Promise<ReviewAgentResult>;
}): Promise<boolean> {
  const workflowAgentState = await readWorkflowAgentState(options.workDir);
  const selection = chooseRoundRobinProjectStageItem(
    options.inventory.projects,
    workflowAgentState.reviewCursorProjectSlug,
    "Ready for Review",
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
      stage: "review",
      message: `Missing PR metadata for ${selection.item.queueKey}.`,
    });
    await updateWorkflowAgentState(options.workDir, {
      reviewCursorProjectSlug: selection.project.project.slug,
    });
    logReviewWorker(selection.project.project.slug, `blocked #${selection.item.issueNumber} because no PR metadata was recorded.`);
    return true;
  }

  const parsedPullRequest = parseGitHubPullRequestUrl(record.pullRequestUrl);
  const claimResult = await claimProjectBoardItemForWorker({
    workDir: options.workDir,
    workerId: options.workerId,
    project: selection.project.project,
    boardsClient: options.boardsClient,
    itemId: selection.item.boardItemId,
    fromStage: "Ready for Review",
    toStage: "In Review",
    pullRequestNumber: parsedPullRequest?.pullNumber ?? null,
  });
  if (!claimResult.claimed) {
    return false;
  }

  try {
    const reviewResult = await (options.reviewAgent ?? runReviewAgent)({
      apiKey: OPENAI_API_KEY,
      workDir: selection.project.project.cwd,
      issue: {
        number: selection.item.issueNumber,
        title: selection.item.title,
        description: selection.item.description,
      },
      pullRequestUrl: record.pullRequestUrl,
      validationCommands: record.validationCommands,
      failedValidationCommands: record.failedValidationCommands,
      implementationSummary: record.implementationSummary ?? "",
    });

    if (parsedPullRequest) {
      await options.pullRequestClient.submitReview({
        owner: parsedPullRequest.owner,
        repo: parsedPullRequest.repo,
        pullNumber: parsedPullRequest.pullNumber,
        event: reviewResult.decision === "approve" ? "APPROVE" : "REQUEST_CHANGES",
        body: [reviewResult.summary, ...reviewResult.reasons.map((reason) => `- ${reason}`)].join("\n"),
      });
    }

    const nextStage = reviewResult.decision === "approve" ? "Ready for Release" : "Ready for Dev";
    await options.boardsClient.moveProjectItemToStage(selection.project.project, selection.item.boardItemId, nextStage);
    await upsertWorkflowWorkItemRecord(options.workDir, {
      ...record,
      reviewOutcome: reviewResult.decision === "approve" ? "approved" : "rejected",
      reviewSummary: reviewResult.summary,
      updatedAt: new Date().toISOString(),
    });
    await updateWorkflowAgentState(options.workDir, {
      reviewCursorProjectSlug: selection.project.project.slug,
    });
    logReviewWorker(selection.project.project.slug, `reviewed #${selection.item.issueNumber} and moved it to ${nextStage}.`);
    return true;
  } finally {
    await clearWorkflowWorkerClaim({
      workDir: options.workDir,
      workerId: options.workerId,
    });
  }
}