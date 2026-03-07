import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubApiError } from "./github/githubClient.js";

const runCodingAgentMock = vi.fn();
const runIssueCommandMock = vi.fn();
const getGitHubConfigMock = vi.fn();
const listOpenIssuesMock = vi.fn();
const markInProgressMock = vi.fn();
const closeIssueMock = vi.fn();
const replenishSelfImprovementIssuesMock = vi.fn();
const runPostMergeSelfRestartMock = vi.fn();

vi.mock("./environment.js", () => ({
  GITHUB_OWNER: "owner",
  GITHUB_REPO: "repo",
}));

vi.mock("./constants/workDir.js", () => ({
  WORK_DIR: "/tmp/evolvo",
}));

vi.mock("./agents/runCodingAgent.js", () => ({
  runCodingAgent: runCodingAgentMock,
}));

vi.mock("./runtime/selfRestart.js", () => ({
  runPostMergeSelfRestart: runPostMergeSelfRestartMock,
}));

vi.mock("./issues/runIssueCommand.js", () => ({
  runIssueCommand: runIssueCommandMock,
}));

vi.mock("./github/githubConfig.js", () => ({
  getGitHubConfig: getGitHubConfigMock,
}));

vi.mock("./github/githubClient.js", async () => {
  const actual = await vi.importActual<typeof import("./github/githubClient.js")>(
    "./github/githubClient.js",
  );

  return {
    ...actual,
    GitHubClient: class {},
  };
});

vi.mock("./issues/taskIssueManager.js", () => ({
  TaskIssueManager: class {
    listOpenIssues = listOpenIssuesMock;
    markInProgress = markInProgressMock;
    closeIssue = closeIssueMock;
    replenishSelfImprovementIssues = replenishSelfImprovementIssuesMock;
  },
}));

