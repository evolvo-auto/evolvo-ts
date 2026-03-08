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

export type RuntimeStatusSnapshot = {
  online: true;
  runtimeState: RuntimeStatusState;
  workMode: RuntimeWorkMode;
  activitySummary: string | null;
  activeProject: RuntimeStatusProject | null;
  activeIssue: RuntimeStatusIssue | null;
  deferredStop: ActiveProjectState["deferredStopMode"] | null;
  cycle: RuntimeStatusCycle | null;
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
  activeProject: RuntimeStatusProject | null;
  activeIssue: RuntimeStatusIssue | null;
  currentCycle: number | null;
  cycleLimit: number | null;
}): RuntimeStatusSnapshot {
  return {
    online: true,
    runtimeState: input.runtimeState,
    workMode: deriveWorkMode(input.activeProjectState, input.runtimeState),
    activitySummary: input.activitySummary?.trim() || null,
    activeProject: input.activeProject,
    activeIssue: input.activeIssue,
    deferredStop: input.activeProjectState.deferredStopMode ?? null,
    cycle: buildCycleStatus(input.currentCycle, input.cycleLimit),
  };
}
