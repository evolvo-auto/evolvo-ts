import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();
const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
  spawn: spawnMock,
}));

function createChildProcessStub(overrides: {
  pid?: number;
  once?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
} = {}) {
  return {
    pid: overrides.pid ?? 999,
    once: overrides.once ?? vi.fn(),
    removeListener: overrides.removeListener ?? vi.fn(),
  };
}

describe("runPostMergeSelfRestart", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    execFileMock.mockReset();
    spawnMock.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs checkout, pull, install, build and starts runtime", async () => {
    execFileMock.mockImplementation((_command: string, _args: string[], _options: unknown, callback: (error: unknown, stdout: string, stderr: string) => void) => {
      callback(null, "", "");
    });
    const onceHandlers: Record<string, (...args: unknown[]) => void> = {};
    const child = createChildProcessStub({
      once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        onceHandlers[event] = handler;
      }),
    });
    spawnMock.mockReturnValue(child);

    const { runPostMergeSelfRestart } = await import("./selfRestart.js");
    const restartPromise = runPostMergeSelfRestart("/tmp/evolvo");
    await vi.advanceTimersByTimeAsync(3000);
    await expect(restartPromise).resolves.toBeUndefined();

    expect(execFileMock).toHaveBeenNthCalledWith(1, "git", ["checkout", "main"], { cwd: "/tmp/evolvo" }, expect.any(Function));
    expect(execFileMock).toHaveBeenNthCalledWith(2, "git", ["pull", "--ff-only"], { cwd: "/tmp/evolvo" }, expect.any(Function));
    expect(execFileMock).toHaveBeenNthCalledWith(3, "pnpm", ["i"], { cwd: "/tmp/evolvo" }, expect.any(Function));
    expect(execFileMock).toHaveBeenNthCalledWith(4, "pnpm", ["build"], { cwd: "/tmp/evolvo" }, expect.any(Function));
    expect(spawnMock).toHaveBeenCalledWith("pnpm", ["start"], {
      cwd: "/tmp/evolvo",
      detached: false,
      stdio: "inherit",
    });
    expect(onceHandlers.error).toBeTypeOf("function");
    expect(onceHandlers.exit).toBeTypeOf("function");
  });

  it("fails with diagnostics when a restart step command fails", async () => {
    execFileMock.mockImplementationOnce((_command: string, _args: string[], _options: unknown, callback: (error: unknown, stdout: string, stderr: string) => void) => {
      const error = Object.assign(new Error("failed"), { stderr: "checkout failed" });
      callback(error, "", "checkout failed");
    });

    const { runPostMergeSelfRestart } = await import("./selfRestart.js");

    await expect(runPostMergeSelfRestart("/tmp/evolvo")).rejects.toThrow(
      "Post-merge restart step failed: git checkout main. Output: checkout failed",
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
});
