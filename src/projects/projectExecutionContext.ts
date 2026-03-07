import type { IssueSummary } from "../issues/taskIssueManager.js";
import { DEFAULT_PROJECT_SLUG, PROJECT_LABEL_PREFIX } from "./projectNaming.js";
import {
  readProjectRegistry,
  type DefaultProjectContext,
  type ProjectRecord,
} from "./projectRegistry.js";

export const PROJECT_ROUTING_BLOCKED_LABEL = "blocked";

export type ProjectExecutionContext = {
  project: ProjectRecord;
  trackerRepository: string;
  executionRepository: string;
};

export type ProjectExecutionContextResolution =
  | {
    ok: true;
    context: ProjectExecutionContext;
  }
  | {
    ok: false;
    code: "multiple-project-labels" | "unknown-project" | "inactive-project";
    message: string;
    projectLabels: string[];
  };

function normalizeProjectLabel(label: string): string | null {
  const normalized = label.trim().toLowerCase();
  if (!normalized.startsWith(PROJECT_LABEL_PREFIX)) {
    return null;
  }

  const slug = normalized.slice(PROJECT_LABEL_PREFIX.length).trim();
  if (!slug) {
    return null;
  }

  return `${PROJECT_LABEL_PREFIX}${slug}`;
}

function getProjectLabels(labels: string[]): string[] {
  const normalizedLabels = labels
    .map(normalizeProjectLabel)
    .filter((label): label is string => label !== null);
  return [...new Set(normalizedLabels)];
}

function formatRepositoryReference(repository: { owner: string; repo: string }): string {
  return `${repository.owner}/${repository.repo}`;
}

function buildExecutionContext(project: ProjectRecord): ProjectExecutionContext {
  return {
    project,
    trackerRepository: formatRepositoryReference(project.trackerRepo),
    executionRepository: formatRepositoryReference(project.executionRepo),
  };
}

export function resolveProjectExecutionContextFromRegistry(
  issue: IssueSummary,
  registry: { projects: ProjectRecord[] },
): ProjectExecutionContextResolution {
  const projectLabels = getProjectLabels(issue.labels);
  if (projectLabels.length > 1) {
    return {
      ok: false,
      code: "multiple-project-labels",
      message: `Issue has multiple project labels: ${projectLabels.join(", ")}.`,
      projectLabels,
    };
  }

  const requestedSlug = projectLabels[0]?.slice(PROJECT_LABEL_PREFIX.length) ?? DEFAULT_PROJECT_SLUG;
  const project = registry.projects.find((candidate) => candidate.slug === requestedSlug) ?? null;
  if (!project) {
    return {
      ok: false,
      code: "unknown-project",
      message: `No project registry entry exists for label \`${projectLabels[0]}\`.`,
      projectLabels,
    };
  }

  if (project.status !== "active") {
    return {
      ok: false,
      code: "inactive-project",
      message: `Project \`${project.slug}\` exists but is not ready for execution (status: \`${project.status}\`).`,
      projectLabels,
    };
  }

  if (requestedSlug === DEFAULT_PROJECT_SLUG && project.slug !== DEFAULT_PROJECT_SLUG) {
    return {
      ok: false,
      code: "unknown-project",
      message: `The default project label must resolve to \`${DEFAULT_PROJECT_SLUG}\`.`,
      projectLabels,
    };
  }

  return {
    ok: true,
    context: buildExecutionContext(project),
  };
}

export async function resolveProjectExecutionContextForIssue(options: {
  issue: IssueSummary;
  workDir: string;
  defaultProject: DefaultProjectContext;
}): Promise<ProjectExecutionContextResolution> {
  const registry = await readProjectRegistry(options.workDir, options.defaultProject);
  return resolveProjectExecutionContextFromRegistry(options.issue, registry);
}

export function buildProjectRoutingBlockedComment(
  issue: IssueSummary,
  resolution: Extract<ProjectExecutionContextResolution, { ok: false }>,
): string {
  const projectLabelLine = resolution.projectLabels.length > 0
    ? `- Project labels on the issue: ${resolution.projectLabels.map((label) => `\`${label}\``).join(", ")}`
    : "- Project labels on the issue: none";

  const actionLine = resolution.code === "multiple-project-labels"
    ? "- Action: keep exactly one valid `project:<slug>` label, or remove all project labels to route this issue to the default Evolvo project, then remove the `blocked` label to retry execution."
    : resolution.code === "inactive-project"
      ? "- Action: finish or repair project provisioning so the registry status becomes `active`, then remove the `blocked` label to retry execution."
      : "- Action: add a valid `project:<slug>` label from `.evolvo/projects.json`, or remove project labels to route this issue to the default Evolvo project, then remove the `blocked` label to retry execution.";

  return [
    "## Project Routing Blocked",
    `- Issue #${issue.number} cannot start because its project routing is invalid.`,
    projectLabelLine,
    `- Diagnostic: ${resolution.message}`,
    actionLine,
  ].join("\n");
}
