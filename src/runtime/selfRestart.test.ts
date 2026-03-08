import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();
const spawnMock = vi.fn();
const rmMock = vi.fn();
const getRuntimeReadinessSignalPathMock = vi.fn();
const waitForRuntimeReadinessSignalMock = vi.fn();
const resolveRepositoryDefaultBranchMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
  spawn: spawnMock,
}));

vi.mock("node:fs", () => ({
  promises: {
    rm: rmMock,
  },
}));

vi.mock("./runtimeReadiness.js", () => ({
  getRuntimeReadinessSignalPath: getRuntimeReadinessSignalPathMock,
  waitForRuntimeReadinessSignal: waitForRuntimeReadinessSignalMock,
}));

vi.mock("./defaultBranch.js", () => ({
  resolveRepositoryDefaultBranch: resolveRepositoryDefaultBranchMock,
}));

function createChildProcessStub(overrides: {
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  killed?: boolean;
  kill?: (signal?: NodeJS.Signals | number) => boolean;
  pid?: number;
  once?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
} = {}) {
  return {
    exitCode: overrides.exitCode ?? null,
    signalCode: overrides.signalCode ?? null,
    killed: overrides.killed ?? false,
    kill: overrides.kill ?? vi.fn(() => true),
    pid: overrides.pid ?? 999,
    once: overrides.once ?? vi.fn(),
    removeListener: overrides.removeListener ?? vi.fn(),
  };
}

async function waitForSpawn(iterations = 20): Promise<void> {
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    if (spawnMock.mock.calls.length > 0) {
      return;
    }

    await Promise.resolve();
  }

  throw new Error("Timed out waiting for pnpm start to be spawned.");
}

