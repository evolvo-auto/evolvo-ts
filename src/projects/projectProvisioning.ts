import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildProjectProvisioningIssueBody,
  buildProjectProvisioningIssueTitle,
  isProjectProvisioningIssue,
  parseProjectProvisioningIssueMetadata,
  type ProjectProvisioningIssueMetadata,
} from "../issues/projectProvisioningIssue.js";
import type { IssueSummary, TaskIssueManager } from "../issues/taskIssueManager.js";
import { setActiveProjectState } from "./activeProjectState.js";
import { normalizeProjectNameInput } from "./projectNaming.js";
import {
  findProjectBySlug,
  readProjectRegistry,
  upsertProjectRecord,
  type DefaultProjectContext,
  type ProjectRecord,
} from "./projectRegistry.js";

type ProjectProvisioningIssueManager = Pick<TaskIssueManager, "createIssue" | "listOpenIssues">;

export type ProjectProvisioningAdminClient = {
  ensureLabel: (options: {
    owner: string;
    repo: string;
    name: string;
    color?: string;
    description?: string;
  }) => Promise<void>;
  ensureRepository: (options: {
    owner: string;
    repo: string;
    description?: string;
  }) => Promise<{
    owner: string;
    repo: string;
    url: string;
    defaultBranch: string | null;
  }>;
};

export type CreateProjectProvisioningRequestResult =
  | {
    ok: true;
    message: string;
    issueNumber: number;
    issueUrl: string;
    metadata: ProjectProvisioningIssueMetadata;
  }
  | {
    ok: false;
    message: string;
  };

export type StartProjectCommandHandlingResult =
  | {
    ok: true;
    action: "created";
    message: string;
    project: {
      displayName: string;
      slug: string;
      repositoryName: string;
      workspacePath: string;
      status: "provisioning";
    };
    trackerIssue: {
      number: number;
      url: string;
      alreadyOpen: boolean;
    };
  }
  | {
    ok: true;
    action: "resumed";
    message: string;
    project: {
      displayName: string;
      slug: string;
      repositoryName: string;
      repositoryUrl: string;
      workspacePath: string;
      status: ProjectRecord["status"];
    };
    trackerIssue?: {
      number: number;
      url: string;
      alreadyOpen: boolean;
    };
  }
  | {
    ok: false;
    message: string;
  };

export type ProjectProvisioningExecutionResult = {
  ok: boolean;
  metadata: ProjectProvisioningIssueMetadata;
  record: ProjectRecord;
  failureStep: "registry" | "label" | "repository" | "workspace" | "active-project" | null;
  message: string;
};

function buildRepositoryUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}`;
}

function buildProjectProvisioningIssueUrl(owner: string, repo: string, issueNumber: number): string {
  return `https://github.com/${owner}/${repo}/issues/${issueNumber}`;
}

function buildDefaultProjectContext(workDir: string, owner: string, repo: string): DefaultProjectContext {
  return {
    owner,
    repo,
    workDir,
  };
}

function buildManagedProjectRecord(
  metadata: ProjectProvisioningIssueMetadata,
  options: {
    workDir: string;
    trackerOwner: string;
    trackerRepo: string;
    issueNumber: number;
    now: string;
  },
  existing: ProjectRecord | null,
): ProjectRecord {
  const workspacePath = resolve(options.workDir, metadata.workspaceRelativePath);
  const createdAt = existing?.createdAt ?? options.now;

  return {
    slug: metadata.slug,
    displayName: metadata.displayName,
    kind: "managed",
    issueLabel: metadata.issueLabel,
    trackerRepo: {
      owner: options.trackerOwner,
      repo: options.trackerRepo,
      url: buildRepositoryUrl(options.trackerOwner, options.trackerRepo),
    },
    executionRepo: {
      owner: existing?.executionRepo.owner ?? metadata.owner,
      repo: existing?.executionRepo.repo ?? metadata.repositoryName,
      url: existing?.executionRepo.url ?? buildRepositoryUrl(metadata.owner, metadata.repositoryName),
      defaultBranch: existing?.executionRepo.defaultBranch ?? null,
    },
    cwd: existing?.cwd ?? workspacePath,
    status: existing?.status ?? "provisioning",
    sourceIssueNumber: options.issueNumber,
    createdAt,
    updatedAt: options.now,
    provisioning: {
      labelCreated: existing?.provisioning.labelCreated ?? false,
      repoCreated: existing?.provisioning.repoCreated ?? false,
      workspacePrepared: existing?.provisioning.workspacePrepared ?? false,
      lastError: existing?.provisioning.lastError ?? null,
    },
  };
}

