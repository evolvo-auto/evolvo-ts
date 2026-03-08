import { OPENAI_API_KEY } from "../../environment.js";
import { runIssueGeneratorAgent } from "../../agents/issueGeneratorAgent.js";
import type { GitHubProjectsV2Client } from "../../github/githubProjectsV2.js";
import type { StagedWorkInventory } from "../../issues/stagedWorkInventory.js";
import type { TaskIssueManager } from "../../issues/taskIssueManager.js";
import { isWorkerActiveProject } from "./boardQueries.js";

const IDEA_STAGE_TARGET_PER_PROJECT = 5;
const ISSUE_GENERATOR_MAX_ISSUES_PER_PROJECT = 5;

function logIssueGeneratorWorker(projectSlug: string, message: string): void {
  console.log(`[worker][issue-generator][${projectSlug}] ${message}`);
}

function createRepositoryIssueManager(trackerIssueManager: TaskIssueManager, owner: string, repo: string): TaskIssueManager {
  return trackerIssueManager.forRepository({ owner, repo });
}

export async function runIssueGeneratorWorkerPass(options: {
  inventory: StagedWorkInventory;
  trackerIssueManager: TaskIssueManager;
  boardsClient: Pick<GitHubProjectsV2Client, "ensureRepositoryIssueItem" | "moveProjectItemToStage">;
  issueGeneratorAgent?: typeof runIssueGeneratorAgent;
}): Promise<number> {
  let createdCount = 0;

  for (const projectInventory of options.inventory.projects) {
    if (!isWorkerActiveProject(projectInventory)) {
      continue;
    }

    const backlogCount = projectInventory.countsByStage.Inbox + projectInventory.countsByStage.Planning;
    if (backlogCount >= IDEA_STAGE_TARGET_PER_PROJECT) {
      continue;
    }

    const issuesNeeded = Math.min(
      ISSUE_GENERATOR_MAX_ISSUES_PER_PROJECT,
      IDEA_STAGE_TARGET_PER_PROJECT - backlogCount,
    );
    if (issuesNeeded <= 0) {
      continue;
    }

    const issueManager = createRepositoryIssueManager(
      options.trackerIssueManager,
      projectInventory.project.executionRepo.owner,
      projectInventory.project.executionRepo.repo,
    );
    const openIssues = await issueManager.listOpenIssues();
    const recentClosedIssues = await issueManager.listRecentClosedIssues(25);
    const drafts = await (options.issueGeneratorAgent ?? runIssueGeneratorAgent)({
      apiKey: OPENAI_API_KEY,
      projectSlug: projectInventory.project.slug,
      projectDisplayName: projectInventory.project.displayName,
      repository: `${projectInventory.project.executionRepo.owner}/${projectInventory.project.executionRepo.repo}`,
      counts: {
        inbox: projectInventory.countsByStage.Inbox,
        planning: projectInventory.countsByStage.Planning,
        readyForDev: projectInventory.countsByStage["Ready for Dev"],
        inDev: projectInventory.countsByStage["In Dev"],
      },
      openIssueTitles: openIssues.map((issue) => issue.title),
      recentClosedIssueTitles: recentClosedIssues.map((issue) => issue.title),
      maxIssues: issuesNeeded,
    });

    for (const draft of drafts.slice(0, issuesNeeded)) {
      const created = await issueManager.createIssue(draft.title, draft.description);
      if (!created.ok || !created.issue) {
        continue;
      }

      const boardItem = await options.boardsClient.ensureRepositoryIssueItem(projectInventory.project, created.issue.number);
      await options.boardsClient.moveProjectItemToStage(projectInventory.project, boardItem.itemId, "Inbox");
      createdCount += 1;
      logIssueGeneratorWorker(projectInventory.project.slug, `created issue #${created.issue.number} and placed it in Inbox.`);
    }
  }

  return createdCount;
}