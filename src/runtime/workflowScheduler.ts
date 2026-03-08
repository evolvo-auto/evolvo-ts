import { OPENAI_API_KEY } from "../environment.js";
import { runIssueGeneratorAgent } from "../agents/issueGeneratorAgent.js";
import { runPlanningStageAgent } from "../agents/planningStageAgent.js";
import { configureCodingAgentExecutionContext, runCodingAgent } from "../agents/runCodingAgent.js";
import { runReleaseAgent } from "../agents/runReleaseAgent.js";
import { runReviewAgent } from "../agents/reviewAgent.js";
import { parseGitHubPullRequestUrl, type GitHubPullRequestClient } from "../github/githubPullRequests.js";
import type { GitHubProjectsV2Client } from "../github/githubProjectsV2.js";
import type { DefaultProjectContext, ProjectRecord } from "../projects/projectRegistry.js";
import {
  acquireCodingLease,
  recordProjectFailure,
  recordProjectStageTransition,
  releaseCodingLease,
  setProjectActivityMode,
  setProjectCurrentWorkItem,
} from "../projects/projectActivityState.js";
import { deactivateProjectInState } from "../projects/activeProjectsState.js";
import { buildPromptFromIssue } from "./loopUtils.js";
import { buildStagedWorkInventory, type StagedProjectInventory, type StagedWorkInventory, type StagedWorkItem } from "../issues/stagedWorkInventory.js";
import type { TaskIssueManager } from "../issues/taskIssueManager.js";
import { getWorkflowWorkItemRecord, upsertWorkflowWorkItemRecord } from "./workflowWorkItemState.js";
import { readWorkflowAgentState, updateWorkflowAgentState } from "./workflowAgentState.js";

export const IDEA_STAGE_TARGET_PER_PROJECT = 5;
const ISSUE_GENERATOR_MAX_ISSUES_PER_PROJECT = 5;
const PLANNER_MAX_ISSUES_PER_PROJECT = 10;
export const PLANNING_LIMIT_PER_PROJECT = 5;
export const READY_FOR_DEV_LIMIT_PER_PROJECT = 3;
export const IN_DEV_LIMIT_PER_PROJECT = 1;

export type WorkflowSchedulerCycleResult = {
  inventory: StagedWorkInventory;
  summary: {
    issueGeneratorCreated: number;
    plannerMovedToPlanning: number;
    plannerMovedToReadyForDev: number;
    plannerBlocked: number;
    devStarted: number;
    reviewProcessed: boolean;
    releaseProcessed: boolean;
  };
};

function logAgent(project: ProjectRecord, agent: "issue-generator" | "planner" | "dev" | "review" | "release", message: string): void {
  console.log(`[${agent}][${project.slug}] ${message}`);
}

function createRepositoryIssueManager(trackerIssueManager: TaskIssueManager, project: ProjectRecord): TaskIssueManager {
  return trackerIssueManager.forRepository({
    owner: project.executionRepo.owner,
    repo: project.executionRepo.repo,
  });
}

function isActiveProject(inventory: StagedProjectInventory): boolean {
  return inventory.activity?.activityState === "active" || inventory.project.slug === "evolvo";
}

function chooseRoundRobinProject(
  projects: StagedProjectInventory[],
  cursorSlug: string | null,
  selectItem: (project: StagedProjectInventory) => StagedWorkItem | null,
): { project: StagedProjectInventory; item: StagedWorkItem } | null {
  if (projects.length === 0) {
    return null;
  }

  const sortedProjects = [...projects].sort((left, right) => left.project.slug.localeCompare(right.project.slug));
  const cursorIndex = cursorSlug ? sortedProjects.findIndex((project) => project.project.slug === cursorSlug) : -1;
  for (let offset = 1; offset <= sortedProjects.length; offset += 1) {
    const candidateProject = sortedProjects[(cursorIndex + offset + sortedProjects.length) % sortedProjects.length];
    if (!candidateProject) {
      continue;
    }

    const item = selectItem(candidateProject);
    if (item) {
      return {
        project: candidateProject,
        item,
      };
    }
  }

  return null;
}

