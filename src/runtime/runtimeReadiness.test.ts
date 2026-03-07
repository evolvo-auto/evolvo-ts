import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getRuntimeReadinessSignalPath,
  waitForRuntimeReadinessSignal,
  writeRuntimeReadinessSignal,
} from "./runtimeReadiness.js";

async function createTempWorkDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "runtime-readiness-"));
}

describe("runtimeReadiness", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("writes readiness signal with runtime metadata", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    const path = await writeRuntimeReadinessSignal({
      workDir,
      token: "abc-123",
    });

    expect(path).toBe(join(workDir, ".evolvo", "runtime-readiness.json"));
    const raw = JSON.parse(await readFile(path, "utf8")) as {
      token: string;
      status: string;
      pid: number;
      startedAt: string;
    };
    expect(raw.token).toBe("abc-123");
    expect(raw.status).toBe("ready");
    expect(raw.pid).toBe(process.pid);
    expect(typeof raw.startedAt).toBe("string");
  });

  it("waits until matching readiness token appears", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    const signalPath = getRuntimeReadinessSignalPath(workDir);

    const waitPromise = waitForRuntimeReadinessSignal({
      workDir,
      token: "restart-token",
      timeoutMs: 400,
      pollIntervalMs: 20,
      signalPath,
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 60);
    });
    await writeRuntimeReadinessSignal({
      workDir,
      token: "restart-token",
      signalPath,
    });

    await expect(waitPromise).resolves.toEqual(
      expect.objectContaining({
        token: "restart-token",
        status: "ready",
      }),
    );
  });

  it("fails with token mismatch diagnostics when readiness token is wrong", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    await writeRuntimeReadinessSignal({
      workDir,
      token: "other-token",
    });

    await expect(
      waitForRuntimeReadinessSignal({
        workDir,
        token: "expected-token",
        timeoutMs: 80,
        pollIntervalMs: 10,
      }),
    ).rejects.toThrow("Last observed token=other-token");
  });

  it("fails when readiness file payload is malformed", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    const signalPath = getRuntimeReadinessSignalPath(workDir);
    await mkdir(join(workDir, ".evolvo"), { recursive: true });
    await writeFile(signalPath, "{not-json", "utf8");

    await expect(
      waitForRuntimeReadinessSignal({
        workDir,
        token: "expected-token",
        timeoutMs: 80,
        pollIntervalMs: 10,
        signalPath,
      }),
    ).rejects.toThrow(`Could not read runtime readiness signal at ${signalPath}`);
  });
});
