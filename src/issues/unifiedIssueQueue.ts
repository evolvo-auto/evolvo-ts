import type { DefaultProjectContext, ProjectRecord } from "../projects/projectRegistry.js";
import { findProjectBySlug, readProjectRegistry } from "../projects/projectRegistry.js";
import type { ActiveProjectState } from "../projects/activeProjectState.js";
import { readActiveProjectsState } from "../projects/activeProjectsState.js";
import type {
  IssueSummary,
  TaskIssueManager,
  UnauthorizedIssueClosureResult,
} from "./taskIssueManager.js";

export type UnifiedIssue = IssueSummary & {
  queueKey: string;
  sourceKind: "tracker" | "project-repo";
  projectSlug: string | null;
  repository: {
    owner: string;
    repo: string;
    url: string;
    reference: string;
  };
  project: ProjectRecord | null;
};

export type UnifiedIssueQueue = {
  issues: UnifiedIssue[];
  unauthorizedClosures: UnauthorizedIssueClosureResult[];
  activeManagedProject: ProjectRecord | null;
  activeManagedProjects: ProjectRecord[];
};

function buildRepositoryReference(repository: { owner: string; repo: string }): string {
  return `${repository.owner}/${repository.repo}`;
}

function buildTrackerUnifiedIssue(
  issue: IssueSummary,
  defaultProject: DefaultProjectContext,
): UnifiedIssue {
  return {
    ...issue,
    queueKey: `tracker:${defaultProject.owner}/${defaultProject.repo}#${issue.number}`,
    sourceKind: "tracker",
    projectSlug: null,
    repository: {
      owner: defaultProject.owner,
      repo: defaultProject.repo,
      url: `https://github.com/${defaultProject.owner}/${defaultProject.repo}`,
      reference: buildRepositoryReference(defaultProject),
    },
    project: null,
  };
}

function buildProjectUnifiedIssue(issue: IssueSummary, project: ProjectRecord): UnifiedIssue {
  return {
    ...issue,
    queueKey: `project:${project.slug}#${issue.number}`,
    sourceKind: "project-repo",
    projectSlug: project.slug,
    repository: {
      owner: project.executionRepo.owner,
      repo: project.executionRepo.repo,
      url: project.executionRepo.url,
      reference: buildRepositoryReference(project.executionRepo),
    },
    project,
  };
}

function isActiveManagedProject(project: ProjectRecord | null): project is ProjectRecord {
  return project !== null && project.kind === "managed" && project.status === "active";
}

async function resolveManagedProjectQueueState(
  workDir: string,
  defaultProject: DefaultProjectContext,
  activeProjectState: ActiveProjectState,
): Promise<{
  activeManagedProject: ProjectRecord | null;
  activeManagedProjects: ProjectRecord[];
}> {
  const [registry, activeProjectsState] = await Promise.all([
    readProjectRegistry(workDir, defaultProject),
    readActiveProjectsState(workDir),
  ]);

  const activeManagedProjectsBySlug = new Map<string, ProjectRecord>();
  for (const entry of activeProjectsState.projects) {
    const project = findProjectBySlug(registry, entry.slug);
    if (!isActiveManagedProject(project)) {
      continue;
    }

    activeManagedProjectsBySlug.set(project.slug, project);
  }

  let activeManagedProject: ProjectRecord | null = null;
  if (
    activeProjectState.selectionState === "active"
    && activeProjectState.activeProjectSlug !== null
  ) {
    const focusedProject = findProjectBySlug(registry, activeProjectState.activeProjectSlug);
    if (isActiveManagedProject(focusedProject)) {
      activeManagedProject = focusedProject;
      activeManagedProjectsBySlug.set(focusedProject.slug, focusedProject);
    }
  }

  return {
    activeManagedProject,
    activeManagedProjects: [...activeManagedProjectsBySlug.values()].sort((left, right) =>
      left.slug.localeCompare(right.slug)
    ),
  };
}

export async function buildUnifiedIssueQueue(options: {
  trackerIssueManager: TaskIssueManager;
  workDir: string;
  defaultProject: DefaultProjectContext;
  activeProjectState: ActiveProjectState;
}): Promise<UnifiedIssueQueue> {
  const trackerInventory = await options.trackerIssueManager.listAuthorizedOpenIssues();
  const managedProjectQueueState = await resolveManagedProjectQueueState(
    options.workDir,
    options.defaultProject,
    options.activeProjectState,
  );
  const { activeManagedProject, activeManagedProjects } = managedProjectQueueState;

  const issues: UnifiedIssue[] = trackerInventory.issues.map((issue) => buildTrackerUnifiedIssue(issue, options.defaultProject));

  if (activeManagedProjects.length > 0) {
    const projectIssues = await Promise.all(activeManagedProjects.map(async (project) => {
      const projectIssueManager = options.trackerIssueManager.forRepository({
        owner: project.executionRepo.owner,
        repo: project.executionRepo.repo,
      });
      const issuesForProject = await projectIssueManager.listOpenIssues();
      return issuesForProject.map((issue) => buildProjectUnifiedIssue(issue, project));
    }));
    issues.unshift(...projectIssues.flat());
  }

  return {
    issues,
    unauthorizedClosures: trackerInventory.unauthorizedClosures,
    activeManagedProject,
    activeManagedProjects,
  };
}
