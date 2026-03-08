import {
  buildStagedWorkInventory,
  type StagedProjectInventory,
  type StagedWorkInventory,
  type StagedWorkItem,
} from "../../issues/stagedWorkInventory.js";
import type { TaskIssueManager } from "../../issues/taskIssueManager.js";
import type { DefaultProjectContext } from "../../projects/projectRegistry.js";
import type { GitHubProjectsV2Client } from "../../github/githubProjectsV2.js";
import type { ProjectWorkflowStage } from "../../projects/projectWorkflow.js";

export function isWorkerActiveProject(project: StagedProjectInventory): boolean {
  return project.activity?.activityState === "active" || project.project.slug === "evolvo";
}

export function selectLowestIssueStageItem(
  items: StagedWorkItem[],
  stage: ProjectWorkflowStage,
): StagedWorkItem | null {
  return items
    .filter((item) => item.stage === stage)
    .sort((left, right) => left.issueNumber - right.issueNumber)[0] ?? null;
}

export function chooseRoundRobinProjectStageItem(
  projects: StagedProjectInventory[],
  cursorSlug: string | null,
  stage: ProjectWorkflowStage,
): { project: StagedProjectInventory; item: StagedWorkItem } | null {
  const activeProjects = projects
    .filter((project) => isWorkerActiveProject(project))
    .sort((left, right) => left.project.slug.localeCompare(right.project.slug));
  if (activeProjects.length === 0) {
    return null;
  }

  const cursorIndex = cursorSlug
    ? activeProjects.findIndex((project) => project.project.slug === cursorSlug)
    : -1;

  for (let offset = 1; offset <= activeProjects.length; offset += 1) {
    const candidateProject = activeProjects[(cursorIndex + offset + activeProjects.length) % activeProjects.length];
    if (!candidateProject) {
      continue;
    }

    const item = selectLowestIssueStageItem(candidateProject.items, stage);
    if (item) {
      return {
        project: candidateProject,
        item,
      };
    }
  }

  return null;
}

export async function buildWorkerInventory(options: {
  workDir: string;
  defaultProject: DefaultProjectContext;
  trackerIssueManager: TaskIssueManager;
  boardsClient: GitHubProjectsV2Client;
}): Promise<StagedWorkInventory> {
  return buildStagedWorkInventory(options);
}