describe("runPostMergeSelfRestart", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    execFileMock.mockReset();
    spawnMock.mockReset();
    rmMock.mockReset();
    rmMock.mockResolvedValue(undefined);
    getRuntimeReadinessSignalPathMock.mockReset();
    getRuntimeReadinessSignalPathMock.mockReturnValue("/tmp/evolvo/.evolvo/runtime-readiness.json");
    waitForRuntimeReadinessSignalMock.mockReset();
    waitForRuntimeReadinessSignalMock.mockResolvedValue({
      token: "token",
      status: "ready",
      pid: 1234,
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    resolveRepositoryDefaultBranchMock.mockReset();
    resolveRepositoryDefaultBranchMock.mockResolvedValue("main");
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs checkout on the detected default branch, then performs a frozen-lockfile install, builds and starts runtime", async () => {
    execFileMock.mockImplementation((_command: string, _args: string[], _options: unknown, callback: (error: unknown, stdout: string, stderr: string) => void) => {
      callback(null, "", "");
    });
    resolveRepositoryDefaultBranchMock.mockResolvedValueOnce("trunk");
    const onceHandlers: Record<string, (...args: unknown[]) => void> = {};
    const child = createChildProcessStub({
      once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        onceHandlers[event] = handler;
      }),
    });
    spawnMock.mockReturnValue(child);

    const { runPostMergeSelfRestart } = await import("./selfRestart.js");
    await expect(runPostMergeSelfRestart("/tmp/evolvo")).resolves.toBeUndefined();

    expect(resolveRepositoryDefaultBranchMock).toHaveBeenCalledWith("/tmp/evolvo");
    expect(execFileMock).toHaveBeenNthCalledWith(1, "git", ["checkout", "trunk"], { cwd: "/tmp/evolvo" }, expect.any(Function));
    expect(execFileMock).toHaveBeenNthCalledWith(2, "git", ["pull", "--ff-only"], { cwd: "/tmp/evolvo" }, expect.any(Function));
    expect(execFileMock).toHaveBeenNthCalledWith(
      3,
      "pnpm",
      ["install", "--frozen-lockfile"],
      { cwd: "/tmp/evolvo" },
      expect.any(Function),
    );
    expect(execFileMock).toHaveBeenNthCalledWith(4, "pnpm", ["build"], { cwd: "/tmp/evolvo" }, expect.any(Function));
    const spawnCall = spawnMock.mock.calls[0];
    expect(spawnCall?.[0]).toBe("pnpm");
    expect(spawnCall?.[1]).toEqual(["start"]);
    expect(spawnCall?.[2]).toEqual(expect.objectContaining({
      cwd: "/tmp/evolvo",
      detached: false,
      stdio: "inherit",
      env: expect.objectContaining({
        EVOLVO_READINESS_FILE: "/tmp/evolvo/.evolvo/runtime-readiness.json",
        EVOLVO_RESTART_TOKEN: expect.any(String),
      }),
    }));
    const restartToken = (spawnCall?.[2] as { env?: { EVOLVO_RESTART_TOKEN?: string } })?.env?.EVOLVO_RESTART_TOKEN;
    expect(typeof restartToken).toBe("string");
    expect(restartToken?.length).toBeGreaterThan(0);
    expect(waitForRuntimeReadinessSignalMock).toHaveBeenCalledWith({
      workDir: "/tmp/evolvo",
      token: restartToken,
      timeoutMs: 15000,
      signalPath: "/tmp/evolvo/.evolvo/runtime-readiness.json",
    });
    expect(onceHandlers.error).toBeTypeOf("function");
    expect(onceHandlers.exit).toBeTypeOf("function");
  });

  it("fails with diagnostics when a restart step command fails", async () => {
    execFileMock.mockImplementationOnce((_command: string, _args: string[], _options: unknown, callback: (error: unknown, stdout: string, stderr: string) => void) => {
      const error = Object.assign(new Error("failed"), { stderr: "checkout failed" });
      callback(error, "", "checkout failed");
    });
    resolveRepositoryDefaultBranchMock.mockResolvedValueOnce("release");

    const { runPostMergeSelfRestart } = await import("./selfRestart.js");

    await expect(runPostMergeSelfRestart("/tmp/evolvo")).rejects.toThrow(
      "Post-merge restart step failed: git checkout release. Output: checkout failed",
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("surfaces frozen-lockfile install failures with the exact restart step", async () => {
    execFileMock
      .mockImplementationOnce(
        (_command: string, _args: string[], _options: unknown, callback: (error: unknown, stdout: string, stderr: string) => void) => {
          callback(null, "", "");
        },
      )
      .mockImplementationOnce(
        (_command: string, _args: string[], _options: unknown, callback: (error: unknown, stdout: string, stderr: string) => void) => {
          callback(null, "", "");
        },
      )
      .mockImplementationOnce(
        (_command: string, _args: string[], _options: unknown, callback: (error: unknown, stdout: string, stderr: string) => void) => {
          const error = Object.assign(new Error("failed"), { stderr: "lockfile would be modified" });
          callback(error, "", "lockfile would be modified");
        },
      );

    const { runPostMergeSelfRestart } = await import("./selfRestart.js");

    await expect(runPostMergeSelfRestart("/tmp/evolvo")).rejects.toThrow(
      "Post-merge restart step failed: pnpm install --frozen-lockfile. Output: lockfile would be modified",
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("fails when pnpm start exits before startup timeout", async () => {
    execFileMock.mockImplementation((_command: string, _args: string[], _options: unknown, callback: (error: unknown, stdout: string, stderr: string) => void) => {
      callback(null, "", "");
    });

    const child = createChildProcessStub({
      once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (event === "exit") {
          handler(1, null);
        }
      }),
    });
    spawnMock.mockReturnValue(child);

    const { runPostMergeSelfRestart } = await import("./selfRestart.js");
    await expect(runPostMergeSelfRestart("/tmp/evolvo")).rejects.toThrow(
      "Post-merge restart failed: pnpm start exited early with code 1.",
    );
  });

  it("fails when readiness signal is not observed", async () => {
    execFileMock.mockImplementation((_command: string, _args: string[], _options: unknown, callback: (error: unknown, stdout: string, stderr: string) => void) => {
      callback(null, "", "");
    });
    const kill = vi.fn(() => true);
    const child = createChildProcessStub({ kill });
    spawnMock.mockReturnValue(child);
    waitForRuntimeReadinessSignalMock.mockRejectedValueOnce(new Error("Timed out waiting for readiness token"));

    const { runPostMergeSelfRestart } = await import("./selfRestart.js");
    await expect(runPostMergeSelfRestart("/tmp/evolvo")).rejects.toThrow(
      "Post-merge restart readiness check failed: Timed out waiting for readiness token",
    );
    expect(kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("terminates the restarted child when readiness times out", async () => {
    execFileMock.mockImplementation((_command: string, _args: string[], _options: unknown, callback: (error: unknown, stdout: string, stderr: string) => void) => {
      callback(null, "", "");
    });
    const kill = vi.fn(() => true);
    const child = createChildProcessStub({ kill });
    spawnMock.mockReturnValue(child);
    waitForRuntimeReadinessSignalMock.mockImplementation(() => new Promise(() => {}));

    const { runPostMergeSelfRestart } = await import("./selfRestart.js");
    const restartPromise = runPostMergeSelfRestart("/tmp/evolvo");
    const rejectionExpectation = expect(restartPromise).rejects.toThrow(
      "Post-merge restart readiness check failed: timed out after 15000ms",
    );

    await waitForSpawn();
    await vi.advanceTimersByTimeAsync(15000);

    await rejectionExpectation;
    expect(kill).toHaveBeenCalledWith("SIGTERM");
  });
});