async function runIssueGeneratorPass(options: {
  workDir: string;
  inventory: StagedWorkInventory;
  trackerIssueManager: TaskIssueManager;
  boardsClient: GitHubProjectsV2Client;
}): Promise<number> {
  let createdCount = 0;
  for (const projectInventory of options.inventory.projects) {
    if (!isActiveProject(projectInventory)) {
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

    const issueManager = createRepositoryIssueManager(options.trackerIssueManager, projectInventory.project);
    const openIssues = await issueManager.listOpenIssues();
    const recentClosedIssues = await issueManager.listRecentClosedIssues(25);
    const drafts = await runIssueGeneratorAgent({
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
      logAgent(projectInventory.project, "issue-generator", `created issue #${created.issue.number} and placed it in Inbox.`);
    }
  }

  return createdCount;
}

async function runPlannerPass(options: {
  inventory: StagedWorkInventory;
  trackerIssueManager: TaskIssueManager;
  boardsClient: GitHubProjectsV2Client;
  workDir: string;
}): Promise<{ movedToPlanning: number; movedToReadyForDev: number; blocked: number }> {
  let movedToPlanning = 0;
  let movedToReadyForDev = 0;
  let blocked = 0;

  for (const projectInventory of options.inventory.projects) {
    if (!isActiveProject(projectInventory)) {
      continue;
    }

    const planningCapacityAvailable = projectInventory.countsByStage.Planning < PLANNING_LIMIT_PER_PROJECT;
    const readyForDevCapacityAvailable = projectInventory.countsByStage["Ready for Dev"] < READY_FOR_DEV_LIMIT_PER_PROJECT;
    const nextInboxItem = planningCapacityAvailable
      ? projectInventory.items
        .filter((item) => item.stage === "Inbox")
        .sort((left, right) => left.issueNumber - right.issueNumber)[0] ?? null
      : null;
    const nextPlanningItem = readyForDevCapacityAvailable
      ? projectInventory.items
        .filter((item) => item.stage === "Planning")
        .sort((left, right) => left.issueNumber - right.issueNumber)[0] ?? null
      : null;

    if (!nextInboxItem && !nextPlanningItem) {
      continue;
    }

    const issueManager = createRepositoryIssueManager(options.trackerIssueManager, projectInventory.project);
    const openIssues = await issueManager.listOpenIssues();
    const recentClosedIssues = await issueManager.listRecentClosedIssues(25);
    if (nextInboxItem) {
      const [action] = await runPlanningStageAgent({
        apiKey: OPENAI_API_KEY,
        projectSlug: projectInventory.project.slug,
        projectDisplayName: projectInventory.project.displayName,
        repository: `${projectInventory.project.executionRepo.owner}/${projectInventory.project.executionRepo.repo}`,
        maxIssues: 1,
        planningIssues: [{
          number: nextInboxItem.issueNumber,
          title: nextInboxItem.title,
          description: nextInboxItem.description,
          stage: nextInboxItem.stage,
        }],
        openIssueTitles: openIssues.map((issue) => issue.title),
        recentClosedIssueTitles: recentClosedIssues.map((issue) => issue.title),
      });

      if (action && action.issueNumber === nextInboxItem.issueNumber) {
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
          logAgent(projectInventory.project, "planner", `split #${action.issueNumber} into new Planning issue #${created.issue.number}.`);
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
          logAgent(projectInventory.project, "planner", `blocked #${action.issueNumber}.`);
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
          logAgent(projectInventory.project, "planner", `planned #${action.issueNumber} and moved it to Planning.`);
        }
      }
    }

    if (nextPlanningItem) {
      const [action] = await runPlanningStageAgent({
        apiKey: OPENAI_API_KEY,
        projectSlug: projectInventory.project.slug,
        projectDisplayName: projectInventory.project.displayName,
        repository: `${projectInventory.project.executionRepo.owner}/${projectInventory.project.executionRepo.repo}`,
        maxIssues: 1,
        planningIssues: [{
          number: nextPlanningItem.issueNumber,
          title: nextPlanningItem.title,
          description: nextPlanningItem.description,
          stage: nextPlanningItem.stage,
        }],
        openIssueTitles: openIssues.map((issue) => issue.title),
        recentClosedIssueTitles: recentClosedIssues.map((issue) => issue.title),
      });

      if (action && action.issueNumber === nextPlanningItem.issueNumber && action.decision === "ready-for-dev") {
        await options.boardsClient.moveProjectItemToStage(projectInventory.project, nextPlanningItem.boardItemId, "Ready for Dev");
        await recordProjectStageTransition({
          workDir: options.workDir,
          slug: projectInventory.project.slug,
          from: nextPlanningItem.stage,
          to: "Ready for Dev",
          reason: action.reasons.join("; "),
        });
        movedToReadyForDev += 1;
        logAgent(projectInventory.project, "planner", `moved #${action.issueNumber} to Ready for Dev.`);
      }
    }
  }

  return { movedToPlanning, movedToReadyForDev, blocked };
}

async function runReviewPass(options: {
  workDir: string;
  inventory: StagedWorkInventory;
  boardsClient: GitHubProjectsV2Client;
  trackerIssueManager: TaskIssueManager;
  pullRequestClient: GitHubPullRequestClient;
}): Promise<boolean> {
  const workflowAgentState = await readWorkflowAgentState(options.workDir);
  const selection = chooseRoundRobinProject(
    options.inventory.projects.filter((project) => isActiveProject(project)),
    workflowAgentState.reviewCursorProjectSlug,
    (project) => project.items
      .filter((item) => item.stage === "Ready for Review")
      .sort((left, right) => left.issueNumber - right.issueNumber)[0] ?? null,
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
    logAgent(selection.project.project, "review", `blocked #${selection.item.issueNumber} because no PR metadata was recorded.`);
    await updateWorkflowAgentState(options.workDir, {
      reviewCursorProjectSlug: selection.project.project.slug,
    });
    return true;
  }

  await options.boardsClient.moveProjectItemToStage(selection.project.project, selection.item.boardItemId, "In Review");
  const reviewResult = await runReviewAgent({
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

  const parsedPullRequestUrl = parseGitHubPullRequestUrl(record.pullRequestUrl);
  if (parsedPullRequestUrl) {
    await options.pullRequestClient.submitReview({
      owner: parsedPullRequestUrl.owner,
      repo: parsedPullRequestUrl.repo,
      pullNumber: parsedPullRequestUrl.pullNumber,
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
  logAgent(selection.project.project, "review", `reviewed #${selection.item.issueNumber} and moved it to ${nextStage}.`);
  await updateWorkflowAgentState(options.workDir, {
    reviewCursorProjectSlug: selection.project.project.slug,
  });
  return true;
}

async function runReleasePass(options: {
  workDir: string;
  inventory: StagedWorkInventory;
  boardsClient: GitHubProjectsV2Client;
  trackerIssueManager: TaskIssueManager;
}): Promise<boolean> {
  const workflowAgentState = await readWorkflowAgentState(options.workDir);
  const selection = chooseRoundRobinProject(
    options.inventory.projects.filter((project) => isActiveProject(project)),
    workflowAgentState.releaseCursorProjectSlug,
    (project) => project.items
      .filter((item) => item.stage === "Ready for Release")
      .sort((left, right) => left.issueNumber - right.issueNumber)[0] ?? null,
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
    logAgent(selection.project.project, "release", `blocked #${selection.item.issueNumber} because no PR metadata was recorded.`);
    await updateWorkflowAgentState(options.workDir, {
      releaseCursorProjectSlug: selection.project.project.slug,
    });
    return true;
  }

  await options.boardsClient.moveProjectItemToStage(selection.project.project, selection.item.boardItemId, "Releasing");
  const releaseResult = await runReleaseAgent({
    workDir: selection.project.project.cwd,
    pullRequestUrl: record.pullRequestUrl,
    defaultBranch: selection.project.project.executionRepo.defaultBranch,
  });

  if (releaseResult.mergedPullRequest) {
    const issueManager = createRepositoryIssueManager(options.trackerIssueManager, selection.project.project);
    await issueManager.closeIssue(selection.item.issueNumber);
    await options.boardsClient.moveProjectItemToStage(selection.project.project, selection.item.boardItemId, "Done");
    logAgent(selection.project.project, "release", `merged PR for #${selection.item.issueNumber} and moved it to Done.`);
  } else {
    await options.boardsClient.moveProjectItemToStage(selection.project.project, selection.item.boardItemId, "Blocked");
    await recordProjectFailure({
      workDir: options.workDir,
      slug: selection.project.project.slug,
      stage: "release",
      message: `Release agent could not merge PR for ${selection.item.queueKey}.`,
    });
    logAgent(selection.project.project, "release", `blocked #${selection.item.issueNumber} because merge did not complete.`);
  }

  await updateWorkflowAgentState(options.workDir, {
    releaseCursorProjectSlug: selection.project.project.slug,
  });
  return true;
}

async function runDevPass(options: {
  workDir: string;
  inventory: StagedWorkInventory;
  boardsClient: GitHubProjectsV2Client;
  trackerIssueManager: TaskIssueManager;
}): Promise<number> {
  const runnableProjects = options.inventory.projects
    .filter((projectInventory) => isActiveProject(projectInventory))
    .filter((projectInventory) => projectInventory.activity?.currentCodingLease === null)
    .filter((projectInventory) => projectInventory.countsByStage["In Dev"] < IN_DEV_LIMIT_PER_PROJECT);

  const results: number[] = await Promise.all(runnableProjects.map(async (projectInventory) => {
    const readyItem = projectInventory.items
      .filter((item) => item.stage === "Ready for Dev")
      .sort((left, right) => left.issueNumber - right.issueNumber)[0] ?? null;
    if (!readyItem) {
      return 0;
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
    await options.boardsClient.moveProjectItemToStage(projectInventory.project, readyItem.boardItemId, "In Dev");
    logAgent(projectInventory.project, "dev", `claimed #${readyItem.issueNumber} and moved it to In Dev.`);

    try {
      configureCodingAgentExecutionContext({
        workDir: projectInventory.project.cwd,
        internalRepositoryUrls: [
          projectInventory.project.executionRepo.url,
          projectInventory.project.trackerRepo.url,
        ],
      });
      const runResult = await runCodingAgent(buildPromptFromIssue({
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
      logAgent(projectInventory.project, "dev", `finished #${readyItem.issueNumber} and moved it to ${nextStage}.`);
      return 1;
    } catch (error) {
      await options.boardsClient.moveProjectItemToStage(projectInventory.project, readyItem.boardItemId, "Blocked");
      await recordProjectFailure({
        workDir: options.workDir,
        slug: projectInventory.project.slug,
        stage: "dev",
        message: error instanceof Error ? error.message : String(error),
      });
      logAgent(projectInventory.project, "dev", `blocked #${readyItem.issueNumber} after execution failure.`);
      return 0;
    } finally {
      await releaseCodingLease({
        workDir: options.workDir,
        slug: projectInventory.project.slug,
      });
    }
  }));

  return results.reduce((total, count) => total + count, 0);
}

async function applyDeferredStops(options: {
  workDir: string;
  inventory: StagedWorkInventory;
}): Promise<void> {
  for (const projectInventory of options.inventory.projects) {
    const activity = projectInventory.activity;
    if (activity?.deferredStopMode !== "when-project-complete") {
      continue;
    }

    const nonTerminalCount = projectInventory.items.filter((item) => item.stage !== "Done").length;
    if (nonTerminalCount > 0 || activity.currentCodingLease !== null) {
      continue;
    }

    await setProjectActivityMode({
      workDir: options.workDir,
      slug: projectInventory.project.slug,
      activityState: "stopped",
      requestedBy: activity.requestedBy,
      updatedAt: new Date().toISOString(),
    });
    await deactivateProjectInState(options.workDir, projectInventory.project.slug);
    logAgent(projectInventory.project, "release", "deferred stop completed; project is now unscheduled.");
  }
}

async function clearStaleCodingLeases(options: {
  workDir: string;
  inventory: StagedWorkInventory;
}): Promise<boolean> {
  let changed = false;

  for (const projectInventory of options.inventory.projects) {
    const activity = projectInventory.activity;
    if (!activity?.currentCodingLease) {
      continue;
    }

    if (projectInventory.countsByStage["In Dev"] > 0) {
      continue;
    }

    await releaseCodingLease({
      workDir: options.workDir,
      slug: projectInventory.project.slug,
    });
    if (activity.currentWorkItem?.stage === "In Dev") {
      await setProjectCurrentWorkItem({
        workDir: options.workDir,
        slug: projectInventory.project.slug,
        workItem: null,
      });
    }
    changed = true;
    logAgent(
      projectInventory.project,
      "dev",
      `cleared stale coding lease for issue #${activity.currentCodingLease.issueNumber} because no board item is currently In Dev.`,
    );
  }

  return changed;
}

export async function runWorkflowSchedulerCycle(options: {
  workDir: string;
  defaultProject: DefaultProjectContext;
  trackerIssueManager: TaskIssueManager;
  boardsClient: GitHubProjectsV2Client;
  pullRequestClient: GitHubPullRequestClient;
}): Promise<WorkflowSchedulerCycleResult> {
  let inventory = await buildStagedWorkInventory({
    workDir: options.workDir,
    defaultProject: options.defaultProject,
    trackerIssueManager: options.trackerIssueManager,
    boardsClient: options.boardsClient,
  });
  const clearedStaleLeases = await clearStaleCodingLeases({
    workDir: options.workDir,
    inventory,
  });
  if (clearedStaleLeases) {
    inventory = await buildStagedWorkInventory({
      workDir: options.workDir,
      defaultProject: options.defaultProject,
      trackerIssueManager: options.trackerIssueManager,
      boardsClient: options.boardsClient,
    });
  }

  const issueGeneratorCreated = await runIssueGeneratorPass({
    workDir: options.workDir,
    inventory,
    trackerIssueManager: options.trackerIssueManager,
    boardsClient: options.boardsClient,
  });
  if (issueGeneratorCreated > 0) {
    inventory = await buildStagedWorkInventory({
      workDir: options.workDir,
      defaultProject: options.defaultProject,
      trackerIssueManager: options.trackerIssueManager,
      boardsClient: options.boardsClient,
    });
  }

  const plannerSummary = await runPlannerPass({
    inventory,
    trackerIssueManager: options.trackerIssueManager,
    boardsClient: options.boardsClient,
    workDir: options.workDir,
  });
  if (plannerSummary.movedToPlanning > 0 || plannerSummary.movedToReadyForDev > 0 || plannerSummary.blocked > 0) {
    inventory = await buildStagedWorkInventory({
      workDir: options.workDir,
      defaultProject: options.defaultProject,
      trackerIssueManager: options.trackerIssueManager,
      boardsClient: options.boardsClient,
    });
  }

  const reviewProcessed = await runReviewPass({
    workDir: options.workDir,
    inventory,
    boardsClient: options.boardsClient,
    trackerIssueManager: options.trackerIssueManager,
    pullRequestClient: options.pullRequestClient,
  });
  if (reviewProcessed) {
    inventory = await buildStagedWorkInventory({
      workDir: options.workDir,
      defaultProject: options.defaultProject,
      trackerIssueManager: options.trackerIssueManager,
      boardsClient: options.boardsClient,
    });
  }

  const releaseProcessed = await runReleasePass({
    workDir: options.workDir,
    inventory,
    boardsClient: options.boardsClient,
    trackerIssueManager: options.trackerIssueManager,
  });
  if (releaseProcessed) {
    inventory = await buildStagedWorkInventory({
      workDir: options.workDir,
      defaultProject: options.defaultProject,
      trackerIssueManager: options.trackerIssueManager,
      boardsClient: options.boardsClient,
    });
  }

  const devStarted = await runDevPass({
    workDir: options.workDir,
    inventory,
    boardsClient: options.boardsClient,
    trackerIssueManager: options.trackerIssueManager,
  });
  if (devStarted > 0) {
    inventory = await buildStagedWorkInventory({
      workDir: options.workDir,
      defaultProject: options.defaultProject,
      trackerIssueManager: options.trackerIssueManager,
      boardsClient: options.boardsClient,
    });
  }

  await applyDeferredStops({
    workDir: options.workDir,
    inventory,
  });

  return {
    inventory,
    summary: {
      issueGeneratorCreated,
      plannerMovedToPlanning: plannerSummary.movedToPlanning,
      plannerMovedToReadyForDev: plannerSummary.movedToReadyForDev,
      plannerBlocked: plannerSummary.blocked,
      devStarted,
      reviewProcessed,
      releaseProcessed,
    },
  };
}
