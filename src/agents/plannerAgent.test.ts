import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runPlannerOpenAiMock = vi.fn();

vi.mock("../environment.js", () => ({
  OPENAI_API_KEY: "planner-openai-key",
}));

vi.mock("./plannerOpenAi.js", () => ({
  runPlannerOpenAi: runPlannerOpenAiMock,
}));

describe("plannerAgent", () => {
  beforeEach(() => {
    vi.resetModules();
    runPlannerOpenAiMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses direct OpenAI planner analysis and creates exact planned issues on startup", async () => {
    runPlannerOpenAiMock.mockResolvedValueOnce({
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
    expect(runPlannerOpenAiMock).toHaveBeenCalledWith({
      apiKey: "planner-openai-key",
      prompt: expect.stringContaining("Inspect this repository and propose new GitHub issues for Evolvo."),
      workDir: "/tmp/evolvo",
    });
    expect(issueManager.listRecentClosedIssues).toHaveBeenCalledWith(300);
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

  it("deduplicates repeated planner titles after follow-up normalization before creating issues", async () => {
    runPlannerOpenAiMock.mockResolvedValueOnce({
      finalResponse: JSON.stringify({
        issues: [
          { title: "Harden planner duplicate filtering", description: "Use recent issue history to prevent repeats." },
          {
            title: "Harden planner duplicate filtering (follow-up 1)",
            description: "This follow-up variant should also be ignored.",
          },
          { title: "Improve planner API diagnostics", description: "Capture planner failures with clearer logs." },
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
        { title: "Improve planner API diagnostics", description: "Capture planner failures with clearer logs." },
      ],
    });
  });

  it("deduplicates repeated closed-issue follow-ups before applying the 25-item prompt cap", async () => {
    runPlannerOpenAiMock.mockResolvedValueOnce({
      finalResponse: JSON.stringify({ issues: [] }),
    });
    const createPlannedIssuesMock = vi.fn().mockResolvedValueOnce({ created: [] });
    const repeatedFollowUps = Array.from({ length: 30 }, (_, index) => ({
      number: 2000 + index,
      title: `Startup bootstrap reliability hardening (follow-up ${index + 1})`,
      description: "Repeated thread title with follow-up suffix.",
      state: "closed" as const,
      labels: [],
    }));
    const diverseHistory = Array.from({ length: 30 }, (_, index) => ({
      number: 3000 + index,
      title: `Diverse closed issue ${index + 1}`,
      description: "Distinct historical signal.",
      state: "closed" as const,
      labels: [],
    }));
    const issueManager = {
      listOpenIssues: vi.fn().mockResolvedValueOnce([]),
      listRecentClosedIssues: vi.fn().mockResolvedValueOnce([...repeatedFollowUps, ...diverseHistory]),
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

    const plannerPrompt = runPlannerOpenAiMock.mock.calls[0]?.[0]?.prompt as string;
    const recentlyClosedSection = plannerPrompt
      .split("Recently closed issues:\n")[1]
      ?.split("\n\nReturn only structured JSON matching the schema.")[0] ?? "";
    const recentClosedLines = recentlyClosedSection.split("\n").filter((line) => line.startsWith("- #"));

    expect(recentClosedLines).toHaveLength(25);
    expect(plannerPrompt.match(/Startup bootstrap reliability hardening/gi)).toHaveLength(1);
    expect(plannerPrompt).toContain("Diverse closed issue 24");
    expect(plannerPrompt).not.toContain("Diverse closed issue 25");
    expect(createPlannedIssuesMock).toHaveBeenCalledWith({
      minimumIssueCount: 3,
      maximumOpenIssues: 5,
      issues: [],
    });
  });

  it("skips malformed planner issue drafts and logs diagnostics", async () => {
    runPlannerOpenAiMock.mockResolvedValueOnce({
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

  it("persists replenishment failure artifacts with planner prompt and raw final response", async () => {
    const rawFinalResponse = JSON.stringify({ result: [] });
    runPlannerOpenAiMock.mockResolvedValueOnce({
      finalResponse: rawFinalResponse,
    });
    const createPlannedIssuesMock = vi.fn();
    const issueManager = {
      listOpenIssues: vi.fn().mockResolvedValueOnce([
        { number: 17, title: "Open reliability gap", description: "Still open.", state: "open", labels: [] },
      ]),
      listRecentClosedIssues: vi.fn().mockResolvedValueOnce([
        { number: 16, title: "Closed planning fix", description: "Already done.", state: "closed", labels: [] },
      ]),
      createPlannedIssues: createPlannedIssuesMock,
    } as unknown as import("../issues/taskIssueManager.js").TaskIssueManager;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { runPlannerAgent } = await import("./plannerAgent.js");
    const workDir = await mkdtemp(join(tmpdir(), "planner-agent-"));

    try {
      const result = await runPlannerAgent({
        cycle: 2,
        openIssueCount: 1,
        minimumIssueCount: 3,
        maximumOpenIssues: 5,
        issueManager,
        workDir,
      });

      const artifactPath = join(workDir, ".evolvo", "planner-replenishment-failure.json");
      const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as {
        schemaVersion: number;
        cycle: number;
        openIssueCount: number;
        startupBootstrap: boolean;
        plannerPrompt: string | null;
        finalResponse: string | null;
        error: {
          name: string;
          message: string;
          stack: string | null;
        };
      };

      expect(artifact.schemaVersion).toBe(1);
      expect(artifact.cycle).toBe(2);
      expect(artifact.openIssueCount).toBe(1);
      expect(artifact.startupBootstrap).toBe(false);
      expect(artifact.plannerPrompt).toContain("Current open issues:\n- #17 Open reliability gap");
      expect(artifact.plannerPrompt).toContain("Recently closed issues:\n- #16 Closed planning fix");
      expect(artifact.finalResponse).toBe(rawFinalResponse);
      expect(artifact.error.name).toBe("Error");
      expect(artifact.error.message).toBe("Planner response did not contain an issues array.");
      expect(typeof artifact.error.stack).toBe("string");
      expect(errorSpy).toHaveBeenNthCalledWith(
        1,
        "Queue repository analysis failed during replenishment planning: Planner response did not contain an issues array.",
      );
      expect(errorSpy).toHaveBeenNthCalledWith(
        2,
        "Planner replenishment failure artifact saved to `.evolvo/planner-replenishment-failure.json`.",
      );
      expect(createPlannedIssuesMock).not.toHaveBeenCalled();
      expect(result).toEqual({ created: [], startupBootstrap: false });
    } finally {
      errorSpy.mockRestore();
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("returns no created issues when planner analysis fails", async () => {
    runPlannerOpenAiMock.mockRejectedValueOnce(new Error("planner failed"));
    const createPlannedIssuesMock = vi.fn();
    const issueManager = {
      listOpenIssues: vi.fn().mockResolvedValueOnce([]),
      listRecentClosedIssues: vi.fn().mockResolvedValueOnce([]),
      createPlannedIssues: createPlannedIssuesMock,
    } as unknown as import("../issues/taskIssueManager.js").TaskIssueManager;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { runPlannerAgent } = await import("./plannerAgent.js");
    const workDir = await mkdtemp(join(tmpdir(), "planner-agent-"));

    try {
      const result = await runPlannerAgent({
        cycle: 2,
        openIssueCount: 1,
        minimumIssueCount: 3,
        maximumOpenIssues: 5,
        issueManager,
        workDir,
      });

      const artifact = JSON.parse(
        await readFile(join(workDir, ".evolvo", "planner-replenishment-failure.json"), "utf8"),
      ) as {
        plannerPrompt: string | null;
        finalResponse: string | null;
        error: {
          message: string;
        };
      };

      expect(errorSpy).toHaveBeenNthCalledWith(1, "Queue repository analysis failed during replenishment planning: planner failed");
      expect(errorSpy).toHaveBeenNthCalledWith(
        2,
        "Planner replenishment failure artifact saved to `.evolvo/planner-replenishment-failure.json`.",
      );
      expect(artifact.plannerPrompt).toContain("Current open issues:\n- none");
      expect(artifact.finalResponse).toBeNull();
      expect(artifact.error.message).toBe("planner failed");
      expect(createPlannedIssuesMock).not.toHaveBeenCalled();
      expect(result).toEqual({ created: [], startupBootstrap: false });
    } finally {
      errorSpy.mockRestore();
      await rm(workDir, { recursive: true, force: true });
    }
  });
});
