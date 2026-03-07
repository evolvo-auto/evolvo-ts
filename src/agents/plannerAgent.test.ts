import { beforeEach, describe, expect, it, vi } from "vitest";

const bootstrapStartupIssuesMock = vi.fn();
const generateStartupIssueTemplatesMock = vi.fn();

vi.mock("../runtime/loopUtils.js", () => ({
  bootstrapStartupIssues: bootstrapStartupIssuesMock,
}));

vi.mock("../issues/startupIssueBootstrap.js", () => ({
  generateStartupIssueTemplates: generateStartupIssueTemplatesMock,
}));

describe("plannerAgent", () => {
  beforeEach(() => {
    bootstrapStartupIssuesMock.mockReset();
    generateStartupIssueTemplatesMock.mockReset();
  });

  it("uses startup bootstrap planner path for cycle 1 empty queue", async () => {
    bootstrapStartupIssuesMock.mockResolvedValueOnce([{ number: 11, title: "A", description: "a", state: "open", labels: [] }]);
    const issueManager = {
      replenishSelfImprovementIssues: vi.fn(),
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
    expect(result.created).toEqual([{ number: 11, title: "A", description: "a", state: "open", labels: [] }]);
    expect(bootstrapStartupIssuesMock).toHaveBeenCalledWith(issueManager, "/tmp/evolvo");
    expect(generateStartupIssueTemplatesMock).not.toHaveBeenCalled();
  });

  it("uses repository analysis templates for non-startup planner replenishment", async () => {
    generateStartupIssueTemplatesMock.mockResolvedValueOnce([
      { title: "Planned A", description: "A" },
      { title: "Planned B", description: "B" },
    ]);
    const replenishMock = vi.fn().mockResolvedValueOnce({
      created: [{ number: 21, title: "Planned A", description: "A", state: "open", labels: [] }],
    });
    const issueManager = {
      replenishSelfImprovementIssues: replenishMock,
    } as unknown as import("../issues/taskIssueManager.js").TaskIssueManager;
    const { runPlannerAgent } = await import("./plannerAgent.js");

    const result = await runPlannerAgent({
      cycle: 2,
      openIssueCount: 0,
      minimumIssueCount: 3,
      maximumOpenIssues: 5,
      issueManager,
      workDir: "/tmp/evolvo",
    });

    expect(result.startupBootstrap).toBe(false);
    expect(generateStartupIssueTemplatesMock).toHaveBeenCalledWith("/tmp/evolvo", { targetCount: 3 });
    expect(replenishMock).toHaveBeenCalledWith({
      minimumIssueCount: 3,
      maximumOpenIssues: 5,
      templates: [
        { title: "Planned A", description: "A" },
        { title: "Planned B", description: "B" },
      ],
    });
    expect(result.created).toEqual([{ number: 21, title: "Planned A", description: "A", state: "open", labels: [] }]);
  });

  it("falls back to default replenishment when repository analysis fails", async () => {
    generateStartupIssueTemplatesMock.mockRejectedValueOnce(new Error("analysis failed"));
    const replenishMock = vi.fn().mockResolvedValueOnce({
      created: [{ number: 22, title: "Fallback", description: "B", state: "open", labels: [] }],
    });
    const issueManager = {
      replenishSelfImprovementIssues: replenishMock,
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

    expect(errorSpy).toHaveBeenCalledWith("Queue analysis for replenishment templates failed: analysis failed");
    expect(replenishMock).toHaveBeenCalledWith({
      minimumIssueCount: 3,
      maximumOpenIssues: 5,
    });
    expect(result.created).toEqual([{ number: 22, title: "Fallback", description: "B", state: "open", labels: [] }]);
  });
});