async function findOpenProvisioningIssueForSlug(
  issueManager: ProjectProvisioningIssueManager,
  slug: string,
): Promise<IssueSummary | null> {
  const openIssues = await issueManager.listOpenIssues();
  return openIssues.find((issue) => {
    const metadata = parseProjectProvisioningIssueMetadata(issue.description);
    return metadata?.slug === slug;
  }) ?? null;
}

function buildProjectProvisioningMetadata(options: {
  trackerOwner: string;
  normalizedProject: ReturnType<typeof normalizeProjectNameInput>;
  requestedBy: string;
  requestedAt?: string;
}): ProjectProvisioningIssueMetadata {
  return {
    owner: options.trackerOwner,
    displayName: options.normalizedProject.displayName,
    slug: options.normalizedProject.slug,
    repositoryName: options.normalizedProject.repositoryName,
    issueLabel: options.normalizedProject.issueLabel,
    workspaceRelativePath: options.normalizedProject.workspaceRelativePath,
    requestedBy: options.requestedBy,
    requestedAt: options.requestedAt?.trim() || new Date().toISOString(),
  };
}

function buildCreatedStartProjectResult(options: {
  metadata: ProjectProvisioningIssueMetadata;
  trackerOwner: string;
  trackerRepo: string;
  issueNumber: number;
  alreadyOpen: boolean;
}): StartProjectCommandHandlingResult {
  const issueUrl = buildProjectProvisioningIssueUrl(options.trackerOwner, options.trackerRepo, options.issueNumber);
  return {
    ok: true,
    action: "created",
    message: options.alreadyOpen
      ? `Project \`${options.metadata.slug}\` is already queued for provisioning in issue #${options.issueNumber}.`
      : `Created provisioning issue #${options.issueNumber} for project \`${options.metadata.slug}\`.`,
    project: {
      displayName: options.metadata.displayName,
      slug: options.metadata.slug,
      repositoryName: options.metadata.repositoryName,
      workspacePath: options.metadata.workspaceRelativePath,
      status: "provisioning",
    },
    trackerIssue: {
      number: options.issueNumber,
      url: issueUrl,
      alreadyOpen: options.alreadyOpen,
    },
  };
}

function buildResumedStartProjectResult(
  record: ProjectRecord,
  message: string,
  trackerIssue?: {
    number: number;
    url: string;
    alreadyOpen: boolean;
  },
): StartProjectCommandHandlingResult {
  return {
    ok: true,
    action: "resumed",
    message,
    project: {
      displayName: record.displayName,
      slug: record.slug,
      repositoryName: record.executionRepo.repo,
      repositoryUrl: record.executionRepo.url,
      workspacePath: record.cwd,
      status: record.status,
    },
    ...(trackerIssue ? { trackerIssue } : {}),
  };
}

