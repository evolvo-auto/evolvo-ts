import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { activateProjectInState } from "../projects/activeProjectsState.js";
import { registerWorkflowWorker } from "./workers/workerHeartbeat.js";
import { buildDesiredWorkerSpecs, planWorkflowSupervisorActions, runWorkflowSupervisorPlanningCycle } from "./workflowSupervisor.js";

async function createTempWorkDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "workflow-supervisor-"));
}

describe("workflowSupervisor", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("builds singleton global workers plus one dev worker per active project", () => {
    expect(buildDesiredWorkerSpecs(["habit-cli", "evolvo-web"])).toEqual([
      { role: "issue-generator", projectSlug: null },
      { role: "planner", projectSlug: null },
      { role: "review", projectSlug: null },
      { role: "release", projectSlug: null },
      { role: "dev", projectSlug: "evolvo-web" },
      { role: "dev", projectSlug: "habit-cli" },
    ]);
  });

  it("plans starts, restarts, and stops from desired/current worker state", () => {
    const actions = planWorkflowSupervisorActions({
      desiredWorkers: [
        { role: "issue-generator", projectSlug: null },
        { role: "planner", projectSlug: null },
        { role: "review", projectSlug: null },
        { role: "release", projectSlug: null },
        { role: "dev", projectSlug: "habit-cli" },
      ],
      currentWorkers: [
        {
          workerId: "issue-generator",
          pid: 100,
          role: "issue-generator",
          projectSlug: null,
          startedAt: "2026-03-08T10:00:00.000Z",
          heartbeatAt: "2026-03-08T10:01:40.000Z",
          currentClaim: null,
          restartCount: 0,
        },
        {
          workerId: "planner",
          pid: 101,
          role: "planner",
          projectSlug: null,
          startedAt: "2026-03-08T10:00:00.000Z",
          heartbeatAt: "2026-03-08T10:00:00.000Z",
          currentClaim: null,
          restartCount: 1,
        },
        {
          workerId: "dev:old-project",
          pid: 102,
          role: "dev",
          projectSlug: "old-project",
          startedAt: "2026-03-08T10:00:00.000Z",
          heartbeatAt: "2026-03-08T10:00:20.000Z",
          currentClaim: null,
          restartCount: 0,
        },
        {
          workerId: "release-duplicate",
          pid: 103,
          role: "release",
          projectSlug: null,
          startedAt: "2026-03-08T10:00:00.000Z",
          heartbeatAt: "2026-03-08T10:01:10.000Z",
          currentClaim: null,
          restartCount: 0,
        },
        {
          workerId: "release",
          pid: 104,
          role: "release",
          projectSlug: null,
          startedAt: "2026-03-08T10:00:00.000Z",
          heartbeatAt: "2026-03-08T10:01:45.000Z",
          currentClaim: null,
          restartCount: 0,
        },
      ],
      now: "2026-03-08T10:02:00.000Z",
      heartbeatTimeoutMs: 30_000,
    });

    expect(actions).toEqual([
      {
        type: "restart",
        spec: { role: "planner", projectSlug: null },
        workerId: "planner",
        reason: "expired-heartbeat",
      },
      {
        type: "start",
        spec: { role: "dev", projectSlug: "habit-cli" },
        reason: "missing-worker",
      },
      {
        type: "start",
        spec: { role: "review", projectSlug: null },
        reason: "missing-worker",
      },
      {
        type: "stop",
        spec: { role: "dev", projectSlug: "old-project" },
        workerId: "dev:old-project",
        reason: "inactive-project",
      },
      {
        type: "stop",
        spec: { role: "release", projectSlug: null },
        workerId: "release-duplicate",
        reason: "duplicate-worker",
      },
    ]);
  });

  it("derives planning actions from active project state and stored workers", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    await activateProjectInState({
      workDir,
      slug: "habit-cli",
      requestedBy: "discord:operator-1",
      source: "start-project-command",
      updatedAt: "2026-03-08T10:00:00.000Z",
    });
    await registerWorkflowWorker({
      workDir,
      role: "issue-generator",
      pid: 100,
      startedAt: "2026-03-08T10:00:00.000Z",
      heartbeatAt: "2026-03-08T10:00:30.000Z",
    });

    const actions = await runWorkflowSupervisorPlanningCycle({
      workDir,
      now: "2026-03-08T10:00:45.000Z",
      heartbeatTimeoutMs: 30_000,
    });

    expect(actions).toEqual([
      {
        type: "start",
        spec: { role: "dev", projectSlug: "habit-cli" },
        reason: "missing-worker",
      },
      {
        type: "start",
        spec: { role: "planner", projectSlug: null },
        reason: "missing-worker",
      },
      {
        type: "start",
        spec: { role: "release", projectSlug: null },
        reason: "missing-worker",
      },
      {
        type: "start",
        spec: { role: "review", projectSlug: null },
        reason: "missing-worker",
      },
    ]);
  });
});
