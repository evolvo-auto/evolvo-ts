import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getWorkflowWorkerRecord,
  getWorkflowWorkerStatePath,
  readWorkflowWorkerState,
  removeWorkflowWorkerRecord,
  upsertWorkflowWorkerRecord,
} from "./workflowWorkerState.js";

async function createTempWorkDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "workflow-worker-state-"));
}

describe("workflowWorkerState", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("reads the default worker state when no file exists", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    await expect(readWorkflowWorkerState(workDir)).resolves.toEqual({
      version: 1,
      workers: [],
    });
  });

  it("upserts and retrieves worker records", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    const record = await upsertWorkflowWorkerRecord(workDir, {
      pid: 1234,
      role: "planner",
      projectSlug: null,
      startedAt: "2026-03-08T10:00:00.000Z",
      heartbeatAt: "2026-03-08T10:00:00.000Z",
      currentClaim: null,
      restartCount: 0,
    });

    expect(record.workerId).toBe("planner");
    await expect(getWorkflowWorkerRecord(workDir, "planner")).resolves.toEqual(record);
    await expect(readWorkflowWorkerState(workDir)).resolves.toEqual({
      version: 1,
      workers: [record],
    });
  });

  it("removes worker records by worker id", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    await upsertWorkflowWorkerRecord(workDir, {
      pid: 2222,
      role: "dev",
      projectSlug: "habit-cli",
      startedAt: "2026-03-08T10:00:00.000Z",
      heartbeatAt: "2026-03-08T10:00:00.000Z",
      currentClaim: null,
      restartCount: 0,
    });

    await removeWorkflowWorkerRecord(workDir, "dev:habit-cli");

    await expect(readWorkflowWorkerState(workDir)).resolves.toEqual({
      version: 1,
      workers: [],
    });
  });

  it("recovers invalid worker state payloads", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    const statePath = getWorkflowWorkerStatePath(workDir);
    await mkdir(join(workDir, ".evolvo", "workers"), { recursive: true });
    await writeFile(statePath, JSON.stringify({ version: 1, workers: [{ nope: true }] }), "utf8");

    const state = await readWorkflowWorkerState(workDir);

    expect(state).toEqual({ version: 1, workers: [] });
    const repaired = JSON.parse(await readFile(statePath, "utf8")) as { workers: unknown[] };
    expect(repaired.workers).toEqual([]);
  });
});