export async function createProjectProvisioningRequestIssue(options: {
  issueManager: ProjectProvisioningIssueManager;
  workDir: string;
  trackerOwner: string;
  trackerRepo: string;
  projectName: string;
  requestedBy: string;
  requestedAt?: string;
}): Promise<CreateProjectProvisioningRequestResult> {
  try {
    const normalized = normalizeProjectNameInput(options.projectName);
    const defaultProject = buildDefaultProjectContext(options.workDir, options.trackerOwner, options.trackerRepo);
    const registry = await readProjectRegistry(options.workDir, defaultProject);
    const existingProject = findProjectBySlug(registry, normalized.slug);
    if (existingProject && existingProject.status !== "failed") {
      return {
        ok: false,
        message: `Project \`${normalized.slug}\` already exists in the registry with status \`${existingProject.status}\`.`,
      };
    }

    const duplicateIssue = await findOpenProvisioningIssueForSlug(options.issueManager, normalized.slug);
    if (duplicateIssue) {
      return {
        ok: false,
        message: `Project \`${normalized.slug}\` already has an open provisioning request issue #${duplicateIssue.number}.`,
      };
    }

    const metadata = buildProjectProvisioningMetadata({
      trackerOwner: options.trackerOwner,
      normalizedProject: normalized,
      requestedBy: options.requestedBy,
      requestedAt: options.requestedAt,
    });
    const created = await options.issueManager.createIssue(
      buildProjectProvisioningIssueTitle(metadata.displayName),
      buildProjectProvisioningIssueBody(metadata),
    );
    if (!created.ok || !created.issue) {
      return { ok: false, message: created.message };
    }

    return {
      ok: true,
      message: created.message,
      issueNumber: created.issue.number,
      issueUrl: buildProjectProvisioningIssueUrl(options.trackerOwner, options.trackerRepo, created.issue.number),
      metadata,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Unknown project provisioning request error.",
    };
  }
}

export async function handleStartProjectCommand(options: {
  issueManager: ProjectProvisioningIssueManager;
  workDir: string;
  trackerOwner: string;
  trackerRepo: string;
  projectName: string;
  requestedBy: string;
  requestedAt?: string;
}): Promise<StartProjectCommandHandlingResult> {
  try {
    const normalized = normalizeProjectNameInput(options.projectName);
    const defaultProject = buildDefaultProjectContext(options.workDir, options.trackerOwner, options.trackerRepo);
    const registry = await readProjectRegistry(options.workDir, defaultProject);
    const existingProject = findProjectBySlug(registry, normalized.slug);
    const duplicateIssue = await findOpenProvisioningIssueForSlug(options.issueManager, normalized.slug);

    if (existingProject && existingProject.status !== "failed") {
      await setActiveProjectState({
        workDir: options.workDir,
        slug: existingProject.slug,
        requestedBy: options.requestedBy,
        source: "start-project-command",
        updatedAt: options.requestedAt,
      });
      return buildResumedStartProjectResult(
        existingProject,
        existingProject.status === "active"
          ? `Resumed existing project \`${existingProject.slug}\`.`
          : `Project \`${existingProject.slug}\` already exists with status \`${existingProject.status}\`; resuming that flow.`,
      );
    }

    if (existingProject && existingProject.status === "failed") {
      if (duplicateIssue) {
        await setActiveProjectState({
          workDir: options.workDir,
          slug: existingProject.slug,
          requestedBy: options.requestedBy,
          source: "start-project-command",
          updatedAt: options.requestedAt,
        });
        return buildResumedStartProjectResult(
          existingProject,
          `Resumed existing project \`${existingProject.slug}\` and kept recovery issue #${duplicateIssue.number} active.`,
          {
            number: duplicateIssue.number,
            url: buildProjectProvisioningIssueUrl(options.trackerOwner, options.trackerRepo, duplicateIssue.number),
            alreadyOpen: true,
          },
        );
      }

      const recoveryRequest = await createProjectProvisioningRequestIssue({
        issueManager: options.issueManager,
        workDir: options.workDir,
        trackerOwner: options.trackerOwner,
        trackerRepo: options.trackerRepo,
        projectName: options.projectName,
        requestedBy: options.requestedBy,
        requestedAt: options.requestedAt,
      });
      if (!recoveryRequest.ok) {
        return recoveryRequest;
      }

      await setActiveProjectState({
        workDir: options.workDir,
        slug: existingProject.slug,
        requestedBy: options.requestedBy,
        source: "start-project-command",
        updatedAt: options.requestedAt,
      });
      return buildResumedStartProjectResult(
        existingProject,
        `Resumed existing project \`${existingProject.slug}\` and queued recovery issue #${recoveryRequest.issueNumber}.`,
        {
          number: recoveryRequest.issueNumber,
          url: recoveryRequest.issueUrl,
          alreadyOpen: false,
        },
      );
    }

    if (duplicateIssue) {
      await setActiveProjectState({
        workDir: options.workDir,
        slug: normalized.slug,
        requestedBy: options.requestedBy,
        source: "start-project-command",
        updatedAt: options.requestedAt,
      });
      const metadata = buildProjectProvisioningMetadata({
        trackerOwner: options.trackerOwner,
        normalizedProject: normalized,
        requestedBy: options.requestedBy,
        requestedAt: options.requestedAt,
      });
      return buildCreatedStartProjectResult({
        metadata,
        trackerOwner: options.trackerOwner,
        trackerRepo: options.trackerRepo,
        issueNumber: duplicateIssue.number,
        alreadyOpen: true,
      });
    }

    const request = await createProjectProvisioningRequestIssue({
      issueManager: options.issueManager,
      workDir: options.workDir,
      trackerOwner: options.trackerOwner,
      trackerRepo: options.trackerRepo,
      projectName: options.projectName,
      requestedBy: options.requestedBy,
      requestedAt: options.requestedAt,
    });
    if (!request.ok) {
      return request;
    }

    await setActiveProjectState({
      workDir: options.workDir,
      slug: request.metadata.slug,
      requestedBy: options.requestedBy,
      source: "start-project-command",
      updatedAt: options.requestedAt,
    });
    return buildCreatedStartProjectResult({
      metadata: request.metadata,
      trackerOwner: options.trackerOwner,
      trackerRepo: options.trackerRepo,
      issueNumber: request.issueNumber,
      alreadyOpen: false,
    });
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Unknown project start request error.",
    };
  }
}

