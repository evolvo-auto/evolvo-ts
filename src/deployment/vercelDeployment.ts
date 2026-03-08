import type { GitHubAdminRepository } from "../github/githubAdminClient.js";

const DEPLOYABLE_REPOSITORY_MARKER = "<deployable>";
const DEFAULT_DEPLOY_TIMEOUT_MS = 300_000;
const DEFAULT_DEPLOY_POLL_INTERVAL_MS = 2_000;
const VERCEL_API_BASE_URL = "https://api.vercel.com";

type VercelProjectLink = {
  org: string;
  repo: string;
  repoId: number | null;
  productionBranch: string | null;
};

export type VercelProject = {
  id: string;
  name: string;
  link: VercelProjectLink | null;
};

export type VercelDeployment = {
  id: string;
  readyState: string;
  url: string | null;
};

export type VercelConfig = {
  token: string;
  teamId: string | null;
  defaultFramework: string | null;
  deployTimeoutMs: number;
  deployPollIntervalMs: number;
};

export type VercelConfigurationState =
  | {
    available: true;
    config: VercelConfig;
    missing: [];
  }
  | {
    available: false;
    config: null;
    missing: string[];
  };

export type ProjectRepositoryDeploymentResult =
  | {
    status: "skipped";
    repository: string;
    deployableMarkerPresent: false;
    vercelConfigured: boolean;
    reason: string;
    logs: string[];
  }
  | {
    status: "failed";
    repository: string;
    deployableMarkerPresent: true;
    vercelConfigured: boolean;
    reason: string;
    logs: string[];
    project: {
      id: string;
      name: string;
      action: "created" | "reused";
    } | null;
    deployment: {
      id: string;
      url: string | null;
      readyState: string;
    } | null;
  }
  | {
    status: "deployed";
    repository: string;
    deployableMarkerPresent: true;
    vercelConfigured: true;
    logs: string[];
    project: {
      id: string;
      name: string;
      action: "created" | "reused";
    };
    deployment: {
      id: string;
      url: string | null;
      readyState: string;
    };
  };

export class VercelApiError extends Error {
  public readonly status: number;
  public readonly responseBody: unknown;

  public constructor(message: string, status: number, responseBody: unknown) {
    super(message);
    this.name = "VercelApiError";
    this.status = status;
    this.responseBody = responseBody;
  }
}

export type VercelDeploymentClient = {
  findProjectsByRepoUrl: (repoUrl: string) => Promise<VercelProject[]>;
  getProject: (idOrName: string) => Promise<VercelProject>;
  createProject: (options: {
    name: string;
    framework: string | null;
    gitRepository: {
      type: "github";
      org: string;
      repo: string;
      repoId: number;
      productionBranch: string;
    };
  }) => Promise<VercelProject>;
  createDeployment: (options: {
    projectName: string;
    repoId: number;
    ref: string;
    framework: string | null;
  }) => Promise<VercelDeployment>;
  getDeployment: (deploymentId: string) => Promise<VercelDeployment>;
};

type VercelProjectResponse = {
  id?: unknown;
  name?: unknown;
  link?: {
    org?: unknown;
    repo?: unknown;
    repoId?: unknown;
    productionBranch?: unknown;
  } | null;
};

type VercelDeploymentResponse = {
  id?: unknown;
  readyState?: unknown;
  url?: unknown;
};

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeNullableString(value: unknown): string | null {
  return normalizeNonEmptyString(value);
}

function normalizeInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return null;
  }

  return value;
}

function normalizePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  const rawValue = value?.trim();
  if (!rawValue) {
    return fallback;
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer when set.`);
  }

  return parsed;
}

function formatRepositoryReference(repository: Pick<GitHubAdminRepository, "owner" | "repo">): string {
  return `${repository.owner}/${repository.repo}`;
}

function normalizeDeploymentUrl(value: string | null): string | null {
  if (!value) {
    return null;
  }

  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function formatVercelErrorMessage(responseBody: unknown, status: number): string {
  if (typeof responseBody === "object" && responseBody !== null) {
    const error = responseBody as { error?: { message?: unknown }; message?: unknown };
    const nestedMessage = normalizeNonEmptyString(error.error?.message);
    if (nestedMessage) {
      return nestedMessage;
    }

    const topLevelMessage = normalizeNonEmptyString(error.message);
    if (topLevelMessage) {
      return topLevelMessage;
    }
  }

  return `Vercel API request failed with status ${status}.`;
}

function parseProject(response: unknown): VercelProject {
  if (typeof response !== "object" || response === null) {
    throw new Error("Vercel project response was not an object.");
  }

  const candidate = response as VercelProjectResponse;
  const id = normalizeNonEmptyString(candidate.id);
  const name = normalizeNonEmptyString(candidate.name);
  if (!id || !name) {
    throw new Error("Vercel project response was missing id or name.");
  }

  const repoId = candidate.link?.repoId === null ? null : normalizeInteger(candidate.link?.repoId);

  return {
    id,
    name,
    link: candidate.link
      ? {
        org: normalizeNonEmptyString(candidate.link.org) ?? "",
        repo: normalizeNonEmptyString(candidate.link.repo) ?? "",
        repoId,
        productionBranch: normalizeNullableString(candidate.link.productionBranch),
      }
      : null,
  };
}

function parseProjectsList(response: unknown): VercelProject[] {
  if (Array.isArray(response)) {
    return response.map(parseProject);
  }

  if (typeof response === "object" && response !== null && Array.isArray((response as { projects?: unknown[] }).projects)) {
    return (response as { projects: unknown[] }).projects.map(parseProject);
  }

  throw new Error("Vercel projects list response was not an array.");
}

function parseDeployment(response: unknown): VercelDeployment {
  if (typeof response !== "object" || response === null) {
    throw new Error("Vercel deployment response was not an object.");
  }

  const candidate = response as VercelDeploymentResponse;
  const id = normalizeNonEmptyString(candidate.id);
  const readyState = normalizeNonEmptyString(candidate.readyState);
  if (!id || !readyState) {
    throw new Error("Vercel deployment response was missing id or readyState.");
  }

  return {
    id,
    readyState,
    url: normalizeNullableString(candidate.url),
  };
}

function isDeploymentSettled(readyState: string): boolean {
  const normalized = readyState.trim().toUpperCase();
  return normalized === "READY" || normalized === "ERROR" || normalized === "CANCELED";
}

function projectLinksRepository(project: VercelProject, repository: GitHubAdminRepository): boolean {
  if (!project.link) {
    return false;
  }

  if (project.link.repoId !== null && repository.id !== null) {
    return project.link.repoId === repository.id;
  }

  return project.link.org === repository.owner && project.link.repo === repository.repo;
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

export function hasDeployableRepositoryMarker(description: string | null): boolean {
  return description?.includes(DEPLOYABLE_REPOSITORY_MARKER) ?? false;
}

export function readVercelConfiguration(env: NodeJS.ProcessEnv = process.env): VercelConfigurationState {
  const token = normalizeNonEmptyString(env.VERCEL_TOKEN);
  if (!token) {
    return {
      available: false,
      config: null,
      missing: ["VERCEL_TOKEN"],
    };
  }

  return {
    available: true,
    config: {
      token,
      teamId: normalizeNullableString(env.VERCEL_TEAM_ID),
      defaultFramework: normalizeNullableString(env.VERCEL_DEFAULT_FRAMEWORK),
      deployTimeoutMs: normalizePositiveInteger(
        env.VERCEL_DEPLOY_TIMEOUT_MS,
        DEFAULT_DEPLOY_TIMEOUT_MS,
        "VERCEL_DEPLOY_TIMEOUT_MS",
      ),
      deployPollIntervalMs: normalizePositiveInteger(
        env.VERCEL_DEPLOY_POLL_INTERVAL_MS,
        DEFAULT_DEPLOY_POLL_INTERVAL_MS,
        "VERCEL_DEPLOY_POLL_INTERVAL_MS",
      ),
    },
    missing: [],
  };
}

export class VercelClient implements VercelDeploymentClient {
  public constructor(private readonly config: VercelConfig) {}

  public async findProjectsByRepoUrl(repoUrl: string): Promise<VercelProject[]> {
    const query = new URLSearchParams({
      repoUrl,
    });
    const response = await this.request(`/v10/projects?${this.withScopeQuery(query).toString()}`, { method: "GET" });
    return parseProjectsList(response);
  }

  public async getProject(idOrName: string): Promise<VercelProject> {
    const path = `/v9/projects/${encodeURIComponent(idOrName)}${this.buildScopeSuffix()}`;
    const response = await this.request(path, { method: "GET" });
    return parseProject(response);
  }

  public async createProject(options: {
    name: string;
    framework: string | null;
    gitRepository: {
      type: "github";
      org: string;
      repo: string;
      repoId: number;
      productionBranch: string;
    };
  }): Promise<VercelProject> {
    const response = await this.request(`/v11/projects${this.buildScopeSuffix()}`, {
      method: "POST",
      body: {
        name: options.name,
        framework: options.framework,
        gitRepository: {
          type: options.gitRepository.type,
          org: options.gitRepository.org,
          repo: options.gitRepository.repo,
          repoId: options.gitRepository.repoId,
          productionBranch: options.gitRepository.productionBranch,
        },
      },
    });
    return parseProject(response);
  }

  public async createDeployment(options: {
    projectName: string;
    repoId: number;
    ref: string;
    framework: string | null;
  }): Promise<VercelDeployment> {
    const response = await this.request(`/v13/deployments${this.buildScopeSuffix()}`, {
      method: "POST",
      body: {
        project: options.projectName,
        target: "production",
        gitSource: {
          type: "github",
          repoId: options.repoId,
          ref: options.ref,
        },
        projectSettings: {
          framework: options.framework,
        },
      },
    });
    return parseDeployment(response);
  }

  public async getDeployment(deploymentId: string): Promise<VercelDeployment> {
    const path = `/v13/deployments/${encodeURIComponent(deploymentId)}${this.buildScopeSuffix()}`;
    const response = await this.request(path, { method: "GET" });
    return parseDeployment(response);
  }

  private buildScopeSuffix(): string {
    if (!this.config.teamId) {
      return "";
    }

    return `?teamId=${encodeURIComponent(this.config.teamId)}`;
  }

  private withScopeQuery(query: URLSearchParams): URLSearchParams {
    if (this.config.teamId) {
      query.set("teamId", this.config.teamId);
    }

    return query;
  }

  private async request(path: string, options: { method: "GET" | "POST"; body?: unknown }): Promise<unknown> {
    const response = await fetch(`${VERCEL_API_BASE_URL}${path}`, {
      method: options.method,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        "Content-Type": "application/json",
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const responseBody = await response.json().catch(() => null);
    if (!response.ok) {
      throw new VercelApiError(formatVercelErrorMessage(responseBody, response.status), response.status, responseBody);
    }

    return responseBody;
  }
}

async function ensureProjectForRepository(options: {
  client: VercelDeploymentClient;
  repository: GitHubAdminRepository;
  config: VercelConfig;
  logs: string[];
}): Promise<{
  project: VercelProject;
  action: "created" | "reused";
}> {
  const repoReference = formatRepositoryReference(options.repository);
  const linkedProjects = await options.client.findProjectsByRepoUrl(options.repository.url);
  const linkedProject = linkedProjects.find((project) => projectLinksRepository(project, options.repository)) ?? null;
  if (linkedProject) {
    options.logs.push(
      `[deploy] reusing Vercel project ${linkedProject.name} for ${repoReference} via repoUrl lookup.`,
    );
    return {
      project: linkedProject,
      action: "reused",
    };
  }

  try {
    const existingProject = await options.client.getProject(options.repository.repo);
    if (existingProject.link && !projectLinksRepository(existingProject, options.repository)) {
      throw new Error(
        `Vercel project ${existingProject.name} exists but is linked to ${existingProject.link.org}/${existingProject.link.repo} instead of ${repoReference}.`,
      );
    }

    if (!existingProject.link) {
      throw new Error(
        `Vercel project ${existingProject.name} exists but is not linked to ${repoReference}, so Evolvo cannot safely reuse it in v1.`,
      );
    }

    options.logs.push(`[deploy] reusing Vercel project ${existingProject.name} for ${repoReference}.`);
    return {
      project: existingProject,
      action: "reused",
    };
  } catch (error) {
    if (!(error instanceof VercelApiError) || error.status !== 404) {
      throw error;
    }
  }

  const createdProject = await options.client.createProject({
    name: options.repository.repo,
    framework: options.config.defaultFramework,
    gitRepository: {
      type: "github",
      org: options.repository.owner,
      repo: options.repository.repo,
      repoId: options.repository.id as number,
      productionBranch: options.repository.defaultBranch as string,
    },
  });
  options.logs.push(`[deploy] created Vercel project ${createdProject.name} for ${repoReference}.`);
  return {
    project: createdProject,
    action: "created",
  };
}

export async function deployProjectRepositoryWithVercel(options: {
  repository: GitHubAdminRepository;
  env?: NodeJS.ProcessEnv;
  client?: VercelDeploymentClient;
}): Promise<ProjectRepositoryDeploymentResult> {
  const repository = options.repository;
  const repositoryReference = formatRepositoryReference(repository);
  const logs = [`[deploy] evaluating repository ${repositoryReference} for Vercel deployment.`];
  const markerPresent = hasDeployableRepositoryMarker(repository.description);
  const configurationState = readVercelConfiguration(options.env);
  logs.push(`[deploy] deployable marker present for ${repositoryReference}: ${markerPresent ? "yes" : "no"}.`);
  logs.push(`[deploy] Vercel configuration available for ${repositoryReference}: ${configurationState.available ? "yes" : "no"}.`);
  if (!markerPresent) {
    logs.push(
      `[deploy] deployment skipped for ${repositoryReference}: repository description is not marked with ${DEPLOYABLE_REPOSITORY_MARKER}.`,
    );
    return {
      status: "skipped",
      repository: repositoryReference,
      deployableMarkerPresent: false,
      vercelConfigured: configurationState.available,
      reason: `Repository description does not include ${DEPLOYABLE_REPOSITORY_MARKER}.`,
      logs,
    };
  }

  if (!configurationState.available) {
    const reason = `Repository is marked ${DEPLOYABLE_REPOSITORY_MARKER} but Vercel configuration is missing: ${configurationState.missing.join(", ")}.`;
    logs.push(`[deploy] deployment failed for ${repositoryReference}: ${reason}`);
    return {
      status: "failed",
      repository: repositoryReference,
      deployableMarkerPresent: true,
      vercelConfigured: false,
      reason,
      logs,
      project: null,
      deployment: null,
    };
  }

  if (!repository.defaultBranch) {
    const reason = `Repository ${repositoryReference} does not expose a default branch, so it is not suitable for the Vercel deployment flow.`;
    logs.push(`[deploy] deployment failed for ${repositoryReference}: ${reason}`);
    return {
      status: "failed",
      repository: repositoryReference,
      deployableMarkerPresent: true,
      vercelConfigured: true,
      reason,
      logs,
      project: null,
      deployment: null,
    };
  }

  if (repository.id === null) {
    const reason = `GitHub repository metadata for ${repositoryReference} did not include a repository id required for Vercel git deployments.`;
    logs.push(`[deploy] deployment failed for ${repositoryReference}: ${reason}`);
    return {
      status: "failed",
      repository: repositoryReference,
      deployableMarkerPresent: true,
      vercelConfigured: true,
      reason,
      logs,
      project: null,
      deployment: null,
    };
  }

  const client = options.client ?? new VercelClient(configurationState.config);
  let project:
    | {
      id: string;
      name: string;
      action: "created" | "reused";
    }
    | null = null;
  let deployment:
    | {
      id: string;
      url: string | null;
      readyState: string;
    }
    | null = null;

  try {
    const ensuredProject = await ensureProjectForRepository({
      client,
      repository,
      config: configurationState.config,
      logs,
    });
    project = {
      id: ensuredProject.project.id,
      name: ensuredProject.project.name,
      action: ensuredProject.action,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown Vercel project provisioning error.";
    logs.push(`[deploy] deployment failed for ${repositoryReference}: ${reason}`);
    return {
      status: "failed",
      repository: repositoryReference,
      deployableMarkerPresent: true,
      vercelConfigured: true,
      reason,
      logs,
      project,
      deployment,
    };
  }

  try {
    const createdDeployment = await client.createDeployment({
      projectName: project.name,
      repoId: repository.id,
      ref: repository.defaultBranch,
      framework: configurationState.config.defaultFramework,
    });
    deployment = {
      id: createdDeployment.id,
      url: normalizeDeploymentUrl(createdDeployment.url),
      readyState: createdDeployment.readyState,
    };
    logs.push(`[deploy] started Vercel deployment ${deployment.id} for ${repositoryReference}.`);

    const deadlineMs = Date.now() + configurationState.config.deployTimeoutMs;
    while (!isDeploymentSettled(deployment.readyState)) {
      if (Date.now() >= deadlineMs) {
        const reason =
          `Timed out waiting for Vercel deployment ${deployment.id} after ${configurationState.config.deployTimeoutMs}ms.`;
        logs.push(`[deploy] deployment failed for ${repositoryReference}: ${reason}`);
        return {
          status: "failed",
          repository: repositoryReference,
          deployableMarkerPresent: true,
          vercelConfigured: true,
          reason,
          logs,
          project,
          deployment,
        };
      }

      await sleep(configurationState.config.deployPollIntervalMs);
      const observedDeployment = await client.getDeployment(deployment.id);
      deployment = {
        id: observedDeployment.id,
        url: normalizeDeploymentUrl(observedDeployment.url),
        readyState: observedDeployment.readyState,
      };
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown Vercel deployment error.";
    logs.push(`[deploy] deployment failed for ${repositoryReference}: ${reason}`);
    return {
      status: "failed",
      repository: repositoryReference,
      deployableMarkerPresent: true,
      vercelConfigured: true,
      reason,
      logs,
      project,
      deployment,
    };
  }

  if (deployment.readyState.trim().toUpperCase() !== "READY") {
    const reason =
      `Vercel deployment ${deployment.id} finished in state ${deployment.readyState}${deployment.url ? ` (${deployment.url})` : ""}.`;
    logs.push(`[deploy] deployment failed for ${repositoryReference}: ${reason}`);
    return {
      status: "failed",
      repository: repositoryReference,
      deployableMarkerPresent: true,
      vercelConfigured: true,
      reason,
      logs,
      project,
      deployment,
    };
  }

  logs.push(
    `[deploy] deployment succeeded for ${repositoryReference}: ${deployment.url ?? `deployment ${deployment.id}`}.`,
  );
  return {
    status: "deployed",
    repository: repositoryReference,
    deployableMarkerPresent: true,
    vercelConfigured: true,
    logs,
    project,
    deployment,
  };
}
