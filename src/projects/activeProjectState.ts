import { join } from "node:path";
import {
  readRecoverableJsonState,
  writeAtomicJsonState,
  type RecoverableJsonStateNormalizationResult,
} from "../runtime/localStateFile.js";

const ACTIVE_PROJECT_STATE_FILE_NAME = "active-project.json";
const ACTIVE_PROJECT_STATE_VERSION = 1;

export type ActiveProjectStateSource = "start-project-command" | "project-provisioning";

export type ActiveProjectState = {
  version: typeof ACTIVE_PROJECT_STATE_VERSION;
  activeProjectSlug: string | null;
  updatedAt: string | null;
  requestedBy: string | null;
  source: ActiveProjectStateSource | null;
};

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeSource(value: unknown): ActiveProjectStateSource | null {
  if (value === "start-project-command" || value === "project-provisioning") {
    return value;
  }

  return null;
}

function createDefaultActiveProjectState(): ActiveProjectState {
  return {
    version: ACTIVE_PROJECT_STATE_VERSION,
    activeProjectSlug: null,
    updatedAt: null,
    requestedBy: null,
    source: null,
  };
}

function normalizeActiveProjectState(raw: unknown): RecoverableJsonStateNormalizationResult<ActiveProjectState> {
  if (typeof raw !== "object" || raw === null) {
    return {
      state: createDefaultActiveProjectState(),
      recoveredInvalid: true,
    };
  }

  const candidate = raw as Partial<ActiveProjectState>;
  const activeProjectSlug = normalizeNonEmptyString(candidate.activeProjectSlug);
  const updatedAt = normalizeNonEmptyString(candidate.updatedAt);
  const requestedBy = normalizeNonEmptyString(candidate.requestedBy);
  const source = normalizeSource(candidate.source);
  const version = candidate.version === ACTIVE_PROJECT_STATE_VERSION ? ACTIVE_PROJECT_STATE_VERSION : null;

  if (
    version === null ||
    ("activeProjectSlug" in candidate && candidate.activeProjectSlug !== null && activeProjectSlug === null) ||
    ("updatedAt" in candidate && candidate.updatedAt !== null && updatedAt === null) ||
    ("requestedBy" in candidate && candidate.requestedBy !== null && requestedBy === null) ||
    ("source" in candidate && candidate.source !== null && source === null)
  ) {
    return {
      state: createDefaultActiveProjectState(),
      recoveredInvalid: true,
    };
  }

  return {
    state: {
      version: ACTIVE_PROJECT_STATE_VERSION,
      activeProjectSlug,
      updatedAt,
      requestedBy,
      source,
    },
    recoveredInvalid: false,
  };
}

export function getActiveProjectStatePath(workDir: string): string {
  return join(workDir, ".evolvo", ACTIVE_PROJECT_STATE_FILE_NAME);
}

export async function readActiveProjectState(workDir: string): Promise<ActiveProjectState> {
  return readRecoverableJsonState({
    statePath: getActiveProjectStatePath(workDir),
    createDefaultState: createDefaultActiveProjectState,
    normalizeState: normalizeActiveProjectState,
    warningLabel: "active project state",
  });
}

export async function setActiveProjectState(options: {
  workDir: string;
  slug: string;
  requestedBy: string;
  source: ActiveProjectStateSource;
  updatedAt?: string;
}): Promise<ActiveProjectState> {
  const state: ActiveProjectState = {
    version: ACTIVE_PROJECT_STATE_VERSION,
    activeProjectSlug: options.slug.trim(),
    updatedAt: options.updatedAt?.trim() || new Date().toISOString(),
    requestedBy: options.requestedBy.trim(),
    source: options.source,
  };
  await writeAtomicJsonState(getActiveProjectStatePath(options.workDir), state);
  return state;
}