export async function executeProjectProvisioningIssue(options: {
  issue: IssueSummary;
  workDir: string;
  trackerOwner: string;
  trackerRepo: string;
  adminClient: ProjectProvisioningAdminClient;
}): Promise<ProjectProvisioningExecutionResult> {
  const metadata = parseProjectProvisioningIssueMetadata(options.issue.description);
  if (!metadata) {
    throw new Error(`Issue #${options.issue.number} is not a valid project provisioning request.`);
  }

  const defaultProject = buildDefaultProjectContext(options.workDir, options.trackerOwner, options.trackerRepo);
  const registry = await readProjectRegistry(options.workDir, defaultProject);
  const existingProject = findProjectBySlug(registry, metadata.slug);
  let record = buildManagedProjectRecord(metadata, {
    workDir: options.workDir,
    trackerOwner: options.trackerOwner,
    trackerRepo: options.trackerRepo,
    issueNumber: options.issue.number,
    now: new Date().toISOString(),
  }, existingProject);

  const persistRecord = async (
    overrides: Partial<ProjectRecord>,
    provisioningOverrides: Partial<ProjectRecord["provisioning"]> = {},
  ): Promise<void> => {
    record = {
      ...record,
      ...overrides,
      updatedAt: new Date().toISOString(),
      provisioning: {
        ...record.provisioning,
        ...provisioningOverrides,
      },
    };
    await upsertProjectRecord(options.workDir, defaultProject, record);
  };

  try {
    await persistRecord(
      {
        status: "provisioning",
      },
      {
        lastError: null,
      },
    );
  } catch (error) {
    return {
      ok: false,
      metadata,
      record,
      failureStep: "registry",
      message: error instanceof Error ? error.message : "Unknown project registry error.",
    };
  }

  try {
    await options.adminClient.ensureLabel({
      owner: options.trackerOwner,
      repo: options.trackerRepo,
      name: metadata.issueLabel,
      description: `Issues for managed project ${metadata.displayName}`,
    });
    await persistRecord({}, { labelCreated: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown tracker label provisioning error.";
    await persistRecord({ status: "failed" }, { lastError: message }).catch(() => undefined);
    return {
      ok: false,
      metadata,
      record,
      failureStep: "label",
      message,
    };
  }

  try {
    const repository = await options.adminClient.ensureRepository({
      owner: metadata.owner,
      repo: metadata.repositoryName,
      description: `Managed by Evolvo for project ${metadata.displayName}.`,
    });
    await persistRecord(
      {
        executionRepo: {
          owner: repository.owner,
          repo: repository.repo,
          url: repository.url,
          defaultBranch: repository.defaultBranch,
        },
      },
      { repoCreated: true },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown managed repository provisioning error.";
    await persistRecord({ status: "failed" }, { lastError: message }).catch(() => undefined);
    return {
      ok: false,
      metadata,
      record,
      failureStep: "repository",
      message,
    };
  }

  try {
    const workspacePath = resolve(options.workDir, metadata.workspaceRelativePath);
    await mkdir(workspacePath, { recursive: true });
    await persistRecord(
      {
        cwd: workspacePath,
        status: "active",
      },
      {
        workspacePrepared: true,
        lastError: null,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown workspace provisioning error.";
    await persistRecord({ status: "failed" }, { lastError: message }).catch(() => undefined);
    return {
      ok: false,
      metadata,
      record,
      failureStep: "workspace",
      message,
    };
  }

  try {
    await setActiveProjectState({
      workDir: options.workDir,
      slug: metadata.slug,
      requestedBy: metadata.requestedBy,
      source: "project-provisioning",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown active project state update error.";
    await persistRecord({ status: "failed" }, { lastError: message }).catch(() => undefined);
    return {
      ok: false,
      metadata,
      record,
      failureStep: "active-project",
      message,
    };
  }

  return {
    ok: true,
    metadata,
    record,
    failureStep: null,
    message: `Provisioned project ${metadata.displayName}.`,
  };
}

function formatStepStatus(value: boolean): string {
  return value ? "yes" : "no";
}

export function buildProjectProvisioningOutcomeComment(
  result: ProjectProvisioningExecutionResult,
): string {
  const repositoryLine = result.record.provisioning.repoCreated
    ? `- Managed repository: ${result.record.executionRepo.url}`
    : `- Managed repository: pending (\`${result.metadata.owner}/${result.metadata.repositoryName}\`)`;
  const branchLine = result.record.provisioning.repoCreated
    ? `- Repository default branch: ${result.record.executionRepo.defaultBranch ? `\`${result.record.executionRepo.defaultBranch}\`` : "unknown"}`
    : "- Repository default branch: not available";
  const workspaceLine = result.record.provisioning.workspacePrepared
    ? `- Local workspace: \`${result.record.cwd}\``
    : `- Local workspace: pending (\`${result.metadata.workspaceRelativePath}\`)`;

  const lines = [
    "## Project Provisioning",
    `- Outcome: ${result.ok ? "succeeded" : "failed"}.`,
    `- Project: \`${result.metadata.displayName}\` (\`${result.metadata.slug}\`)`,
    `- Tracker label ensured: ${formatStepStatus(result.record.provisioning.labelCreated)} (\`${result.metadata.issueLabel}\`)`,
    repositoryLine,
    branchLine,
    workspaceLine,
    `- Registry status: \`${result.record.status}\``,
  ];

  if (!result.ok) {
    lines.push(`- Failure step: \`${result.failureStep ?? "unknown"}\``);
    lines.push(`- Error: ${result.message}`);
    lines.push("- Recovery: inspect `.evolvo/projects.json`, fix the failing step, then resend `/startProject <project-name>` to requeue provisioning.");
  }

  return lines.join("\n");
}

export function buildProjectProvisioningCompletionSummary(
  result: ProjectProvisioningExecutionResult,
): string {
  return [
    `Provisioned managed project \`${result.metadata.displayName}\`.`,
    `Label: \`${result.metadata.issueLabel}\`.`,
    `Repository: ${result.record.executionRepo.url}.`,
    `Workspace: \`${result.record.cwd}\`.`,
  ].join(" ");
}

export function isProjectProvisioningRequestIssue(issue: IssueSummary): boolean {
  return isProjectProvisioningIssue(issue);
}
