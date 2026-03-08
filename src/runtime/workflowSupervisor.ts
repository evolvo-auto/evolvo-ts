import { readActiveProjectsState } from "../projects/activeProjectsState.js";
import {
  DEFAULT_WORKER_HEARTBEAT_TTL_MS,
  isWorkerHeartbeatExpired,
} from "./workers/workerHeartbeat.js";
import { type WorkerProcessRecord, type WorkerSpec, GLOBAL_WORKER_ROLES } from "./workers/workerTypes.js";
import { readWorkflowWorkerState } from "./workers/workflowWorkerState.js";

export type WorkflowSupervisorAction =
  | {
    type: "start";
    spec: WorkerSpec;
    reason: "missing-worker";
  }
  | {
    type: "restart";
    spec: WorkerSpec;
    workerId: string;
    reason: "expired-heartbeat";
  }
  | {
    type: "stop";
    spec: WorkerSpec;
    workerId: string;
    reason: "inactive-project" | "duplicate-worker";
  };

function compareWorkersByFreshness(left: WorkerProcessRecord, right: WorkerProcessRecord): number {
  return Date.parse(right.heartbeatAt) - Date.parse(left.heartbeatAt);
}

export function buildDesiredWorkerSpecs(activeProjectSlugs: string[]): WorkerSpec[] {
  const normalizedProjectSlugs = [...new Set(
    activeProjectSlugs
      .map((slug) => slug.trim())
      .filter((slug) => slug.length > 0),
  )].sort((left, right) => left.localeCompare(right));

  return [
    ...GLOBAL_WORKER_ROLES.map((role) => ({ role, projectSlug: null })),
    ...normalizedProjectSlugs.map((projectSlug) => ({ role: "dev" as const, projectSlug })),
  ];
}

function isSameSpec(worker: Pick<WorkerProcessRecord, "role" | "projectSlug">, spec: WorkerSpec): boolean {
  return worker.role === spec.role && (worker.projectSlug ?? null) === spec.projectSlug;
}

export function planWorkflowSupervisorActions(options: {
  desiredWorkers: WorkerSpec[];
  currentWorkers: WorkerProcessRecord[];
  now?: string;
  heartbeatTimeoutMs?: number;
}): WorkflowSupervisorAction[] {
  const actions: WorkflowSupervisorAction[] = [];
  const desiredKeySet = new Set(options.desiredWorkers.map((spec) => `${spec.role}:${spec.projectSlug ?? ""}`));

  for (const spec of options.desiredWorkers) {
    const matches = options.currentWorkers
      .filter((worker) => isSameSpec(worker, spec))
      .sort(compareWorkersByFreshness);
    const primary = matches[0] ?? null;

    if (primary === null) {
      actions.push({
        type: "start",
        spec,
        reason: "missing-worker",
      });
      continue;
    }

    if (isWorkerHeartbeatExpired({ worker: primary, now: options.now, heartbeatTimeoutMs: options.heartbeatTimeoutMs })) {
      actions.push({
        type: "restart",
        spec,
        workerId: primary.workerId,
        reason: "expired-heartbeat",
      });
    }

    for (const duplicate of matches.slice(1)) {
      actions.push({
        type: "stop",
        spec,
        workerId: duplicate.workerId,
        reason: "duplicate-worker",
      });
    }
  }

  for (const worker of options.currentWorkers) {
    const key = `${worker.role}:${worker.projectSlug ?? ""}`;
    if (!desiredKeySet.has(key)) {
      actions.push({
        type: "stop",
        spec: {
          role: worker.role,
          projectSlug: worker.projectSlug ?? null,
        },
        workerId: worker.workerId,
        reason: "inactive-project",
      });
    }
  }

  return actions.sort((left, right) => {
    const leftKey = `${left.type}:${left.spec.role}:${left.spec.projectSlug ?? ""}:${"workerId" in left ? left.workerId : ""}`;
    const rightKey = `${right.type}:${right.spec.role}:${right.spec.projectSlug ?? ""}:${"workerId" in right ? right.workerId : ""}`;
    return leftKey.localeCompare(rightKey);
  });
}

export async function runWorkflowSupervisorPlanningCycle(options: {
  workDir: string;
  now?: string;
  heartbeatTimeoutMs?: number;
}): Promise<WorkflowSupervisorAction[]> {
  const [activeProjectsState, workflowWorkerState] = await Promise.all([
    readActiveProjectsState(options.workDir),
    readWorkflowWorkerState(options.workDir),
  ]);

  return planWorkflowSupervisorActions({
    desiredWorkers: buildDesiredWorkerSpecs(activeProjectsState.projects.map((project) => project.slug)),
    currentWorkers: workflowWorkerState.workers,
    now: options.now,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? DEFAULT_WORKER_HEARTBEAT_TTL_MS,
  });
}
