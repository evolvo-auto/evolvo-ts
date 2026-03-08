import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runIssueCommandMock = vi.fn();
const runRuntimeAppMock = vi.fn();
const runWorkflowWorkerCommandMock = vi.fn();

vi.mock("./environment.js", () => ({
  GITHUB_OWNER: "owner",
  GITHUB_REPO: "repo",
}));

vi.mock("./issues/runIssueCommand.js", () => ({
  runIssueCommand: runIssueCommandMock,
}));

vi.mock("./runtime/runRuntimeApp.js", () => ({
  runRuntimeApp: runRuntimeAppMock,
}));

vi.mock("./runtime/workers/runWorkflowWorker.js", () => ({
  runWorkflowWorkerCommand: runWorkflowWorkerCommandMock,
}));

describe("main", () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.resetModules();
    process.argv = ["node", "test-runner.ts"];
    runIssueCommandMock.mockReset();
    runIssueCommandMock.mockResolvedValue(false);
    runRuntimeAppMock.mockReset();
    runRuntimeAppMock.mockResolvedValue(undefined);
    runWorkflowWorkerCommandMock.mockReset();
    runWorkflowWorkerCommandMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });

  it("handles issue commands directly", async () => {
    runIssueCommandMock.mockResolvedValue(true);
    const { main } = await import("./main.js");

    process.argv = ["node", "src/main.ts", "issues", "list"];

    await main();

    expect(runIssueCommandMock).toHaveBeenCalledWith(["issues", "list"]);
    expect(runRuntimeAppMock).not.toHaveBeenCalled();
  });

  it("delegates to the runtime app when no issue command handled the invocation", async () => {
    const { main } = await import("./main.js");

    await main();

    expect(runIssueCommandMock).toHaveBeenCalledWith([]);
    expect(runRuntimeAppMock).toHaveBeenCalledWith({
      githubOwner: "owner",
      githubRepo: "repo",
    });
  });

  it("re-exports the loop default prompt", async () => {
    const { DEFAULT_PROMPT } = await import("./main.js");

    expect(DEFAULT_PROMPT).toBe("No open issues available. Create an issue first.");
  });

  it("routes worker commands to the workflow worker runner", async () => {
    process.argv = ["node", "src/main.ts", "worker", "dev", "habit-cli"];
    const { main } = await import("./main.js");

    await main();

    expect(runWorkflowWorkerCommandMock).toHaveBeenCalledWith({
      role: "dev",
      projectSlug: "habit-cli",
    });
    expect(runIssueCommandMock).not.toHaveBeenCalled();
    expect(runRuntimeAppMock).not.toHaveBeenCalled();
  });
});
