import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ensureProjectRegistryMock = vi.fn();
const ensureProjectBoardsForRegistryMock = vi.fn();
const writeRuntimeReadinessSignalMock = vi.fn();
const runDiscordOperatorControlStartupCheckMock = vi.fn();
const startDiscordGracefulShutdownListenerMock = vi.fn();

vi.mock("../projects/projectRegistry.js", () => ({
  ensureProjectRegistry: ensureProjectRegistryMock,
}));

vi.mock("../projects/projectBoards.js", () => ({
  ensureProjectBoardsForRegistry: ensureProjectBoardsForRegistryMock,
}));

vi.mock("./runtimeReadiness.js", () => ({
  writeRuntimeReadinessSignal: writeRuntimeReadinessSignalMock,
}));

vi.mock("./operatorControl.js", () => ({
  runDiscordOperatorControlStartupCheck: runDiscordOperatorControlStartupCheckMock,
  startDiscordGracefulShutdownListener: startDiscordGracefulShutdownListenerMock,
}));

describe("runtimeStartup", () => {
  beforeEach(() => {
    ensureProjectRegistryMock.mockReset();
    ensureProjectRegistryMock.mockResolvedValue(undefined);
    ensureProjectBoardsForRegistryMock.mockReset();
    ensureProjectBoardsForRegistryMock.mockResolvedValue({
      results: [],
    });
    writeRuntimeReadinessSignalMock.mockReset();
    writeRuntimeReadinessSignalMock.mockResolvedValue("/tmp/evolvo/.evolvo/runtime-readiness.json");
    runDiscordOperatorControlStartupCheckMock.mockReset();
    runDiscordOperatorControlStartupCheckMock.mockResolvedValue(undefined);
    startDiscordGracefulShutdownListenerMock.mockReset();
    startDiscordGracefulShutdownListenerMock.mockResolvedValue({
      stop: vi.fn().mockResolvedValue(undefined),
    });
    delete process.env.EVOLVO_RESTART_TOKEN;
    delete process.env.EVOLVO_READINESS_FILE;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.EVOLVO_RESTART_TOKEN;
    delete process.env.EVOLVO_READINESS_FILE;
  });

  it("runs startup sequencing and returns the graceful-shutdown listener", async () => {
    ensureProjectBoardsForRegistryMock.mockResolvedValue({
      results: [
        {
          ok: true,
          project: {
            slug: "evolvo",
            workflow: {
              boardUrl: "https://github.com/orgs/Evolvo-org/projects/1",
            },
          },
        },
      ],
    });
    const { runRuntimeStartup } = await import("./runtimeStartup.js");

    const listener = await runRuntimeStartup({
      workDir: "/tmp/evolvo",
      githubOwner: "owner",
      githubRepo: "repo",
      defaultProjectContext: {
        owner: "owner",
        repo: "repo",
        workDir: "/tmp/evolvo",
      },
      projectsClient: {} as never,
      discordHandlers: {},
    });

    expect(listener).not.toBeNull();
    expect(ensureProjectRegistryMock).toHaveBeenCalledWith("/tmp/evolvo", {
      owner: "owner",
      repo: "repo",
      workDir: "/tmp/evolvo",
    });
    expect(ensureProjectBoardsForRegistryMock).toHaveBeenCalledTimes(1);
    expect(runDiscordOperatorControlStartupCheckMock).toHaveBeenCalledTimes(1);
    expect(startDiscordGracefulShutdownListenerMock).toHaveBeenCalledWith("/tmp/evolvo", {});
    expect(console.log).toHaveBeenCalledWith("Hello from owner/repo!");
    expect(console.log).toHaveBeenCalledWith("Working directory: /tmp/evolvo");
    expect(console.log).toHaveBeenCalledWith(
      "[project-board] ensured evolvo board https://github.com/orgs/Evolvo-org/projects/1.",
    );
  });

  it("writes restart readiness signal when restart token is configured", async () => {
    process.env.EVOLVO_RESTART_TOKEN = "restart-token";
    process.env.EVOLVO_READINESS_FILE = "/tmp/evolvo/.evolvo/runtime-readiness.json";
    const { runRuntimeStartup } = await import("./runtimeStartup.js");

    await runRuntimeStartup({
      workDir: "/tmp/evolvo",
      githubOwner: "owner",
      githubRepo: "repo",
      defaultProjectContext: {
        owner: "owner",
        repo: "repo",
        workDir: "/tmp/evolvo",
      },
      projectsClient: {} as never,
      discordHandlers: {},
    });

    expect(writeRuntimeReadinessSignalMock).toHaveBeenCalledWith({
      workDir: "/tmp/evolvo",
      token: "restart-token",
      signalPath: "/tmp/evolvo/.evolvo/runtime-readiness.json",
    });
  });
});
