import { join } from "node:path";
import {
  readRecoverableJsonState,
  writeAtomicJsonState,
  type RecoverableJsonStateNormalizationResult,
} from "../runtime/localStateFile.js";
import type { ActiveProjectStateSource } from "./activeProjectState.js";

const ACTIVE_PROJECTS_STATE_FILE_NAME = "active-projects.json";
const ACTIVE_PROJECTS_STATE_VERSION = 1;

export type ActiveProjectsStateEntry = {
  slug: string;
  updatedAt: string;
  requestedBy: string;
  source: ActiveProjectStateSource;
};

export type ActiveProjectsState = {
  version: typeof ACTIVE_PROJECTS_STATE_VERSION;
  projects: ActiveProjectsStateEntry[];
};

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function requireNonEmptyInput(value: string, label: "slug" | "requestedBy"): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`Active projects state ${label} cannot be empty.`);
  }

  return normalized;
}

function normalizeSource(value: unknown): ActiveProjectStateSource | null {
  if (
    value === "start-project-command" ||
    value === "project-provisioning" ||
    value === "stop-project-command"
  ) {
    return value;
  }

  return null;
}

function createDefaultActiveProjectsState(): ActiveProjectsState {
  return {
    version: ACTIVE_PROJECTS_STATE_VERSION,
    projects: [],
  };
}

function normalizeActiveProjectsState(raw: unknown): RecoverableJsonStateNormalizationResult<ActiveProjectsState> {
  if (typeof raw !== "object" || raw === null) {
    return {
      state: createDefaultActiveProjectsState(),
      recoveredInvalid: true,
    };
  }

  const candidate = raw as Partial<ActiveProjectsState>;
  const version = (raw as { version?: unknown }).version === ACTIVE_PROJECTS_STATE_VERSION
    ? ACTIVE_PROJECTS_STATE_VERSION
    : null;
  if (version === null || !Array.isArray(candidate.projects)) {
    return {
      state: createDefaultActiveProjectsState(),
      recoveredInvalid: true,
    };
  }

  let recoveredInvalid = false;
  const entriesBySlug = new Map<string, ActiveProjectsStateEntry>();
  for (const rawEntry of candidate.projects) {
    if (typeof rawEntry !== "object" || rawEntry === null) {
      recoveredInvalid = true;
      continue;
    }

    const entry = rawEntry as Partial<ActiveProjectsStateEntry>;
    const slug = normalizeNonEmptyString(entry.slug);
    const updatedAt = normalizeNonEmptyString(entry.updatedAt);
    const requestedBy = normalizeNonEmptyString(entry.requestedBy);
    const source = normalizeSource(entry.source);
    if (!slug || !updatedAt || !requestedBy || !source) {
      recoveredInvalid = true;
      continue;
    }

    entriesBySlug.set(slug, {
      slug,
      updatedAt,
      requestedBy,
      source,
    });
  }

  return {
    state: {
      version: ACTIVE_PROJECTS_STATE_VERSION,
      projects: [...entriesBySlug.values()].sort((left, right) => left.slug.localeCompare(right.slug)),
    },
    recoveredInvalid,
  };
}

export function getActiveProjectsStatePath(workDir: string): string {
  return join(workDir, ".evolvo", ACTIVE_PROJECTS_STATE_FILE_NAME);
}

export async function readActiveProjectsState(workDir: string): Promise<ActiveProjectsState> {
  return readRecoverableJsonState({
    statePath: getActiveProjectsStatePath(workDir),
    createDefaultState: createDefaultActiveProjectsState,
    normalizeState: normalizeActiveProjectsState,
    warningLabel: "active projects state",
  });
}

async function writeActiveProjectsState(workDir: string, state: ActiveProjectsState): Promise<ActiveProjectsState> {
  await writeAtomicJsonState(getActiveProjectsStatePath(workDir), state);
  return state;
}

export async function activateProjectInState(options: {
  workDir: string;
  slug: string;
  requestedBy: string;
  source: ActiveProjectStateSource;
  updatedAt?: string;
}): Promise<ActiveProjectsState> {
  const slug = requireNonEmptyInput(options.slug, "slug");
  const requestedBy = requireNonEmptyInput(options.requestedBy, "requestedBy");
  const currentState = await readActiveProjectsState(options.workDir);
  const nextEntry: ActiveProjectsStateEntry = {
    slug,
    updatedAt: options.updatedAt?.trim() || new Date().toISOString(),
    requestedBy,
    source: options.source,
  };

  return writeActiveProjectsState(options.workDir, {
    version: ACTIVE_PROJECTS_STATE_VERSION,
    projects: [
      ...currentState.projects.filter((entry) => entry.slug !== slug),
      nextEntry,
    ].sort((left, right) => left.slug.localeCompare(right.slug)),
  });
}

export async function deactivateProjectInState(
  workDir: string,
  slug: string,
): Promise<ActiveProjectsState> {
  const normalizedSlug = requireNonEmptyInput(slug, "slug");
  const currentState = await readActiveProjectsState(workDir);
  return writeActiveProjectsState(workDir, {
    version: ACTIVE_PROJECTS_STATE_VERSION,
    projects: currentState.projects.filter((entry) => entry.slug !== normalizedSlug),
  });
}
