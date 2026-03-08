import { join } from "node:path";
import {
  readRecoverableJsonState,
  writeAtomicJsonState,
  type RecoverableJsonStateNormalizationResult,
} from "../localStateFile.js";
import {
  buildWorkerId,
  type WorkerClaim,
  type WorkerProcessRecord,
  type WorkflowWorkerState,
  type WorkerRole,
} from "./workerTypes.js";

const WORKFLOW_WORKER_STATE_FILE_NAME = "workflow-workers.json";
const WORKFLOW_WORKER_STATE_VERSION = 1 as const;

function createDefaultWorkflowWorkerState(): WorkflowWorkerState {
  return {
    version: WORKFLOW_WORKER_STATE_VERSION,
    workers: [],
  };
}

function normalizeNullableString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeWorkerRole(value: unknown): WorkerRole | null {
  return value === "issue-generator"
    || value === "planner"
    || value === "review"
    || value === "release"
    || value === "dev"
    ? value
    : null;
}

function normalizeWorkerClaim(value: unknown): WorkerClaim | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<WorkerClaim>;
  const issueNumber = typeof candidate.issueNumber === "number" && Number.isInteger(candidate.issueNumber)
    ? candidate.issueNumber
    : null;
  const pullRequestNumber = typeof candidate.pullRequestNumber === "number" && Number.isInteger(candidate.pullRequestNumber)
    ? candidate.pullRequestNumber
    : null;

  return {
    issueNumber,
    pullRequestNumber,
    queueKey: normalizeNullableString(candidate.queueKey),
    stage: normalizeNullableString(candidate.stage),
    claimedAt: normalizeNullableString(candidate.claimedAt),
  };
}

function normalizeWorkerRecord(value: unknown): WorkerProcessRecord | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const candidate = value as Partial<WorkerProcessRecord>;
  const workerId = normalizeNullableString(candidate.workerId);
  const role = normalizeWorkerRole(candidate.role);
  const pid = typeof candidate.pid === "number" && Number.isInteger(candidate.pid) && candidate.pid > 0
    ? candidate.pid
    : null;
  const startedAt = normalizeNullableString(candidate.startedAt);
  const heartbeatAt = normalizeNullableString(candidate.heartbeatAt);
  if (!workerId || !role || pid === null || !startedAt || !heartbeatAt) {
    return null;
  }

  return {
    workerId,
    pid,
    role,
    projectSlug: normalizeNullableString(candidate.projectSlug),
    startedAt,
    heartbeatAt,
    currentClaim: normalizeWorkerClaim(candidate.currentClaim),
    restartCount: typeof candidate.restartCount === "number" && Number.isInteger(candidate.restartCount) && candidate.restartCount >= 0
      ? candidate.restartCount
      : 0,
  };
}

function normalizeWorkflowWorkerState(raw: unknown): RecoverableJsonStateNormalizationResult<WorkflowWorkerState> {
  if (typeof raw !== "object" || raw === null) {
    return {
      state: createDefaultWorkflowWorkerState(),
      recoveredInvalid: true,
    };
  }

  const candidate = raw as Partial<WorkflowWorkerState>;
  if ((raw as { version?: unknown }).version !== WORKFLOW_WORKER_STATE_VERSION || !Array.isArray(candidate.workers)) {
    return {
      state: createDefaultWorkflowWorkerState(),
      recoveredInvalid: true,
    };
  }

  let recoveredInvalid = false;
  const workers = candidate.workers
    .map((entry) => normalizeWorkerRecord(entry))
    .filter((entry): entry is WorkerProcessRecord => {
      if (entry === null) {
        recoveredInvalid = true;
        return false;
      }

      return true;
    })
    .sort((left, right) => left.workerId.localeCompare(right.workerId));

  return {
    state: {
      version: WORKFLOW_WORKER_STATE_VERSION,
      workers,
    },
    recoveredInvalid,
  };
}

export function getWorkflowWorkerStatePath(workDir: string): string {
  return join(workDir, ".evolvo", "workers", WORKFLOW_WORKER_STATE_FILE_NAME);
}

export async function readWorkflowWorkerState(workDir: string): Promise<WorkflowWorkerState> {
  return readRecoverableJsonState({
    statePath: getWorkflowWorkerStatePath(workDir),
    createDefaultState: createDefaultWorkflowWorkerState,
    normalizeState: normalizeWorkflowWorkerState,
    warningLabel: "workflow worker state",
  });
}

async function writeWorkflowWorkerState(workDir: string, state: WorkflowWorkerState): Promise<WorkflowWorkerState> {
  await writeAtomicJsonState(getWorkflowWorkerStatePath(workDir), state);
  return state;
}

export async function upsertWorkflowWorkerRecord(
  workDir: string,
  record: Omit<WorkerProcessRecord, "workerId"> & { workerId?: string },
): Promise<WorkerProcessRecord> {
  const workerId = record.workerId?.trim() || buildWorkerId({ role: record.role, projectSlug: record.projectSlug });
  const currentState = await readWorkflowWorkerState(workDir);
  const normalizedRecord: WorkerProcessRecord = {
    ...record,
    workerId,
  };
  await writeWorkflowWorkerState(workDir, {
    version: WORKFLOW_WORKER_STATE_VERSION,
    workers: [
      ...currentState.workers.filter((worker) => worker.workerId !== workerId),
      normalizedRecord,
    ].sort((left, right) => left.workerId.localeCompare(right.workerId)),
  });
  return normalizedRecord;
}

export async function removeWorkflowWorkerRecord(workDir: string, workerId: string): Promise<WorkflowWorkerState> {
  const currentState = await readWorkflowWorkerState(workDir);
  return writeWorkflowWorkerState(workDir, {
    version: WORKFLOW_WORKER_STATE_VERSION,
    workers: currentState.workers.filter((worker) => worker.workerId !== workerId.trim()),
  });
}

export async function getWorkflowWorkerRecord(workDir: string, workerId: string): Promise<WorkerProcessRecord | null> {
  const state = await readWorkflowWorkerState(workDir);
  return state.workers.find((worker) => worker.workerId === workerId.trim()) ?? null;
}
