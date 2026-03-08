import { COMPLETED_LABEL, IN_PROGRESS_LABEL, type IssueSummary, type TaskIssueManager } from "./taskIssueManager.js";
import type { DefaultProjectContext, ProjectRecord } from "../projects/projectRegistry.js";
import { readProjectRegistry } from "../projects/projectRegistry.js";
import { readActiveProjectsState } from "../projects/activeProjectsState.js";
import {
  synchronizeProjectActivityState,
  type ProjectActivityState,
  type ProjectActivityStateEntry,
} from "../projects/projectActivityState.js";
import type { ProjectWorkflowStage } from "../projects/projectWorkflow.js";
import { DEFAULT_PROJECT_SLUG } from "../projects/projectNaming.js";
import {
  GitHubProjectsV2Client,
  type ProjectBoardIssueItem,
} from "../github/githubProjectsV2.js";

export type StagedWorkItem = {
  queueKey: string;
  project: ProjectRecord;
  issueNumber: number;
  issueUrl: string;
  title: string;
  description: string;
  labels: string[];
  stage: ProjectWorkflowStage;
  boardItemId: string;
  issueNodeId: string;
  repository: {
    owner: string;
    repo: string;
    url: string;
    reference: string;
  };
};

export type StagedProjectInventory = {
  project: ProjectRecord;
  activity: ProjectActivityStateEntry | null;
  items: StagedWorkItem[];
  countsByStage: Record<ProjectWorkflowStage, number>;
};

export type StagedWorkInventory = {
  projects: StagedProjectInventory[];
  activityState: ProjectActivityState;
};

function createStageCountMap(): Record<ProjectWorkflowStage, number> {
  return {
    Inbox: 0,
    Planning: 0,
    "Ready for Dev": 0,
    "In Dev": 0,
    "Ready for Review": 0,
    "In Review": 0,
    "Ready for Release": 0,
    Releasing: 0,
    Blocked: 0,
    Done: 0,
  };
}

function buildQueueKey(project: ProjectRecord, issueNumber: number): string {
  return `${project.slug}#${issueNumber}`;
}

function hasLabel(issue: IssueSummary, label: string): boolean {
  return issue.labels.some((currentLabel) => currentLabel.toLowerCase() === label.toLowerCase());
}

function inferStageForOpenIssue(issue: IssueSummary): ProjectWorkflowStage {
  if (issue.state === "closed" || hasLabel(issue, COMPLETED_LABEL)) {
    return "Done";
  }

  if (hasLabel(issue, "blocked")) {
    return "Blocked";
  }

  if (hasLabel(issue, IN_PROGRESS_LABEL)) {
    return "In Dev";
  }

  return "Planning";
}

function resolveReconciledStage(issue: IssueSummary, currentBoardStage: ProjectWorkflowStage | null): ProjectWorkflowStage | null {
  const inferredStage = inferStageForOpenIssue(issue);

  if (inferredStage === "Done") {
    return "Done";
  }

  if (currentBoardStage === null) {
    return inferredStage;
  }

  return currentBoardStage;
}

function normalizeBoardItem(project: ProjectRecord, item: ProjectBoardIssueItem): StagedWorkItem | null {
  if (item.stage === null) {
    return null;
  }

  return {
    queueKey: buildQueueKey(project, item.issueNumber),
    project,
    issueNumber: item.issueNumber,
    issueUrl: item.url,
    title: item.title,
    description: item.body,
    labels: item.labels,
    stage: item.stage,
    boardItemId: item.itemId,
    issueNodeId: item.issueNodeId,
    repository: item.repository,
  };
}

async function reconcileProjectIssuesOntoBoard(options: {
  project: ProjectRecord;
  issueManager: TaskIssueManager;
  boardsClient: GitHubProjectsV2Client;
}): Promise<ProjectBoardIssueItem[]> {
  const openIssues = await options.issueManager.listOpenIssues();
  const existingItems = await options.boardsClient.listProjectIssueItems(options.project);
  const itemsByIssueNumber = new Map(existingItems.map((item) => [item.issueNumber, item] as const));

  for (const openIssue of openIssues) {
    let boardItem = itemsByIssueNumber.get(openIssue.number) ?? null;
    if (boardItem === null) {
      boardItem = await options.boardsClient.ensureRepositoryIssueItem(options.project, openIssue.number);
      itemsByIssueNumber.set(openIssue.number, boardItem);
    }

    const reconciledStage = resolveReconciledStage(openIssue, boardItem.stage);
    if (reconciledStage !== null && boardItem.stage !== reconciledStage) {
      await options.boardsClient.moveProjectItemToStage(options.project, boardItem.itemId, reconciledStage);
      itemsByIssueNumber.set(openIssue.number, {
        ...boardItem,
        stage: reconciledStage,
        stageOptionId: options.project.workflow.stageOptionIds[reconciledStage] ?? null,
      });
    }
  }

  return [...itemsByIssueNumber.values()];
}

function toProjectInventory(
  project: ProjectRecord,
  activity: ProjectActivityStateEntry | null,
  boardItems: ProjectBoardIssueItem[],
): StagedProjectInventory {
  const countsByStage = createStageCountMap();
  const items = boardItems
    .map((item) => normalizeBoardItem(project, item))
    .filter((item): item is StagedWorkItem => item !== null);

  for (const item of items) {
    countsByStage[item.stage] += 1;
  }

  return {
    project,
    activity,
    items,
    countsByStage,
  };
}

export async function buildStagedWorkInventory(options: {
  workDir: string;
  defaultProject: DefaultProjectContext;
  trackerIssueManager: TaskIssueManager;
  boardsClient: GitHubProjectsV2Client;
}): Promise<StagedWorkInventory> {
  const [registry, activeProjectsState] = await Promise.all([
    readProjectRegistry(options.workDir, options.defaultProject),
    readActiveProjectsState(options.workDir),
  ]);
  const activeManagedProjectSlugs = activeProjectsState.projects.map((entry) => entry.slug);
  const activityState = await synchronizeProjectActivityState({
    workDir: options.workDir,
    projects: registry.projects,
    activeManagedProjectSlugs,
  });
  const activityBySlug = new Map(activityState.projects.map((entry) => [entry.slug, entry] as const));

  const relevantProjects = registry.projects.filter((project) =>
    project.slug === DEFAULT_PROJECT_SLUG || activeManagedProjectSlugs.includes(project.slug)
  );

  const inventories = await Promise.all(relevantProjects.map(async (project) => {
    const issueManager = options.trackerIssueManager.forRepository({
      owner: project.executionRepo.owner,
      repo: project.executionRepo.repo,
    });
    const boardItems = await reconcileProjectIssuesOntoBoard({
      project,
      issueManager,
      boardsClient: options.boardsClient,
    });
    return toProjectInventory(project, activityBySlug.get(project.slug) ?? null, boardItems);
  }));

  return {
    projects: inventories.sort((left, right) => left.project.slug.localeCompare(right.project.slug)),
    activityState,
  };
}
