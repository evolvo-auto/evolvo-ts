import { buildWorkerId, type WorkerClaim, type WorkerProcessRecord, type WorkerSpec } from "./workerTypes.js";
import {
  getWorkflowWorkerRecord,
  readWorkflowWorkerState,
  removeWorkflowWorkerRecord,
  upsertWorkflowWorkerRecord,
} from "./workflowWorkerState.js";

export const DEFAULT_WORKER_HEARTBEAT_TTL_MS = 60_000;

export function isWorkerHeartbeatExpired(options: {
  worker: Pick<WorkerProcessRecord, "heartbeatAt">;
  now?: string;
  heartbeatTimeoutMs?: number;
}): boolean {
  const heartbeatAtMs = Date.parse(options.worker.heartbeatAt);
  if (!Number.isFinite(heartbeatAtMs)) {
    return true;
  }

  const nowMs = Date.parse(options.now ?? new Date().toISOString());
  const timeoutMs = Math.max(1, Math.floor(options.heartbeatTimeoutMs ?? DEFAULT_WORKER_HEARTBEAT_TTL_MS));
  return nowMs - heartbeatAtMs > timeoutMs;
}

export async function registerWorkflowWorker(options: {
  workDir: string;
  role: WorkerSpec["role"];
  projectSlug?: string | null;
  pid: number;
  startedAt?: string;
  heartbeatAt?: string;
  currentClaim?: WorkerClaim | null;
  restartCount?: number;
}): Promise<WorkerProcessRecord> {
  const startedAt = options.startedAt ?? new Date().toISOString();
  const heartbeatAt = options.heartbeatAt ?? startedAt;
  return upsertWorkflowWorkerRecord(options.workDir, {
    workerId: buildWorkerId({ role: options.role, projectSlug: options.projectSlug ?? null }),
    pid: options.pid,
    role: options.role,
    projectSlug: options.projectSlug ?? null,
    startedAt,
    heartbeatAt,
    currentClaim: options.currentClaim ?? null,
    restartCount: options.restartCount ?? 0,
  });
}

export async function heartbeatWorkflowWorker(options: {
  workDir: string;
  workerId: string;
  heartbeatAt?: string;
  currentClaim?: WorkerClaim | null;
}): Promise<WorkerProcessRecord | null> {
  const existing = await getWorkflowWorkerRecord(options.workDir, options.workerId);
  if (existing === null) {
    return null;
  }

  return upsertWorkflowWorkerRecord(options.workDir, {
    ...existing,
    heartbeatAt: options.heartbeatAt ?? new Date().toISOString(),
    currentClaim: options.currentClaim === undefined ? existing.currentClaim : options.currentClaim,
  });
}

export async function clearExpiredWorkflowWorkers(options: {
  workDir: string;
  now?: string;
  heartbeatTimeoutMs?: number;
}): Promise<WorkerProcessRecord[]> {
  const state = await readWorkflowWorkerState(options.workDir);
  const expiredWorkers = state.workers.filter((worker) => isWorkerHeartbeatExpired({
    worker,
    now: options.now,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs,
  }));

  for (const worker of expiredWorkers) {
    await removeWorkflowWorkerRecord(options.workDir, worker.workerId);
  }

  return expiredWorkers;
}
