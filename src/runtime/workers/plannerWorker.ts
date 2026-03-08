import { OPENAI_API_KEY } from "../../environment.js";
import { runPlanningStageAgent, type PlanningStageAction } from "../../agents/planningStageAgent.js";
import type { GitHubProjectsV2Client } from "../../github/githubProjectsV2.js";
import type { StagedWorkInventory, StagedWorkItem } from "../../issues/stagedWorkInventory.js";
import type { TaskIssueManager } from "../../issues/taskIssueManager.js";
import { recordProjectStageTransition } from "../../projects/projectActivityState.js";
import { isWorkerActiveProject, selectLowestIssueStageItem } from "./boardQueries.js";

const PLANNING_LIMIT_PER_PROJECT = 5;
const READY_FOR_DEV_LIMIT_PER_PROJECT = 3;

function logPlannerWorker(projectSlug: string, message: string): void {
  console.log(`[worker][planner][${projectSlug}] ${message}`);
}

function createRepositoryIssueManager(trackerIssueManager: TaskIssueManager, owner: string, repo: string): TaskIssueManager {
  return trackerIssueManager.forRepository({ owner, repo });
}

async function runPlannerAction(options: {
  projectSlug: string;
  projectDisplayName: string;
  repository: string;
  item: StagedWorkItem;
  openIssueTitles: string[];
  recentClosedIssueTitles: string[];
  planningStageAgent?: (input: Parameters<typeof runPlanningStageAgent>[0]) => Promise<PlanningStageAction[]>;
}): Promise<PlanningStageAction | null> {
  const [action] = await (options.planningStageAgent ?? runPlanningStageAgent)({
    apiKey: OPENAI_API_KEY,
    projectSlug: options.projectSlug,
    projectDisplayName: options.projectDisplayName,
    repository: options.repository,
    maxIssues: 1,
    planningIssues: [{
      number: options.item.issueNumber,
      title: options.item.title,
      description: options.item.description,
      stage: options.item.stage,
    }],
    openIssueTitles: options.openIssueTitles,
    recentClosedIssueTitles: options.recentClosedIssueTitles,
  });

  return action && action.issueNumber === options.item.issueNumber ? action : null;
}

export async function runPlannerWorkerPass(options: {
  workDir: string;
  inventory: StagedWorkInventory;
  trackerIssueManager: TaskIssueManager;
  boardsClient: Pick<GitHubProjectsV2Client, "ensureRepositoryIssueItem" | "moveProjectItemToStage">;
  planningStageAgent?: (input: Parameters<typeof runPlanningStageAgent>[0]) => Promise<PlanningStageAction[]>;
}): Promise<{ movedToPlanning: number; movedToReadyForDev: number; blocked: number }> {
  let movedToPlanning = 0;
  let movedToReadyForDev = 0;
  let blocked = 0;

  for (const projectInventory of options.inventory.projects) {
    if (!isWorkerActiveProject(projectInventory)) {
      continue;
    }

    const planningCapacityAvailable = projectInventory.countsByStage.Planning < PLANNING_LIMIT_PER_PROJECT;
    const readyForDevCapacityAvailable = projectInventory.countsByStage["Ready for Dev"] < READY_FOR_DEV_LIMIT_PER_PROJECT;
    const nextInboxItem = planningCapacityAvailable
      ? selectLowestIssueStageItem(projectInventory.items, "Inbox")
      : null;
    const nextPlanningItem = readyForDevCapacityAvailable
      ? selectLowestIssueStageItem(projectInventory.items, "Planning")
      : null;

    if (!nextInboxItem && !nextPlanningItem) {
      continue;
    }

    const issueManager = createRepositoryIssueManager(
      options.trackerIssueManager,
      projectInventory.project.executionRepo.owner,
      projectInventory.project.executionRepo.repo,
    );
    const openIssues = await issueManager.listOpenIssues();
    const recentClosedIssues = await issueManager.listRecentClosedIssues(25);

    if (nextInboxItem) {
      const action = await runPlannerAction({
        projectSlug: projectInventory.project.slug,
        projectDisplayName: projectInventory.project.displayName,
        repository: `${projectInventory.project.executionRepo.owner}/${projectInventory.project.executionRepo.repo}`,
        item: nextInboxItem,
        openIssueTitles: openIssues.map((issue) => issue.title),
        recentClosedIssueTitles: recentClosedIssues.map((issue) => issue.title),
        planningStageAgent: options.planningStageAgent,
      });

      if (action) {
        await issueManager.updateIssue(action.issueNumber, {
          title: action.title,
          description: action.description,
        });

        for (const splitIssue of action.splitIssues) {
          const created = await issueManager.createIssue(splitIssue.title, splitIssue.description);
          if (!created.ok || !created.issue) {
            continue;
          }

          const splitBoardItem = await options.boardsClient.ensureRepositoryIssueItem(projectInventory.project, created.issue.number);
          await options.boardsClient.moveProjectItemToStage(projectInventory.project, splitBoardItem.itemId, "Planning");
          movedToPlanning += 1;
          logPlannerWorker(projectInventory.project.slug, `split #${action.issueNumber} into new Planning issue #${created.issue.number}.`);
        }

        if (action.decision === "blocked") {
          await options.boardsClient.moveProjectItemToStage(projectInventory.project, nextInboxItem.boardItemId, "Blocked");
          await issueManager.updateLabels(action.issueNumber, {
            add: ["blocked"],
            remove: ["in progress", "completed"],
          });
          await recordProjectStageTransition({
            workDir: options.workDir,
            slug: projectInventory.project.slug,
            from: nextInboxItem.stage,
            to: "Blocked",
            reason: action.reasons.join("; "),
          });
          blocked += 1;
          logPlannerWorker(projectInventory.project.slug, `blocked #${action.issueNumber}.`);
        } else {
          await options.boardsClient.moveProjectItemToStage(projectInventory.project, nextInboxItem.boardItemId, "Planning");
          await recordProjectStageTransition({
            workDir: options.workDir,
            slug: projectInventory.project.slug,
            from: nextInboxItem.stage,
            to: "Planning",
            reason: action.reasons.join("; "),
          });
          movedToPlanning += 1;
          logPlannerWorker(projectInventory.project.slug, `planned #${action.issueNumber} and moved it to Planning.`);
        }
      }
    }

    if (nextPlanningItem) {
      const action = await runPlannerAction({
        projectSlug: projectInventory.project.slug,
        projectDisplayName: projectInventory.project.displayName,
        repository: `${projectInventory.project.executionRepo.owner}/${projectInventory.project.executionRepo.repo}`,
        item: nextPlanningItem,
        openIssueTitles: openIssues.map((issue) => issue.title),
        recentClosedIssueTitles: recentClosedIssues.map((issue) => issue.title),
        planningStageAgent: options.planningStageAgent,
      });

      if (action?.decision === "ready-for-dev") {
        await options.boardsClient.moveProjectItemToStage(projectInventory.project, nextPlanningItem.boardItemId, "Ready for Dev");
        await recordProjectStageTransition({
          workDir: options.workDir,
          slug: projectInventory.project.slug,
          from: nextPlanningItem.stage,
          to: "Ready for Dev",
          reason: action.reasons.join("; "),
        });
        movedToReadyForDev += 1;
        logPlannerWorker(projectInventory.project.slug, `moved #${action.issueNumber} to Ready for Dev.`);
      }
    }
  }

  return { movedToPlanning, movedToReadyForDev, blocked };
}