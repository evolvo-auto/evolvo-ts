import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const startThreadMock = vi.fn();
const runStreamedMock = vi.fn();
const buildCodingPromptMock = vi.fn((task: string) => `PROMPT:${task}`);

vi.mock("@openai/codex-sdk", () => ({
  Codex: class {
    startThread = startThreadMock;
  },
  Thread: class {},
}));

vi.mock("./codingAgent.js", () => ({
  CODING_AGENT_THREAD_OPTIONS: { sandboxMode: "workspace-write" },
  buildCodingPrompt: buildCodingPromptMock,
}));

function createEventStream(events: unknown[]) {
  return {
    events: (async function* () {
      for (const event of events) {
        yield event;
      }
    })(),
  };
}

describe("runCodingAgent", () => {
  beforeEach(() => {
    startThreadMock.mockReset();
    runStreamedMock.mockReset();
    buildCodingPromptMock.mockClear();
    vi.resetModules();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("starts a thread and succeeds when a file change is completed", async () => {
    startThreadMock.mockReturnValue({ runStreamed: runStreamedMock });
    runStreamedMock.mockResolvedValue(createEventStream([
      {
        type: "item.completed",
        item: {
          id: "1",
          type: "file_change",
          status: "completed",
          changes: [{ kind: "add", path: "src/utils/add.ts" }],
        },
      },
      {
        type: "item.completed",
        item: {
          id: "2",
          type: "agent_message",
          text: "done",
        },
      },
    ]));

    const { runCodingAgent } = await import("./runCodingAgent.js");

    await expect(
      runCodingAgent("Create src/utils/add.ts"),
    ).resolves.toEqual(
      expect.objectContaining({
        mergedPullRequest: false,
        summary: expect.objectContaining({
          editedFiles: ["src/utils/add.ts"],
        }),
      }),
    );

    expect(startThreadMock).toHaveBeenCalledTimes(1);
    expect(runStreamedMock).toHaveBeenCalledWith("PROMPT:Create src/utils/add.ts");
  });

  it("throws when a file edit request completes without repository edits", async () => {
    startThreadMock.mockReturnValue({ runStreamed: runStreamedMock });
    runStreamedMock.mockResolvedValue(createEventStream([
      {
        type: "item.completed",
        item: {
          id: "1",
          type: "agent_message",
          text: "I did it",
        },
      },
    ]));

    const { runCodingAgent } = await import("./runCodingAgent.js");

    await expect(
      runCodingAgent("Create src/utils/add.ts"),
    ).rejects.toThrow("The Codex run did not make repository edits");
  });

  it("does not throw for non-edit prompts without file changes", async () => {
    startThreadMock.mockReturnValue({ runStreamed: runStreamedMock });
    runStreamedMock.mockResolvedValue(createEventStream([
      {
        type: "item.completed",
        item: {
          id: "1",
          type: "agent_message",
          text: "summary",
        },
      },
    ]));

    const { runCodingAgent } = await import("./runCodingAgent.js");

    await expect(
      runCodingAgent("Summarize the repository"),
    ).resolves.toEqual(
      expect.objectContaining({
        mergedPullRequest: false,
        summary: expect.objectContaining({
          reviewOutcome: "accepted",
        }),
      }),
    );
  });

  it("flags successful pull request merges from command events", async () => {
    startThreadMock.mockReturnValue({ runStreamed: runStreamedMock });
    runStreamedMock.mockResolvedValue(createEventStream([
      {
        type: "item.completed",
        item: {
          id: "1",
          type: "command_execution",
          command: "gh pr merge 15 --merge --delete-branch",
          exit_code: 0,
          aggregated_output: "Merged",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "2",
          type: "agent_message",
          text: "done",
        },
      },
    ]));

    const { runCodingAgent } = await import("./runCodingAgent.js");

    await expect(runCodingAgent("Merge and continue")).resolves.toEqual(
      expect.objectContaining({
        mergedPullRequest: true,
        summary: expect.objectContaining({
          reviewOutcome: "accepted",
        }),
      }),
    );
  });

  it("logs command, exit code, and duration for command executions", async () => {
    startThreadMock.mockReturnValue({ runStreamed: runStreamedMock });
    runStreamedMock.mockResolvedValue(createEventStream([
      {
        type: "item.started",
        item: {
          id: "1",
          type: "command_execution",
          command: "pnpm validate",
          aggregated_output: "",
          status: "in_progress",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "1",
          type: "command_execution",
          command: "pnpm validate",
          exit_code: 1,
          aggregated_output: "failed",
          status: "failed",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "2",
          type: "agent_message",
          text: "Validation failed, fix pending.",
        },
      },
    ]));

    vi.spyOn(Date, "now")
      .mockReturnValueOnce(1000)
      .mockReturnValue(1450);

    const { runCodingAgent } = await import("./runCodingAgent.js");

    await expect(runCodingAgent("Run validation")).resolves.toEqual(
      expect.objectContaining({
        mergedPullRequest: false,
        summary: expect.objectContaining({
          validationCommands: [
            expect.objectContaining({
              command: "pnpm validate",
              exitCode: 1,
            }),
          ],
          reviewOutcome: "amended",
        }),
      }),
    );

    expect(console.log).toHaveBeenCalledWith(
      "[command completed] command=\"pnpm validate\" name=pnpm exit=1 duration=450ms",
    );
  });

  it("does not infer pull request merges from agent messages alone", async () => {
    startThreadMock.mockReturnValue({ runStreamed: runStreamedMock });
    runStreamedMock.mockResolvedValue(createEventStream([
      {
        type: "item.completed",
        item: {
          id: "1",
          type: "agent_message",
          text: "I merged the pull request into main and stopped for host restart.",
        },
      },
    ]));

    const { runCodingAgent } = await import("./runCodingAgent.js");

    await expect(runCodingAgent("Merge and continue")).resolves.toEqual(
      expect.objectContaining({
        mergedPullRequest: false,
        summary: expect.objectContaining({
          reviewOutcome: "accepted",
        }),
      }),
    );
  });

  it("tracks pull request creation from successful gh command execution", async () => {
    startThreadMock.mockReturnValue({ runStreamed: runStreamedMock });
    runStreamedMock.mockResolvedValue(createEventStream([
      {
        type: "item.completed",
        item: {
          id: "1",
          type: "command_execution",
          command: "gh pr create --title \"self\" --body \"self\"",
          exit_code: 0,
          aggregated_output: "https://github.com/owner/repo/pull/88",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "2",
          type: "file_change",
          status: "completed",
          changes: [{ kind: "add", path: "notes.md" }],
        },
      },
    ]));

    const { runCodingAgent } = await import("./runCodingAgent.js");
    const result = await runCodingAgent("Create self repository pull request");

    expect(result.summary.pullRequestCreated).toBe(true);
  });

  it("captures external repository and pull request evidence from command output", async () => {
    vi.stubEnv("GITHUB_OWNER", "owner");
    vi.stubEnv("GITHUB_REPO", "repo");
    startThreadMock.mockReturnValue({ runStreamed: runStreamedMock });
    runStreamedMock.mockResolvedValue(createEventStream([
      {
        type: "item.completed",
        item: {
          id: "1",
          type: "command_execution",
          command: "gh pr create --repo other-org/other-repo --title \"test\" --body \"test\"",
          exit_code: 0,
          aggregated_output: "https://github.com/other-org/other-repo/pull/12",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "2",
          type: "command_execution",
          command: "gh pr merge https://github.com/other-org/other-repo/pull/12 --merge",
          exit_code: 0,
          aggregated_output: "Merged pull request https://github.com/other-org/other-repo/pull/12",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "3",
          type: "file_change",
          status: "completed",
          changes: [{ kind: "add", path: "notes.md" }],
        },
      },
      {
        type: "item.completed",
        item: {
          id: "4",
          type: "agent_message",
          text: "done",
        },
      },
    ]));

    const { runCodingAgent } = await import("./runCodingAgent.js");

    await expect(runCodingAgent("Complete external repo workflow")).resolves.toEqual(
      expect.objectContaining({
        mergedPullRequest: true,
        summary: expect.objectContaining({
          pullRequestCreated: true,
          externalRepositories: ["https://github.com/other-org/other-repo"],
          externalPullRequests: ["https://github.com/other-org/other-repo/pull/12"],
          mergedExternalPullRequest: true,
        }),
      }),
    );
  });

  it("tracks external pull request merge from structured gh repo arguments", async () => {
    vi.stubEnv("GITHUB_OWNER", "owner");
    vi.stubEnv("GITHUB_REPO", "repo");
    startThreadMock.mockReturnValue({ runStreamed: runStreamedMock });
    runStreamedMock.mockResolvedValue(createEventStream([
      {
        type: "item.completed",
        item: {
          id: "1",
          type: "command_execution",
          command: "gh pr merge 12 --repo other-org/other-repo --merge",
          exit_code: 0,
          aggregated_output: "Merged.",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "2",
          type: "file_change",
          status: "completed",
          changes: [{ kind: "add", path: "notes.md" }],
        },
      },
    ]));

    const { runCodingAgent } = await import("./runCodingAgent.js");
    const result = await runCodingAgent("Complete external repo workflow");

    expect(result.mergedPullRequest).toBe(true);
    expect(result.summary.mergedExternalPullRequest).toBe(true);
    expect(result.summary.externalRepositories).toContain("https://github.com/other-org/other-repo");
  });

  it("does not treat arbitrary command text as validation execution", async () => {
    startThreadMock.mockReturnValue({ runStreamed: runStreamedMock });
    runStreamedMock.mockResolvedValue(createEventStream([
      {
        type: "item.started",
        item: {
          id: "1",
          type: "command_execution",
          command: "echo test checklist",
          aggregated_output: "",
          status: "in_progress",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "1",
          type: "command_execution",
          command: "echo test checklist",
          exit_code: 0,
          aggregated_output: "test checklist",
          status: "completed",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "2",
          type: "agent_message",
          text: "done",
        },
      },
    ]));

    const { runCodingAgent } = await import("./runCodingAgent.js");
    const result = await runCodingAgent("Summarize the repository");

    expect(result.summary.validationCommands).toEqual([]);
    expect(result.summary.failedValidationCommands).toEqual([]);
  });

  it("does not capture pull requests from the configured repository as external evidence", async () => {
    vi.stubEnv("GITHUB_OWNER", "owner");
    vi.stubEnv("GITHUB_REPO", "repo");
    startThreadMock.mockReturnValue({ runStreamed: runStreamedMock });
    runStreamedMock.mockResolvedValue(createEventStream([
      {
        type: "item.completed",
        item: {
          id: "1",
          type: "command_execution",
          command: "gh pr create --title \"self\" --body \"self\"",
          exit_code: 0,
          aggregated_output: "https://github.com/owner/repo/pull/88",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "2",
          type: "file_change",
          status: "completed",
          changes: [{ kind: "add", path: "notes.md" }],
        },
      },
    ]));

    const { runCodingAgent } = await import("./runCodingAgent.js");
    const result = await runCodingAgent("Create self repository pull request");

    expect(result.summary.externalRepositories).toEqual([]);
    expect(result.summary.externalPullRequests).toEqual([]);
    expect(result.summary.mergedExternalPullRequest).toBe(false);
  });
});