describe("main", () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.resetModules();
    runCodingAgentMock.mockReset();
    runCodingAgentMock.mockResolvedValue({ mergedPullRequest: false });
    runPostMergeSelfRestartMock.mockReset();
    runPostMergeSelfRestartMock.mockResolvedValue(undefined);
    runIssueCommandMock.mockReset();
    runIssueCommandMock.mockResolvedValue(false);
    getGitHubConfigMock.mockReset();
    getGitHubConfigMock.mockReturnValue({
      token: "token",
      owner: "owner",
      repo: "repo",
      apiBaseUrl: "https://api.github.com",
    });
    listOpenIssuesMock.mockReset();
    listOpenIssuesMock.mockResolvedValue([]);
    markInProgressMock.mockReset();
    markInProgressMock.mockResolvedValue({ ok: true, message: "ok" });
    closeIssueMock.mockReset();
    closeIssueMock.mockResolvedValue({ ok: true, message: "closed" });
    replenishSelfImprovementIssuesMock.mockReset();
    replenishSelfImprovementIssuesMock.mockResolvedValue({ created: [] });
    process.argv = ["node", "src/main.ts"];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });

  it("handles issue commands directly", async () => {
    process.argv = ["node", "src/main.ts", "issues", "list"];
    runIssueCommandMock.mockResolvedValue(true);
    const { main } = await import("./main.js");

    await main();

    expect(runIssueCommandMock).toHaveBeenCalledWith(["issues", "list"]);
    expect(runCodingAgentMock).not.toHaveBeenCalled();
    expect(listOpenIssuesMock).not.toHaveBeenCalled();
  });

  it("selects an open issue and uses it as the prompt", async () => {
    listOpenIssuesMock
      .mockResolvedValueOnce([
        { number: 12, title: "Fix login redirect", description: "Handle callback URL.", state: "open", labels: [] },
      ])
      .mockResolvedValueOnce([]);
    const { main } = await import("./main.js");

    await main();

    expect(runIssueCommandMock).toHaveBeenCalledWith([]);
    expect(markInProgressMock).toHaveBeenCalledWith(12);
    expect(runCodingAgentMock).toHaveBeenCalledWith("Issue #12: Fix login redirect\n\nHandle callback URL.");
    expect(replenishSelfImprovementIssuesMock).toHaveBeenCalledWith({ minimumIssueCount: 3, maximumOpenIssues: 5 });
  });

  it("prefers an issue already in progress", async () => {
    listOpenIssuesMock
      .mockResolvedValueOnce([
        { number: 5, title: "A", description: "A", state: "open", labels: [] },
        { number: 9, title: "B", description: "B", state: "open", labels: ["in progress"] },
      ])
      .mockResolvedValueOnce([]);
    const { main } = await import("./main.js");

    await main();

    expect(markInProgressMock).not.toHaveBeenCalled();
    expect(runCodingAgentMock).toHaveBeenCalledWith("Issue #9: B\n\nB");
  });

  it("continues to the next issue after a run completes", async () => {
    listOpenIssuesMock
      .mockResolvedValueOnce([
        { number: 7, title: "First", description: "first", state: "open", labels: [] },
      ])
      .mockResolvedValueOnce([
        { number: 8, title: "Second", description: "second", state: "open", labels: [] },
      ])
      .mockResolvedValueOnce([]);
    const { main } = await import("./main.js");

    await main();

    expect(runCodingAgentMock).toHaveBeenNthCalledWith(1, "Issue #7: First\n\nfirst");
    expect(runCodingAgentMock).toHaveBeenNthCalledWith(2, "Issue #8: Second\n\nsecond");
  });

  it("runs post-merge restart workflow when a pull request merge is detected", async () => {
    listOpenIssuesMock.mockResolvedValueOnce([
      { number: 11, title: "Restart flow", description: "Restart", state: "open", labels: [] },
    ]);
    runCodingAgentMock.mockResolvedValueOnce({ mergedPullRequest: true });
    const { main } = await import("./main.js");

    await main();

    expect(runPostMergeSelfRestartMock).toHaveBeenCalledWith("/tmp/evolvo");
  });

  it("logs restart failures clearly and exits current runtime", async () => {
    listOpenIssuesMock.mockResolvedValueOnce([
      { number: 21, title: "Restart fail path", description: "Restart", state: "open", labels: [] },
    ]);
    runCodingAgentMock.mockResolvedValueOnce({ mergedPullRequest: true });
    runPostMergeSelfRestartMock.mockRejectedValueOnce(new Error("restart failed"));
    const { main } = await import("./main.js");

    await main();

    expect(console.error).toHaveBeenCalledWith("restart failed");
  });

  it("replenishes issues and continues when queue is empty", async () => {
    listOpenIssuesMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { number: 19, title: "Generated", description: "generated", state: "open", labels: [] },
      ])
      .mockResolvedValueOnce([]);
    replenishSelfImprovementIssuesMock.mockResolvedValueOnce({
      created: [{ number: 19, title: "Generated", description: "generated", state: "open", labels: [] }],
    });
    const { DEFAULT_PROMPT, main } = await import("./main.js");

    await main();

    expect(DEFAULT_PROMPT).toBeDefined();
    expect(replenishSelfImprovementIssuesMock).toHaveBeenCalledWith({ minimumIssueCount: 3, maximumOpenIssues: 5 });
    expect(runCodingAgentMock).toHaveBeenCalledWith("Issue #19: Generated\n\ngenerated");
  });

  it("logs and exits when no issues are open and replenishment creates nothing", async () => {
    const { DEFAULT_PROMPT, main } = await import("./main.js");

    await main();

    expect(runCodingAgentMock).not.toHaveBeenCalled();
    expect(replenishSelfImprovementIssuesMock).toHaveBeenCalledWith({ minimumIssueCount: 3, maximumOpenIssues: 5 });
    expect(console.log).toHaveBeenCalledWith(DEFAULT_PROMPT);
  });

  it("closes outdated issues before selecting work", async () => {
    listOpenIssuesMock
      .mockResolvedValueOnce([
        { number: 2, title: "Old task", description: "N/A", state: "open", labels: ["outdated"] },
        { number: 3, title: "Active task", description: "Do this", state: "open", labels: [] },
      ])
      .mockResolvedValueOnce([]);
    const { main } = await import("./main.js");

    await main();

    expect(closeIssueMock).toHaveBeenCalledWith(2);
    expect(markInProgressMock).toHaveBeenCalledWith(3);
    expect(runCodingAgentMock).toHaveBeenCalledWith("Issue #3: Active task\n\nDo this");
  });

  it("does not run completed issues when no actionable work remains", async () => {
    listOpenIssuesMock.mockResolvedValue([
      { number: 4, title: "Done", description: "Done", state: "open", labels: ["completed"] },
    ]);
    const { DEFAULT_PROMPT, main } = await import("./main.js");

    await main();

    expect(runCodingAgentMock).not.toHaveBeenCalled();
    expect(markInProgressMock).not.toHaveBeenCalled();
    expect(replenishSelfImprovementIssuesMock).toHaveBeenCalledWith({ minimumIssueCount: 3, maximumOpenIssues: 5 });
  });

  it("falls back cleanly when GitHub credentials are invalid", async () => {
    listOpenIssuesMock.mockRejectedValue(
      new GitHubApiError("GitHub API request failed (401): Bad credentials", 401, null),
    );
    const { DEFAULT_PROMPT, main } = await import("./main.js");

    await main();

    expect(console.error).toHaveBeenCalledWith(
      "GitHub authentication failed. Check GITHUB_TOKEN and make sure it is a valid token for the configured repository.",
    );
    expect(console.log).toHaveBeenCalledWith(DEFAULT_PROMPT);
    expect(runCodingAgentMock).not.toHaveBeenCalled();
  });
});
