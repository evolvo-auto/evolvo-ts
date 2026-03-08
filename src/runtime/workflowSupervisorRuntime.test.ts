import { describe, expect, it, vi } from "vitest";
import { applyWorkflowSupervisorActions } from "./workflowSupervisorRuntime.js";

vi.mock("../environment.js", () => ({
  GITHUB_OWNER: "Evolvo-org",
  GITHUB_REPO: "evolvo-ts",
}));

describe("workflowSupervisorRuntime", () => {
  it("applies start, stop, and restart actions using the worker spawner and handle map", async () => {
    const spawnWorker = vi.fn(async ({ spec, restartCount }: { spec: { role: string; projectSlug: string | null }; restartCount: number }) => {
      const workerId = spec.role === "dev" ? `dev:${spec.projectSlug}` : spec.role;
      return {
        workerId,
        stop: vi.fn().mockResolvedValue(undefined),
        restartCount,
      };
    });
    const existingStop = vi.fn().mockResolvedValue(undefined);
    const releaseStop = vi.fn().mockResolvedValue(undefined);
    const workerHandles = new Map([
      ["review", { workerId: "review", stop: existingStop }],
      ["release", { workerId: "release", stop: releaseStop }],
    ]);
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await applyWorkflowSupervisorActions({
      workDir: "/tmp/evolvo",
      actions: [
        {
          type: "start",
          spec: { role: "planner", projectSlug: null },
          reason: "missing-worker",
        },
        {
          type: "restart",
          spec: { role: "review", projectSlug: null },
          workerId: "review",
          reason: "expired-heartbeat",
        },
        {
          type: "stop",
          spec: { role: "release", projectSlug: null },
          workerId: "release",
          reason: "inactive-project",
        },
      ],
      currentWorkers: [
        {
          workerId: "review",
          pid: 111,
          role: "review",
          projectSlug: null,
          startedAt: "2026-03-08T10:00:00.000Z",
          heartbeatAt: "2026-03-08T10:00:00.000Z",
          currentClaim: null,
          restartCount: 2,
        },
      ],
      workerHandles,
      spawnWorker,
    });

    expect(spawnWorker).toHaveBeenNthCalledWith(1, {
      workDir: "/tmp/evolvo",
      spec: { role: "planner", projectSlug: null },
      restartCount: 0,
    });
    expect(spawnWorker).toHaveBeenNthCalledWith(2, {
      workDir: "/tmp/evolvo",
      spec: { role: "review", projectSlug: null },
      restartCount: 3,
    });
    expect(existingStop).toHaveBeenCalledTimes(1);
    expect(releaseStop).toHaveBeenCalledTimes(1);
    expect(workerHandles.has("planner")).toBe(true);
    expect(workerHandles.has("review")).toBe(true);
    expect(workerHandles.has("release")).toBe(false);
    expect(consoleLogSpy).toHaveBeenCalledWith("[supervisor] started planner.");
    expect(consoleLogSpy).toHaveBeenCalledWith("[supervisor] restarted review (expired-heartbeat).");
    expect(consoleLogSpy).toHaveBeenCalledWith("[supervisor] stopped release (inactive-project).");
  });

  it("runs reconciliation before planning each supervisor cycle", async () => {
    const reconcileState = vi.fn().mockResolvedValue(undefined);
    const runPlanningCycle = vi.fn().mockResolvedValue([]);
    const stop = vi.fn(async () => {
      process.emit("SIGTERM");
    });
    const spawnWorker = vi.fn().mockResolvedValue({ workerId: "planner", stop });

    const { runWorkflowSupervisorRuntime } = await import("./workflowSupervisorRuntime.js");
    const runtimePromise = runWorkflowSupervisorRuntime({
      workDir: "/tmp/evolvo",
      pollIntervalMs: 1,
      reconcileState,
      runPlanningCycle,
      spawnWorker,
    });

    setTimeout(() => {
      process.emit("SIGTERM");
    }, 5);

    await runtimePromise;

    expect(reconcileState).toHaveBeenCalled();
    expect(runPlanningCycle).toHaveBeenCalled();
  });
});
