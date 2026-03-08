import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createRuntimeServicesMock,
  buildWorkerInventoryMock,
  runDevWorkerPassMock,
  runIssueGeneratorWorkerPassMock,
  runPlannerWorkerPassMock,
  runReviewWorkerPassMock,
  runReleaseWorkerPassMock,
} = vi.hoisted(() => ({
  createRuntimeServicesMock: vi.fn(),
  buildWorkerInventoryMock: vi.fn(),
  runDevWorkerPassMock: vi.fn(),
  runIssueGeneratorWorkerPassMock: vi.fn(),
  runPlannerWorkerPassMock: vi.fn(),
  runReviewWorkerPassMock: vi.fn(),
  runReleaseWorkerPassMock: vi.fn(),
}));

vi.mock("../../environment.js", () => ({
  GITHUB_OWNER: "Evolvo-org",
  GITHUB_REPO: "evolvo-ts",
}));

vi.mock("../runtimeServices.js", () => ({
  createRuntimeServices: createRuntimeServicesMock,
}));

vi.mock("./boardQueries.js", () => ({
  buildWorkerInventory: buildWorkerInventoryMock,
}));

vi.mock("./reviewWorker.js", () => ({
  runReviewWorkerPass: runReviewWorkerPassMock,
}));

vi.mock("./issueGeneratorWorker.js", () => ({
  runIssueGeneratorWorkerPass: runIssueGeneratorWorkerPassMock,
}));

vi.mock("./devWorker.js", () => ({
  runDevWorkerPass: runDevWorkerPassMock,
}));

vi.mock("./plannerWorker.js", () => ({
  runPlannerWorkerPass: runPlannerWorkerPassMock,
}));

vi.mock("./releaseWorker.js", () => ({
  runReleaseWorkerPass: runReleaseWorkerPassMock,
}));

describe("workflowWorkerPass", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const services = {
      issueManager: { kind: "issue-manager" },
      projectsClient: { kind: "projects-client" },
      pullRequestClient: { kind: "pull-request-client" },
      defaultProjectContext: { owner: "Evolvo-org", repo: "evolvo-ts", workDir: "/tmp/evolvo-ts" },
    };
    createRuntimeServicesMock.mockReturnValue(services);
    buildWorkerInventoryMock.mockResolvedValue({ projects: [], activityState: { version: 1, projects: [] } });
    runDevWorkerPassMock.mockResolvedValue(true);
    runIssueGeneratorWorkerPassMock.mockResolvedValue(2);
    runPlannerWorkerPassMock.mockResolvedValue({ movedToPlanning: 1, movedToReadyForDev: 0, blocked: 0 });
    runReviewWorkerPassMock.mockResolvedValue(true);
    runReleaseWorkerPassMock.mockResolvedValue(true);
  });

  it("routes issue-generator workers through the issue generator pass", async () => {
    const { runWorkflowWorkerPass } = await import("./workflowWorkerPass.js");

    await expect(runWorkflowWorkerPass({
      workDir: "/tmp/evolvo-ts",
      workerId: "issue-generator",
      role: "issue-generator",
      projectSlug: null,
    })).resolves.toBe(true);

    expect(runIssueGeneratorWorkerPassMock).toHaveBeenCalledWith(expect.objectContaining({
      inventory: expect.any(Object),
    }));
    expect(runReviewWorkerPassMock).not.toHaveBeenCalled();
    expect(runReleaseWorkerPassMock).not.toHaveBeenCalled();
  });

  it("routes review workers through the review pass", async () => {
    const { runWorkflowWorkerPass } = await import("./workflowWorkerPass.js");

    await expect(runWorkflowWorkerPass({
      workDir: "/tmp/evolvo-ts",
      workerId: "review",
      role: "review",
      projectSlug: null,
    })).resolves.toBe(true);

    expect(createRuntimeServicesMock).toHaveBeenCalledWith({
      githubOwner: "Evolvo-org",
      githubRepo: "evolvo-ts",
      workDir: "/tmp/evolvo-ts",
    });
    expect(buildWorkerInventoryMock).toHaveBeenCalled();
    expect(runReviewWorkerPassMock).toHaveBeenCalledWith(expect.objectContaining({
      workDir: "/tmp/evolvo-ts",
      workerId: "review",
    }));
    expect(runReleaseWorkerPassMock).not.toHaveBeenCalled();
  });

  it("routes release workers through the release pass", async () => {
    const { runWorkflowWorkerPass } = await import("./workflowWorkerPass.js");

    await expect(runWorkflowWorkerPass({
      workDir: "/tmp/evolvo-ts",
      workerId: "release",
      role: "release",
      projectSlug: null,
    })).resolves.toBe(true);

    expect(runReleaseWorkerPassMock).toHaveBeenCalledWith(expect.objectContaining({
      workDir: "/tmp/evolvo-ts",
      workerId: "release",
    }));
    expect(runReviewWorkerPassMock).not.toHaveBeenCalled();
  });

  it("routes planner workers through the planner pass", async () => {
    const { runWorkflowWorkerPass } = await import("./workflowWorkerPass.js");

    await expect(runWorkflowWorkerPass({
      workDir: "/tmp/evolvo-ts",
      workerId: "planner",
      role: "planner",
      projectSlug: null,
    })).resolves.toBe(true);

    expect(runPlannerWorkerPassMock).toHaveBeenCalled();
    expect(runReviewWorkerPassMock).not.toHaveBeenCalled();
    expect(runReleaseWorkerPassMock).not.toHaveBeenCalled();
  });

  it("returns false for roles whose passes are not implemented yet", async () => {
    const { runWorkflowWorkerPass } = await import("./workflowWorkerPass.js");

    await expect(runWorkflowWorkerPass({
      workDir: "/tmp/evolvo-ts",
      workerId: "dev:unknown",
      role: "dev",
      projectSlug: null,
    })).resolves.toBe(false);

    expect(runReviewWorkerPassMock).not.toHaveBeenCalled();
    expect(runReleaseWorkerPassMock).not.toHaveBeenCalled();
    expect(runIssueGeneratorWorkerPassMock).not.toHaveBeenCalled();
    expect(runPlannerWorkerPassMock).not.toHaveBeenCalled();
    expect(runDevWorkerPassMock).not.toHaveBeenCalled();
  });
});