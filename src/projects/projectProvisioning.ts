import { mkdir, stat } from "node:fs/promises";
import {
  buildProjectProvisioningIssueBody,
  buildProjectProvisioningIssueTitle,
  isProjectProvisioningIssue,
  parseProjectProvisioningIssueMetadata,
  type ProjectProvisioningIssueMetadata,
} from "../issues/projectProvisioningIssue.js";
import { deployProjectRepositoryWithVercel, type ProjectRepositoryDeploymentResult } from "../deployment/vercelDeployment.js";
import type { IssueSummary, TaskIssueManager } from "../issues/taskIssueManager.js";
import type { GitHubProjectsV2Client } from "../github/githubProjectsV2.js";
import { setActiveProjectState } from "./activeProjectState.js";
import { activateProjectInState } from "./activeProjectsState.js";
import {
  normalizeProjectNameInput,
  resolveManagedProjectWorkspacePath,
} from "./projectNaming.js";
import {
  findProjectBySlug,
  readProjectRegistry,
  upsertProjectRecord,
  type DefaultProjectContext,
  type ProjectRecord,
} from "./projectRegistry.js";
import { createDefaultProjectWorkflow } from "./projectWorkflow.js";
import { ensureProjectBoardRegistration } from "./projectBoards.js";

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
    id: number | null;
    owner: string;
    repo: string;
    url: string;
    defaultBranch: string | null;
    description: string | null;
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
  failureStep: "registry" | "label" | "repository" | "workflow" | "workspace" | "deployment" | "active-project" | null;
  workspaceAction: "created" | "reused" | null;
  deployment: ProjectRepositoryDeploymentResult | null;
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

function canonicalizeProjectProvisioningMetadata(
  metadata: ProjectProvisioningIssueMetadata,
  workspaceRoot?: string,
): ProjectProvisioningIssueMetadata {
  return {
    ...metadata,
    workspacePath: resolveManagedProjectWorkspacePath(metadata.slug, workspaceRoot),
  };
}

async function ensureManagedProjectWorkspaceDirectory(workspacePath: string): Promise<{
  workspacePath: string;
  workspaceAction: "created" | "reused";
}> {
  let workspaceAction: "created" | "reused" = "created";

  try {
    const currentPath = await stat(workspacePath);
    if (!currentPath.isDirectory()) {
      throw new Error(`Managed project workspace path ${workspacePath} exists but is not a directory.`);
    }
    workspaceAction = "reused";
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode !== "ENOENT") {
      throw error;
    }
  }

  await mkdir(workspacePath, { recursive: true });
  return {
    workspacePath,
    workspaceAction,
  };
}

function buildManagedProjectRecord(
  metadata: ProjectProvisioningIssueMetadata,
  options: {
    issueNumber: number;
    now: string;
  },
  existing: ProjectRecord | null,
): ProjectRecord {
  const createdAt = existing?.createdAt ?? options.now;
  const repositoryOwner = existing?.executionRepo.owner ?? metadata.owner;
  const repositoryName = existing?.executionRepo.repo ?? metadata.repositoryName;
  const repositoryUrl = existing?.executionRepo.url ?? buildRepositoryUrl(metadata.owner, metadata.repositoryName);

  return {
    slug: metadata.slug,
    displayName: metadata.displayName,
    kind: "managed",
    issueLabel: metadata.issueLabel,
    trackerRepo: {
      owner: repositoryOwner,
      repo: repositoryName,
      url: repositoryUrl,
    },
    executionRepo: {
      owner: repositoryOwner,
      repo: repositoryName,
      url: repositoryUrl,
      defaultBranch: existing?.executionRepo.defaultBranch ?? null,
    },
    cwd: metadata.workspacePath,
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
    workflow: existing?.workflow ?? createDefaultProjectWorkflow(repositoryOwner),
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
    workspacePath: options.normalizedProject.workspacePath,
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
      ? `Project \`${options.metadata.slug}\` is already queued for provisioning in issue #${options.issueNumber}. Canonical workspace: \`${options.metadata.workspacePath}\`.`
      : `Created provisioning issue #${options.issueNumber} for project \`${options.metadata.slug}\`. Canonical workspace: \`${options.metadata.workspacePath}\`.`,
    project: {
      displayName: options.metadata.displayName,
      slug: options.metadata.slug,
      repositoryName: options.metadata.repositoryName,
      workspacePath: options.metadata.workspacePath,
      status: "provisioning",
    },
    trackerIssue: {
      number: options.issueNumber,
      url: issueUrl,
      alreadyOpen: options.alreadyOpen,
    },
  };
}

