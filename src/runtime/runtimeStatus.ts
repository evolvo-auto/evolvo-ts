import type { ActiveProjectState } from "../projects/activeProjectState.js";

export type RuntimeStatusState = "starting" | "active" | "idle" | "waiting" | "stopping";
export type RuntimeWorkMode = "self-work" | "project-work" | "idle";

export type RuntimeStatusProject = {
  displayName: string;
  slug: string;
  repository: string | null;
};

export type RuntimeStatusIssue = {
  number: number;
  title: string;
  repository: string | null;
  lifecycleState: string | null;
};

export type RuntimeStatusCycle = {
  current: number | null;
  limit: number | null;
  remaining: number | null;
};

export type RuntimeStatusQueueTotals = {
  Inbox: number;
  Planning: number;
  "Ready for Dev": number;
  "In Dev": number;
  "Ready for Review": number;
  "In Review": number;
  "Ready for Release": number;
  Releasing: number;
  Blocked: number;
  Done: number;
};

export type RuntimeStatusWorker = {
  workerId: string;
  role: string;
  projectSlug: string | null;
  claim: string | null;
  restartCount: number;
};

export type RuntimeStatusLimits = {
  ideaStageTargetPerProject: number;
  issueGeneratorMaxIssuesPerProject: number;
  planningLimitPerProject: number;
  readyForDevLimitPerProject: number;
  inDevLimitPerProject: number;
};

export type RuntimeStatusSnapshot = {
  online: true;
  runtimeState: RuntimeStatusState;
  workMode: RuntimeWorkMode;
  activitySummary: string | null;
  activeProjects: RuntimeStatusProject[];
  activeProject: RuntimeStatusProject | null;
  activeIssue: RuntimeStatusIssue | null;
  deferredStop: ActiveProjectState["deferredStopMode"] | null;
  cycle: RuntimeStatusCycle | null;
  queueTotals: RuntimeStatusQueueTotals | null;
  workers: RuntimeStatusWorker[];
  limits: RuntimeStatusLimits | null;
};

function normalizePositiveInteger(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.floor(value);
}

function deriveWorkMode(
  activeProjectState: Pick<ActiveProjectState, "activeProjectSlug" | "selectionState">,
  runtimeState: RuntimeStatusState,
): RuntimeWorkMode {
  if (activeProjectState.selectionState === "stopped") {
    return "idle";
  }

  if (activeProjectState.activeProjectSlug !== null) {
    return "project-work";
  }

  if (runtimeState === "idle" || runtimeState === "waiting") {
    return "idle";
  }

  return "self-work";
}

function buildCycleStatus(
  currentCycle: number | null | undefined,
  cycleLimit: number | null | undefined,
): RuntimeStatusCycle | null {
  const current = normalizePositiveInteger(currentCycle);
  const limit = normalizePositiveInteger(cycleLimit);
  if (current === null && limit === null) {
    return null;
  }

  const remaining = limit === null
    ? null
    : current === null
      ? limit
      : Math.max(limit - current, 0);

  return {
    current,
    limit,
    remaining,
  };
}

export function buildRuntimeStatusSnapshot(input: {
  runtimeState: RuntimeStatusState;
  activitySummary: string | null;
  activeProjectState: Pick<ActiveProjectState, "activeProjectSlug" | "selectionState" | "deferredStopMode">;
  activeProjects: RuntimeStatusProject[];
  activeProject: RuntimeStatusProject | null;
  activeIssue: RuntimeStatusIssue | null;
  currentCycle: number | null;
  cycleLimit: number | null;
  queueTotals?: RuntimeStatusQueueTotals | null;
  workers?: RuntimeStatusWorker[];
  limits?: RuntimeStatusLimits | null;
}): RuntimeStatusSnapshot {
  return {
    online: true,
    runtimeState: input.runtimeState,
    workMode: deriveWorkMode(input.activeProjectState, input.runtimeState),
    activitySummary: input.activitySummary?.trim() || null,
    activeProjects: input.activeProjects,
    activeProject: input.activeProject,
    activeIssue: input.activeIssue,
    deferredStop: input.activeProjectState.deferredStopMode ?? null,
    cycle: buildCycleStatus(input.currentCycle, input.cycleLimit),
    queueTotals: input.queueTotals ?? null,
    workers: input.workers ?? [],
    limits: input.limits ?? null,
  };
}
