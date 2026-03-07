import { promises as fs } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { buildProjectIssueLabel, DEFAULT_PROJECT_SLUG } from "./projectNaming.js";

const EVOLVO_DIRECTORY_NAME = ".evolvo";
const PROJECT_REGISTRY_FILE_NAME = "projects.json";
const PROJECT_REGISTRY_VERSION = 1;

export type ProjectStatus = "active" | "provisioning" | "failed";

export type ProjectRecord = {
  slug: string;
  displayName: string;
  kind: "default" | "managed";
  issueLabel: string;
  trackerRepo: {
    owner: string;
    repo: string;
    url: string;
  };
  executionRepo: {
    owner: string;
    repo: string;
    url: string;
    defaultBranch: string | null;
  };
  cwd: string;
  status: ProjectStatus;
  sourceIssueNumber: number | null;
  createdAt: string;
  updatedAt: string;
  provisioning: {
    labelCreated: boolean;
    repoCreated: boolean;
    workspacePrepared: boolean;
    lastError: string | null;
  };
};

export type ProjectRegistry = {
  version: typeof PROJECT_REGISTRY_VERSION;
  projects: ProjectRecord[];
};

export type DefaultProjectContext = {
  owner: string;
  repo: string;
  workDir: string;
  defaultBranch?: string | null;
};

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeBoolean(value: unknown): boolean {
  return value === true;
}

function normalizeNullableString(value: unknown): string | null {
  return normalizeNonEmptyString(value);
}

function buildRepositoryUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}`;
}

function buildProjectRegistry(defaultProject: DefaultProjectContext, projects: ProjectRecord[]): ProjectRegistry {
  return {
    version: PROJECT_REGISTRY_VERSION,
    projects: ensureDefaultProject(projects, defaultProject),
  };
}

function buildCorruptProjectRegistryPath(registryPath: string, atMs = Date.now()): string {
  const extension = extname(registryPath);
  const fileName = basename(registryPath, extension);
  return join(
    dirname(registryPath),
    `${fileName}.corrupt-${Math.max(0, Math.floor(atMs))}${extension}`,
  );
}

function buildProjectRegistryTempPath(registryPath: string, atMs = Date.now()): string {
  const extension = extname(registryPath);
  const fileName = basename(registryPath, extension);
  return join(
    dirname(registryPath),
    `${fileName}.tmp-${Math.max(0, Math.floor(atMs))}-${process.pid}${extension}`,
  );
}

export function getProjectRegistryPath(workDir: string): string {
  return join(workDir, EVOLVO_DIRECTORY_NAME, PROJECT_REGISTRY_FILE_NAME);
}

export function buildDefaultProjectContext(context: DefaultProjectContext): DefaultProjectContext {
  return {
    owner: context.owner,
    repo: context.repo,
    workDir: context.workDir,
    defaultBranch: context.defaultBranch?.trim() || null,
  };
}

export function buildDefaultProjectRecord(context: DefaultProjectContext): ProjectRecord {
  const normalizedContext = buildDefaultProjectContext(context);
  const createdAt = new Date().toISOString();
  return {
    slug: DEFAULT_PROJECT_SLUG,
    displayName: "Evolvo",
    kind: "default",
    issueLabel: buildProjectIssueLabel(DEFAULT_PROJECT_SLUG),
    trackerRepo: {
      owner: normalizedContext.owner,
      repo: normalizedContext.repo,
      url: buildRepositoryUrl(normalizedContext.owner, normalizedContext.repo),
    },
    executionRepo: {
      owner: normalizedContext.owner,
      repo: normalizedContext.repo,
      url: buildRepositoryUrl(normalizedContext.owner, normalizedContext.repo),
      defaultBranch: normalizedContext.defaultBranch ?? null,
    },
    cwd: normalizedContext.workDir,
    status: "active",
    sourceIssueNumber: null,
    createdAt,
    updatedAt: createdAt,
    provisioning: {
      labelCreated: false,
      repoCreated: true,
      workspacePrepared: true,
      lastError: null,
    },
  };
}

function normalizeProjectRecord(raw: unknown): ProjectRecord | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  const candidate = raw as Partial<ProjectRecord>;
  const slug = normalizeNonEmptyString(candidate.slug);
  const displayName = normalizeNonEmptyString(candidate.displayName);
  const kind = candidate.kind === "default" ? "default" : candidate.kind === "managed" ? "managed" : null;
  const issueLabel = normalizeNonEmptyString(candidate.issueLabel);
  const cwd = normalizeNonEmptyString(candidate.cwd);
  const status = candidate.status === "active" || candidate.status === "provisioning" || candidate.status === "failed"
    ? candidate.status
    : null;
  const createdAt = normalizeNonEmptyString(candidate.createdAt);
  const updatedAt = normalizeNonEmptyString(candidate.updatedAt);
  const sourceIssueNumber = typeof candidate.sourceIssueNumber === "number" && Number.isInteger(candidate.sourceIssueNumber)
    ? candidate.sourceIssueNumber
    : null;
  const trackerOwner = normalizeNonEmptyString(candidate.trackerRepo?.owner);
  const trackerRepo = normalizeNonEmptyString(candidate.trackerRepo?.repo);
  const trackerUrl = normalizeNonEmptyString(candidate.trackerRepo?.url);
  const executionOwner = normalizeNonEmptyString(candidate.executionRepo?.owner);
  const executionRepo = normalizeNonEmptyString(candidate.executionRepo?.repo);
  const executionUrl = normalizeNonEmptyString(candidate.executionRepo?.url);
  if (
    !slug ||
    !displayName ||
    !kind ||
    !issueLabel ||
    !cwd ||
    !status ||
    !createdAt ||
    !updatedAt ||
    !trackerOwner ||
    !trackerRepo ||
    !trackerUrl ||
    !executionOwner ||
    !executionRepo ||
    !executionUrl
  ) {
    return null;
  }

  return {
    slug,
    displayName,
    kind,
    issueLabel,
    trackerRepo: {
      owner: trackerOwner,
      repo: trackerRepo,
      url: trackerUrl,
    },
    executionRepo: {
      owner: executionOwner,
      repo: executionRepo,
      url: executionUrl,
      defaultBranch: normalizeNullableString(candidate.executionRepo?.defaultBranch),
    },
    cwd,
    status,
    sourceIssueNumber,
    createdAt,
    updatedAt,
    provisioning: {
      labelCreated: normalizeBoolean(candidate.provisioning?.labelCreated),
      repoCreated: normalizeBoolean(candidate.provisioning?.repoCreated),
      workspacePrepared: normalizeBoolean(candidate.provisioning?.workspacePrepared),
      lastError: normalizeNullableString(candidate.provisioning?.lastError),
    },
  };
}

function ensureDefaultProject(
  projects: ProjectRecord[],
  context: DefaultProjectContext,
): ProjectRecord[] {
  const defaultRecord = buildDefaultProjectRecord(context);
  const withoutDefault = projects.filter((project) => project.slug !== DEFAULT_PROJECT_SLUG);
  const existingDefault = projects.find((project) => project.slug === DEFAULT_PROJECT_SLUG);
  if (!existingDefault) {
    return [defaultRecord, ...withoutDefault];
  }

  return [
    {
      ...existingDefault,
      ...defaultRecord,
      createdAt: existingDefault.createdAt,
      updatedAt: existingDefault.updatedAt,
      provisioning: existingDefault.provisioning,
    },
    ...withoutDefault,
  ];
}

type ParsedProjectRegistryResult =
  | {
    ok: true;
    registry: ProjectRegistry;
  }
  | {
    ok: false;
    recoveryRegistry: ProjectRegistry;
  };

function parseProjectRegistry(
  raw: string,
  defaultProject: DefaultProjectContext,
): ParsedProjectRegistryResult {
  const parsed = JSON.parse(raw) as unknown;
  const rawProjects = (parsed as { projects?: unknown }).projects;
  if (!Array.isArray(rawProjects)) {
    return {
      ok: false,
      recoveryRegistry: buildProjectRegistry(defaultProject, []),
    };
  }

  const normalizedProjects = rawProjects.map(normalizeProjectRecord);
  const validProjects = normalizedProjects.filter((project) => project !== null) as ProjectRecord[];
  if (validProjects.length !== rawProjects.length) {
    return {
      ok: false,
      recoveryRegistry: buildProjectRegistry(defaultProject, validProjects),
    };
  }

  return {
    ok: true,
    registry: buildProjectRegistry(defaultProject, validProjects),
  };
}

async function recoverMalformedProjectRegistry(
  registryPath: string,
  recoveryRegistry: ProjectRegistry,
): Promise<ProjectRegistry> {
  const corruptPath = buildCorruptProjectRegistryPath(registryPath);
  await fs.rename(registryPath, corruptPath);
  await writeProjectRegistryFile(registryPath, recoveryRegistry);
  console.warn(
    `Recovered malformed project registry at ${registryPath}; preserved corrupt file at ${corruptPath}.`,
  );
  return recoveryRegistry;
}

export async function readProjectRegistry(
  workDir: string,
  defaultProject: DefaultProjectContext,
): Promise<ProjectRegistry> {
  const registryPath = getProjectRegistryPath(workDir);
  try {
    const raw = await fs.readFile(registryPath, "utf8");
    const parsed = parseProjectRegistry(raw, defaultProject);
    if (!parsed.ok) {
      return recoverMalformedProjectRegistry(registryPath, parsed.recoveryRegistry);
    }

    return parsed.registry;
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === "ENOENT") {
      return buildProjectRegistry(defaultProject, []);
    }

    if (error instanceof SyntaxError) {
      return recoverMalformedProjectRegistry(registryPath, buildProjectRegistry(defaultProject, []));
    }

    throw error;
  }
}

async function writeProjectRegistryFile(path: string, registry: ProjectRegistry): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tempPath = buildProjectRegistryTempPath(path);
  try {
    await fs.writeFile(
      tempPath,
      `${JSON.stringify({ version: PROJECT_REGISTRY_VERSION, projects: registry.projects }, null, 2)}\n`,
      "utf8",
    );
    await fs.rename(tempPath, path);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeProjectRegistry(workDir: string, registry: ProjectRegistry): Promise<void> {
  await writeProjectRegistryFile(getProjectRegistryPath(workDir), registry);
}

export async function ensureProjectRegistry(
  workDir: string,
  defaultProject: DefaultProjectContext,
): Promise<ProjectRegistry> {
  const registry = await readProjectRegistry(workDir, defaultProject);
  await writeProjectRegistry(workDir, registry);
  return registry;
}

export async function upsertProjectRecord(
  workDir: string,
  defaultProject: DefaultProjectContext,
  nextRecord: ProjectRecord,
): Promise<ProjectRegistry> {
  const registry = await readProjectRegistry(workDir, defaultProject);
  const nextProjects = registry.projects.filter((project) => project.slug !== nextRecord.slug);
  nextProjects.push(nextRecord);
  const normalizedProjects = ensureDefaultProject(nextProjects, defaultProject).sort((left, right) => {
    if (left.slug === DEFAULT_PROJECT_SLUG) {
      return -1;
    }

    if (right.slug === DEFAULT_PROJECT_SLUG) {
      return 1;
    }

    return left.slug.localeCompare(right.slug);
  });

  const nextRegistry: ProjectRegistry = {
    version: PROJECT_REGISTRY_VERSION,
    projects: normalizedProjects,
  };
  await writeProjectRegistry(workDir, nextRegistry);
  return nextRegistry;
}

export function findProjectBySlug(registry: ProjectRegistry, slug: string): ProjectRecord | null {
  return registry.projects.find((project) => project.slug === slug) ?? null;
}