async function synchronizeManagedProjectWorkspace(options: {
  workDir: string;
  defaultProject: DefaultProjectContext;
  project: ProjectRecord;
  workspaceRoot?: string;
}): Promise<{
  project: ProjectRecord;
  workspaceAction: "created" | "reused" | null;
}> {
  if (options.project.kind !== "managed") {
    return {
      project: options.project,
      workspaceAction: null,
    };
  }

  const { workspacePath, workspaceAction } = await ensureManagedProjectWorkspaceDirectory(
    resolveManagedProjectWorkspacePath(options.project.slug, options.workspaceRoot),
  );
  const trackerRepo = {
    owner: options.project.executionRepo.owner,
    repo: options.project.executionRepo.repo,
    url: options.project.executionRepo.url,
  };
  const trackerRepoReference = `${trackerRepo.owner}/${trackerRepo.repo}`;
  const trackerRepoChanged =
    options.project.trackerRepo.owner !== trackerRepo.owner
    || options.project.trackerRepo.repo !== trackerRepo.repo
    || options.project.trackerRepo.url !== trackerRepo.url;
  const nextProject: ProjectRecord = {
    ...options.project,
    trackerRepo,
    cwd: workspacePath,
    updatedAt: new Date().toISOString(),
    provisioning: {
      ...options.project.provisioning,
      workspacePrepared: true,
    },
  };

  await upsertProjectRecord(options.workDir, options.defaultProject, nextProject);
  console.log(
    options.project.status === "active"
      ? `[project-workspace] resolved ${workspacePath}; ${workspaceAction === "created" ? "created directory" : "reused existing directory"}; ${workspacePath} is now the active working directory for project ${options.project.slug}.`
      : `[project-workspace] resolved ${workspacePath}; ${workspaceAction === "created" ? "created directory" : "reused existing directory"}; ${workspacePath} is the canonical project workspace for ${options.project.slug}.`,
  );
  if (trackerRepoChanged) {
    console.log(
      `[project-registry] corrected tracker repository for project ${options.project.slug}; projects.json now records ${trackerRepoReference}.`,
    );
  }

  return {
    project: nextProject,
    workspaceAction,
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
  workspaceRoot?: string;
}): Promise<CreateProjectProvisioningRequestResult> {
  try {
    const normalized = normalizeProjectNameInput(options.projectName, {
      workspaceRoot: options.workspaceRoot,
    });
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
  workspaceRoot?: string;
  allowCreateIfMissing?: boolean;
}): Promise<StartProjectCommandHandlingResult> {
  try {
    const allowCreateIfMissing = options.allowCreateIfMissing ?? true;
    const normalized = normalizeProjectNameInput(options.projectName, {
      workspaceRoot: options.workspaceRoot,
    });
    const defaultProject = buildDefaultProjectContext(options.workDir, options.trackerOwner, options.trackerRepo);
    const registry = await readProjectRegistry(options.workDir, defaultProject);
    const existingProject = findProjectBySlug(registry, normalized.slug);
    const duplicateIssue = await findOpenProvisioningIssueForSlug(options.issueManager, normalized.slug);

    if (existingProject && existingProject.status !== "failed") {
      const synchronizedWorkspace = await synchronizeManagedProjectWorkspace({
        workDir: options.workDir,
        defaultProject,
        project: existingProject,
        workspaceRoot: options.workspaceRoot,
      });
      await setActiveProjectState({
        workDir: options.workDir,
        slug: synchronizedWorkspace.project.slug,
        requestedBy: options.requestedBy,
        source: "start-project-command",
        updatedAt: options.requestedAt,
      });
      return buildResumedStartProjectResult(
        synchronizedWorkspace.project,
        synchronizedWorkspace.project.status === "active"
          ? `Resumed existing project \`${synchronizedWorkspace.project.slug}\`. ${synchronizedWorkspace.workspaceAction === "created" ? "Created missing workspace directory" : "Reused existing workspace directory"} \`${synchronizedWorkspace.project.cwd}\`, and that path is now the active working directory.`
          : `Project \`${synchronizedWorkspace.project.slug}\` already exists with status \`${synchronizedWorkspace.project.status}\`; resuming that flow from canonical workspace \`${synchronizedWorkspace.project.cwd}\`.`,
      );
    }

    if (existingProject && existingProject.status === "failed") {
      const synchronizedWorkspace = await synchronizeManagedProjectWorkspace({
        workDir: options.workDir,
        defaultProject,
        project: existingProject,
        workspaceRoot: options.workspaceRoot,
      });
      if (duplicateIssue) {
        await setActiveProjectState({
          workDir: options.workDir,
          slug: synchronizedWorkspace.project.slug,
          requestedBy: options.requestedBy,
          source: "start-project-command",
          updatedAt: options.requestedAt,
        });
        return buildResumedStartProjectResult(
          synchronizedWorkspace.project,
          `Resumed existing project \`${synchronizedWorkspace.project.slug}\` and kept recovery issue #${duplicateIssue.number} active. Canonical workspace: \`${synchronizedWorkspace.project.cwd}\`.`,
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
        workspaceRoot: options.workspaceRoot,
      });
      if (!recoveryRequest.ok) {
        return recoveryRequest;
      }

      await setActiveProjectState({
        workDir: options.workDir,
        slug: synchronizedWorkspace.project.slug,
        requestedBy: options.requestedBy,
        source: "start-project-command",
        updatedAt: options.requestedAt,
      });
      return buildResumedStartProjectResult(
        synchronizedWorkspace.project,
        `Resumed existing project \`${synchronizedWorkspace.project.slug}\` and queued recovery issue #${recoveryRequest.issueNumber}. Canonical workspace: \`${synchronizedWorkspace.project.cwd}\`.`,
        {
          number: recoveryRequest.issueNumber,
          url: recoveryRequest.issueUrl,
          alreadyOpen: false,
        },
      );
    }

    if (!allowCreateIfMissing) {
      return {
        ok: false,
        message: `Project \`${normalized.slug}\` is not registered. Select a registered project and retry.`,
      };
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
      workspaceRoot: options.workspaceRoot,
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
  boardsClient?: Pick<GitHubProjectsV2Client, "ensureProjectBoard">;
  workspaceRoot?: string;
  deployRepository?: typeof deployProjectRepositoryWithVercel;
}): Promise<ProjectProvisioningExecutionResult> {
  const parsedMetadata = parseProjectProvisioningIssueMetadata(options.issue.description);
  if (!parsedMetadata) {
    throw new Error(`Issue #${options.issue.number} is not a valid project provisioning request.`);
  }
  const metadata = canonicalizeProjectProvisioningMetadata(parsedMetadata, options.workspaceRoot);

  const defaultProject = buildDefaultProjectContext(options.workDir, options.trackerOwner, options.trackerRepo);
  const registry = await readProjectRegistry(options.workDir, defaultProject);
  const existingProject = findProjectBySlug(registry, metadata.slug);
  let record = buildManagedProjectRecord(metadata, {
    issueNumber: options.issue.number,
    now: new Date().toISOString(),
  }, existingProject);
  let workspaceAction: "created" | "reused" | null = null;
  let deployment: ProjectRepositoryDeploymentResult | null = null;
  let repositoryMetadata: Awaited<ReturnType<ProjectProvisioningAdminClient["ensureRepository"]>> | null = null;
  const deployRepository = options.deployRepository ?? deployProjectRepositoryWithVercel;

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
      workspaceAction,
      deployment,
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
      workspaceAction,
      deployment,
      message,
    };
  }

  try {
    repositoryMetadata = await options.adminClient.ensureRepository({
      owner: metadata.owner,
      repo: metadata.repositoryName,
      description: `Managed by Evolvo for project ${metadata.displayName}.`,
    });
    await persistRecord(
      {
        trackerRepo: {
          owner: repositoryMetadata.owner,
          repo: repositoryMetadata.repo,
          url: repositoryMetadata.url,
        },
        executionRepo: {
          owner: repositoryMetadata.owner,
          repo: repositoryMetadata.repo,
          url: repositoryMetadata.url,
          defaultBranch: repositoryMetadata.defaultBranch,
        },
      },
      { repoCreated: true },
    );
    console.log(
      `[project-registry] project ${metadata.slug} repository created: ${repositoryMetadata.owner}/${repositoryMetadata.repo}; tracker repository written to projects.json: ${repositoryMetadata.owner}/${repositoryMetadata.repo}.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown managed repository provisioning error.";
    await persistRecord({ status: "failed" }, { lastError: message }).catch(() => undefined);
    return {
      ok: false,
      metadata,
      record,
      failureStep: "repository",
      workspaceAction,
      deployment,
      message,
    };
  }

  if (options.boardsClient) {
    try {
      const boardResult = await ensureProjectBoardRegistration({
        workDir: options.workDir,
        defaultProject,
        project: record,
        boardsClient: options.boardsClient,
      });
      record = boardResult.project;
      if (!boardResult.ok) {
        return {
          ok: false,
          metadata,
          record,
          failureStep: "workflow",
          workspaceAction,
          deployment,
          message: boardResult.message,
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown GitHub Projects provisioning error.";
      await persistRecord(
        {
          workflow: {
            ...record.workflow,
            boardProvisioned: false,
            lastError: message,
            lastSyncedAt: new Date().toISOString(),
          },
          status: "failed",
        },
        { lastError: message },
      ).catch(() => undefined);
      return {
        ok: false,
        metadata,
        record,
        failureStep: "workflow",
        workspaceAction,
        deployment,
        message,
      };
    }
  }

  try {
    const preparedWorkspace = await ensureManagedProjectWorkspaceDirectory(metadata.workspacePath);
    workspaceAction = preparedWorkspace.workspaceAction;
    await persistRecord(
      {
        cwd: preparedWorkspace.workspacePath,
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
      workspaceAction,
      deployment,
      message,
    };
  }

  try {
    if (repositoryMetadata === null) {
      throw new Error(`Repository metadata for ${metadata.owner}/${metadata.repositoryName} was unavailable for deployment evaluation.`);
    }

    deployment = await deployRepository({
      repository: repositoryMetadata,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Vercel deployment evaluation error.";
    await persistRecord({ status: "failed" }, { lastError: message }).catch(() => undefined);
    return {
      ok: false,
      metadata,
      record,
      failureStep: "deployment",
      workspaceAction,
      deployment,
      message,
    };
  }

  for (const logLine of deployment.logs) {
    console.log(logLine);
  }

  if (deployment.status === "failed") {
    await persistRecord({ status: "failed" }, { lastError: deployment.reason }).catch(() => undefined);
    return {
      ok: false,
      metadata,
      record,
      failureStep: "deployment",
      workspaceAction,
      deployment,
      message: deployment.reason,
    };
  }

  try {
    await setActiveProjectState({
      workDir: options.workDir,
      slug: metadata.slug,
      requestedBy: metadata.requestedBy,
      source: "project-provisioning",
    });
    await activateProjectInState({
      workDir: options.workDir,
      slug: metadata.slug,
      requestedBy: metadata.requestedBy,
      source: "project-provisioning",
    });
    console.log(
      `[project-workspace] resolved ${record.cwd}; ${workspaceAction === "created" ? "created directory" : "reused existing directory"}; ${record.cwd} is now the active working directory for project ${metadata.slug}.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown active project state update error.";
    await persistRecord({ status: "failed" }, { lastError: message }).catch(() => undefined);
    return {
      ok: false,
      metadata,
      record,
      failureStep: "active-project",
      workspaceAction,
      deployment,
      message,
    };
  }

  return {
    ok: true,
    metadata,
    record,
    failureStep: null,
    workspaceAction,
    deployment,
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
    : `- Local workspace: pending (\`${result.metadata.workspacePath}\`)`;

  const lines = [
    "## Project Provisioning",
    `- Outcome: ${result.ok ? "succeeded" : "failed"}.`,
    `- Project: \`${result.metadata.displayName}\` (\`${result.metadata.slug}\`)`,
    `- Tracker label ensured: ${formatStepStatus(result.record.provisioning.labelCreated)} (\`${result.metadata.issueLabel}\`)`,
    repositoryLine,
    branchLine,
    workspaceLine,
    ...(result.workspaceAction === null
      ? []
      : [`- Workspace directory: ${result.workspaceAction === "created" ? "created" : "reused existing directory"}.`]),
    ...(result.ok ? [`- Active working directory: \`${result.record.cwd}\`.`] : []),
    `- Registry status: \`${result.record.status}\``,
  ];

  if (result.deployment) {
    if (result.deployment.status === "skipped") {
      lines.push(`- Deployment: skipped for \`${result.deployment.repository}\`.`);
      lines.push(`- Deployment reason: ${result.deployment.reason}`);
    } else if (result.deployment.status === "failed") {
      lines.push(`- Deployment: failed for \`${result.deployment.repository}\`.`);
      lines.push(`- Deployment reason: ${result.deployment.reason}`);
      if (result.deployment.project) {
        lines.push(`- Vercel project: ${result.deployment.project.action} \`${result.deployment.project.name}\`.`);
      }
      if (result.deployment.deployment?.url) {
        lines.push(`- Deployment URL: ${result.deployment.deployment.url}`);
      }
    } else {
      lines.push(`- Deployment: succeeded for \`${result.deployment.repository}\`.`);
      lines.push(`- Vercel project: ${result.deployment.project.action} \`${result.deployment.project.name}\`.`);
      lines.push(`- Deployment URL: ${result.deployment.deployment.url ?? `deployment ${result.deployment.deployment.id}`}`);
    }
  }

  if (!result.ok) {
    lines.push(`- Failure step: \`${result.failureStep ?? "unknown"}\``);
    lines.push(`- Error: ${result.message}`);
    lines.push("- Recovery: inspect `.evolvo/projects.json`, fix the failing step, then resend `startProject <project-name>` to requeue provisioning.");
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
    ...(result.deployment?.status === "deployed"
      ? [`Deployment: ${result.deployment.deployment.url ?? `deployment ${result.deployment.deployment.id}`}.`]
      : []),
  ].join(" ");
}

export function isProjectProvisioningRequestIssue(issue: IssueSummary): boolean {
  return isProjectProvisioningIssue(issue);
}
