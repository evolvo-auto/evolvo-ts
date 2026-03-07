import { beforeEach, describe, expect, it, vi } from "vitest";

const threadRunMock = vi.fn();
const startThreadMock = vi.fn(() => ({
  run: threadRunMock,
}));

vi.mock("@openai/codex-sdk", () => ({
  Codex: class {
    public startThread = startThreadMock;
  },
}));

describe("plannerAgent", () => {
  beforeEach(() => {
    startThreadMock.mockClear();
    threadRunMock.mockReset();
  });

  it("uses Codex repo analysis and creates exact planned issues on startup", async () => {
    threadRunMock.mockResolvedValueOnce({
      finalResponse: JSON.stringify({
        issues: [
          { title: "Stabilize lifecycle transition retries", description: "Tighten lifecycle transition retry behavior." },
          { title: "Add runtime restart readiness timeout coverage", description: "Cover delayed restart readiness failures." },
        ],
      }),
    });
    const createPlannedIssuesMock = vi.fn().mockResolvedValueOnce({
      created: [{ number: 11, title: "Stabilize lifecycle transition retries", description: "Tighten lifecycle transition retry behavior.", state: "open", labels: [] }],
    });
    const issueManager = {
      listOpenIssues: vi.fn().mockResolvedValueOnce([]),
      listRecentClosedIssues: vi.fn().mockResolvedValueOnce([]),
      createPlannedIssues: createPlannedIssuesMock,
    } as unknown as import("../issues/taskIssueManager.js").TaskIssueManager;
    const { runPlannerAgent } = await import("./plannerAgent.js");

    const result = await runPlannerAgent({
      cycle: 1,
      openIssueCount: 0,
      minimumIssueCount: 3,
      maximumOpenIssues: 5,
      issueManager,
      workDir: "/tmp/evolvo",
    });

    expect(result.startupBootstrap).toBe(true);
    expect(startThreadMock).toHaveBeenCalledWith(expect.objectContaining({
      workingDirectory: "/tmp/evolvo",
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
    }));
    expect(createPlannedIssuesMock).toHaveBeenCalledWith({
      minimumIssueCount: 3,
      maximumOpenIssues: 5,
      issues: [
        { title: "Stabilize lifecycle transition retries", description: "Tighten lifecycle transition retry behavior." },
        { title: "Add runtime restart readiness timeout coverage", description: "Cover delayed restart readiness failures." },
      ],
    });
    expect(result.created).toEqual([
      { number: 11, title: "Stabilize lifecycle transition retries", description: "Tighten lifecycle transition retry behavior.", state: "open", labels: [] },
    ]);
  });

  it("deduplicates repeated planner titles before creating issues", async () => {
    threadRunMock.mockResolvedValueOnce({
      finalResponse: JSON.stringify({
        issues: [
          { title: "Harden planner duplicate filtering", description: "Use recent issue history to prevent repeats." },
          { title: "Harden planner duplicate filtering", description: "This duplicate should be ignored." },
          { title: "Improve Codex planner diagnostics", description: "Capture planner failures with clearer logs." },
        ],
      }),
    });
    const createPlannedIssuesMock = vi.fn().mockResolvedValueOnce({ created: [] });
    const issueManager = {
      listOpenIssues: vi.fn().mockResolvedValueOnce([]),
      listRecentClosedIssues: vi.fn().mockResolvedValueOnce([]),
      createPlannedIssues: createPlannedIssuesMock,
    } as unknown as import("../issues/taskIssueManager.js").TaskIssueManager;
    const { runPlannerAgent } = await import("./plannerAgent.js");

    await runPlannerAgent({
      cycle: 2,
      openIssueCount: 0,
      minimumIssueCount: 3,
      maximumOpenIssues: 5,
      issueManager,
      workDir: "/tmp/evolvo",
    });

    expect(createPlannedIssuesMock).toHaveBeenCalledWith({
      minimumIssueCount: 3,
      maximumOpenIssues: 5,
      issues: [
        { title: "Harden planner duplicate filtering", description: "Use recent issue history to prevent repeats." },
        { title: "Improve Codex planner diagnostics", description: "Capture planner failures with clearer logs." },
      ],
    });
  });

  it("skips malformed planner issue drafts and logs diagnostics", async () => {
    threadRunMock.mockResolvedValueOnce({
      finalResponse: JSON.stringify({
        issues: [
          null,
          { title: 42, description: "Not valid title type." },
          { title: "   ", description: "Missing title text." },
          { title: "Valid planner draft", description: "  Keep this one after trimming. " },
          { title: "Valid planner draft", description: "Duplicate title should be ignored." },
          { title: "Second valid planner draft", description: "Also valid." },
        ],
      }),
    });
    const createPlannedIssuesMock = vi.fn().mockResolvedValueOnce({ created: [] });
    const issueManager = {
      listOpenIssues: vi.fn().mockResolvedValueOnce([]),
      listRecentClosedIssues: vi.fn().mockResolvedValueOnce([]),
      createPlannedIssues: createPlannedIssuesMock,
    } as unknown as import("../issues/taskIssueManager.js").TaskIssueManager;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runPlannerAgent } = await import("./plannerAgent.js");

    await runPlannerAgent({
      cycle: 2,
      openIssueCount: 0,
      minimumIssueCount: 3,
      maximumOpenIssues: 5,
      issueManager,
      workDir: "/tmp/evolvo",
    });

    expect(warnSpy).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenNthCalledWith(1, "Planner returned invalid issue draft at index 0: expected an object.");
    expect(warnSpy).toHaveBeenNthCalledWith(2, "Planner returned invalid issue draft at index 1: title and description must be strings.");
    expect(warnSpy).toHaveBeenNthCalledWith(3, "Planner returned invalid issue draft at index 2: title and description cannot be empty.");
    expect(createPlannedIssuesMock).toHaveBeenCalledWith({
      minimumIssueCount: 3,
      maximumOpenIssues: 5,
      issues: [
        { title: "Valid planner draft", description: "Keep this one after trimming." },
        { title: "Second valid planner draft", description: "Also valid." },
      ],
    });
    warnSpy.mockRestore();
  });

  it("returns no created issues when planner analysis fails", async () => {
    threadRunMock.mockRejectedValueOnce(new Error("planner failed"));
    const createPlannedIssuesMock = vi.fn();
    const issueManager = {
      listOpenIssues: vi.fn().mockResolvedValueOnce([]),
      listRecentClosedIssues: vi.fn().mockResolvedValueOnce([]),
      createPlannedIssues: createPlannedIssuesMock,
    } as unknown as import("../issues/taskIssueManager.js").TaskIssueManager;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { runPlannerAgent } = await import("./plannerAgent.js");

    const result = await runPlannerAgent({
      cycle: 2,
      openIssueCount: 1,
      minimumIssueCount: 3,
      maximumOpenIssues: 5,
      issueManager,
      workDir: "/tmp/evolvo",
    });

    expect(errorSpy).toHaveBeenCalledWith("Queue repository analysis failed during replenishment planning: planner failed");
    expect(createPlannedIssuesMock).not.toHaveBeenCalled();
    expect(result).toEqual({ created: [], startupBootstrap: false });
  });
});
