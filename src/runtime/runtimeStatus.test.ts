import { describe, expect, it } from "vitest";
import { buildRuntimeStatusSnapshot } from "./runtimeStatus.js";

describe("runtimeStatus", () => {
  it("reports self-work with cycle remaining when no managed project is active", () => {
    const snapshot = buildRuntimeStatusSnapshot({
      runtimeState: "active",
      activitySummary: "Selecting next issue.",
      activeProjectState: {
        activeProjectSlug: null,
        selectionState: null,
        deferredStopMode: null,
      },
      activeProjects: [],
      activeProject: null,
      activeIssue: {
        number: 404,
        title: "Default Codex model",
        repository: "evolvo-auto/evolvo-ts",
        lifecycleState: "selected -> executing",
      },
      currentCycle: 3,
      cycleLimit: 10,
    });

    expect(snapshot).toEqual({
      online: true,
      runtimeState: "active",
      workMode: "self-work",
      activitySummary: "Selecting next issue.",
      activeProjects: [],
      activeProject: null,
      activeIssue: {
        number: 404,
        title: "Default Codex model",
        repository: "evolvo-auto/evolvo-ts",
        lifecycleState: "selected -> executing",
      },
      deferredStop: null,
      cycle: {
        current: 3,
        limit: 10,
        remaining: 7,
      },
      queueTotals: null,
      workers: [],
      limits: null,
    });
  });

  it("reports project work and deferred stop when a managed project remains active", () => {
    const snapshot = buildRuntimeStatusSnapshot({
      runtimeState: "active",
      activitySummary: "Executing current project issue.",
      activeProjectState: {
        activeProjectSlug: "habit-cli",
        selectionState: "active",
        deferredStopMode: "when-project-complete",
      },
      activeProjects: [
        {
          displayName: "Habit CLI",
          slug: "habit-cli",
          repository: "evolvo-auto/habit-cli",
        },
      ],
      activeProject: {
        displayName: "Habit CLI",
        slug: "habit-cli",
        repository: "evolvo-auto/habit-cli",
      },
      activeIssue: {
        number: 17,
        title: "Polish project command routing",
        repository: "evolvo-auto/habit-cli",
        lifecycleState: "selected -> executing",
      },
      currentCycle: 5,
      cycleLimit: 12,
    });

    expect(snapshot.workMode).toBe("project-work");
    expect(snapshot.deferredStop).toBe("when-project-complete");
    expect(snapshot.activeProject).toEqual({
      displayName: "Habit CLI",
      slug: "habit-cli",
      repository: "evolvo-auto/habit-cli",
    });
    expect(snapshot.cycle).toEqual({
      current: 5,
      limit: 12,
      remaining: 7,
    });
    expect(snapshot.queueTotals).toBeNull();
    expect(snapshot.workers).toEqual([]);
    expect(snapshot.limits).toBeNull();
  });

  it("reports idle mode when a project is explicitly stopped", () => {
    const snapshot = buildRuntimeStatusSnapshot({
      runtimeState: "waiting",
      activitySummary: "Waiting for further operator instructions.",
      activeProjectState: {
        activeProjectSlug: "habit-cli",
        selectionState: "stopped",
        deferredStopMode: null,
      },
      activeProjects: [
        {
          displayName: "Habit CLI",
          slug: "habit-cli",
          repository: "evolvo-auto/habit-cli",
        },
      ],
      activeProject: {
        displayName: "Habit CLI",
        slug: "habit-cli",
        repository: "evolvo-auto/habit-cli",
      },
      activeIssue: null,
      currentCycle: null,
      cycleLimit: 10,
    });

    expect(snapshot.workMode).toBe("idle");
    expect(snapshot.cycle).toEqual({
      current: null,
      limit: 10,
      remaining: 10,
    });
    expect(snapshot.queueTotals).toBeNull();
    expect(snapshot.workers).toEqual([]);
    expect(snapshot.limits).toBeNull();
  });
});
