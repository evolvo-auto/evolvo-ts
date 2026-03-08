import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearExpiredWorkflowWorkers,
  heartbeatWorkflowWorker,
  isWorkerHeartbeatExpired,
  registerWorkflowWorker,
} from "./workerHeartbeat.js";
import { readWorkflowWorkerState } from "./workflowWorkerState.js";

async function createTempWorkDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "worker-heartbeat-"));
}

describe("workerHeartbeat", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("registers workers and updates heartbeats", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    await registerWorkflowWorker({
      workDir,
      role: "dev",
      projectSlug: "habit-cli",
      pid: 4321,
      startedAt: "2026-03-08T10:00:00.000Z",
      heartbeatAt: "2026-03-08T10:00:00.000Z",
    });

    await heartbeatWorkflowWorker({
      workDir,
      workerId: "dev:habit-cli",
      heartbeatAt: "2026-03-08T10:01:00.000Z",
      currentClaim: {
        issueNumber: 77,
        pullRequestNumber: null,
        queueKey: "tracker:owner/repo#77",
        stage: "In Dev",
        claimedAt: "2026-03-08T10:01:00.000Z",
      },
    });

    const state = await readWorkflowWorkerState(workDir);
    expect(state.workers[0]).toEqual(expect.objectContaining({
      workerId: "dev:habit-cli",
      heartbeatAt: "2026-03-08T10:01:00.000Z",
      currentClaim: expect.objectContaining({
        issueNumber: 77,
        stage: "In Dev",
      }),
    }));
  });

  it("detects expired heartbeats and clears expired worker records", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    await registerWorkflowWorker({
      workDir,
      role: "review",
      pid: 5678,
      startedAt: "2026-03-08T10:00:00.000Z",
      heartbeatAt: "2026-03-08T10:00:00.000Z",
    });

    expect(isWorkerHeartbeatExpired({
      worker: { heartbeatAt: "2026-03-08T10:00:00.000Z" },
      now: "2026-03-08T10:02:00.000Z",
      heartbeatTimeoutMs: 30_000,
    })).toBe(true);

    const expiredWorkers = await clearExpiredWorkflowWorkers({
      workDir,
      now: "2026-03-08T10:02:00.000Z",
      heartbeatTimeoutMs: 30_000,
    });

    expect(expiredWorkers.map((worker) => worker.workerId)).toEqual(["review"]);
    await expect(readWorkflowWorkerState(workDir)).resolves.toEqual({ version: 1, workers: [] });
  });
});
