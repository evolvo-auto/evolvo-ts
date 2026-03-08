export const GLOBAL_WORKER_ROLES = [
  "issue-generator",
  "planner",
  "review",
  "release",
] as const;

export type GlobalWorkerRole = (typeof GLOBAL_WORKER_ROLES)[number];
export type WorkerRole = GlobalWorkerRole | "dev";

export type WorkerClaim = {
  issueNumber: number | null;
  pullRequestNumber: number | null;
  queueKey: string | null;
  stage: string | null;
  claimedAt: string | null;
};

export type WorkerProcessRecord = {
  workerId: string;
  pid: number;
  role: WorkerRole;
  projectSlug: string | null;
  startedAt: string;
  heartbeatAt: string;
  currentClaim: WorkerClaim | null;
  restartCount: number;
};

export type WorkflowWorkerState = {
  version: 1;
  workers: WorkerProcessRecord[];
};

export type WorkerSpec = {
  role: WorkerRole;
  projectSlug: string | null;
};

export function isGlobalWorkerRole(role: WorkerRole): role is GlobalWorkerRole {
  return GLOBAL_WORKER_ROLES.includes(role as GlobalWorkerRole);
}

export function buildWorkerId(spec: WorkerSpec): string {
  return spec.role === "dev"
    ? `dev:${spec.projectSlug ?? "unknown"}`
    : spec.role;
}
