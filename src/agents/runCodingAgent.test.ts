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
    ).resolves.toEqual({ mergedPullRequest: false });

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
    ).resolves.toEqual({ mergedPullRequest: false });
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

    await expect(runCodingAgent("Merge and continue")).resolves.toEqual({ mergedPullRequest: true });
  });
});
