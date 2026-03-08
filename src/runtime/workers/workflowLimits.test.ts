import { afterEach, describe, expect, it, vi } from "vitest";

async function importWorkflowLimits() {
  vi.resetModules();
  return import("./workflowLimits.js");
}

describe("workflowLimits", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("returns the default workflow limits when env overrides are absent", async () => {
    const { getWorkflowLimitConfig } = await importWorkflowLimits();

    expect(getWorkflowLimitConfig()).toEqual({
      ideaStageTargetPerProject: 5,
      issueGeneratorMaxIssuesPerProject: 5,
      planningLimitPerProject: 5,
      readyForDevLimitPerProject: 3,
      inDevLimitPerProject: 1,
    });
  });

  it("reads workflow limits from env", async () => {
    vi.stubEnv("EVOLVO_IDEA_STAGE_TARGET_PER_PROJECT", "7");
    vi.stubEnv("EVOLVO_ISSUE_GENERATOR_MAX_ISSUES_PER_PROJECT", "8");
    vi.stubEnv("EVOLVO_PLANNING_LIMIT_PER_PROJECT", "9");
    vi.stubEnv("EVOLVO_READY_FOR_DEV_LIMIT_PER_PROJECT", "4");
    vi.stubEnv("EVOLVO_IN_DEV_LIMIT_PER_PROJECT", "2");

    const { getWorkflowLimitConfig } = await importWorkflowLimits();

    expect(getWorkflowLimitConfig()).toEqual({
      ideaStageTargetPerProject: 7,
      issueGeneratorMaxIssuesPerProject: 8,
      planningLimitPerProject: 9,
      readyForDevLimitPerProject: 4,
      inDevLimitPerProject: 2,
    });
  });

  it("falls back to defaults for invalid env values", async () => {
    vi.stubEnv("EVOLVO_IDEA_STAGE_TARGET_PER_PROJECT", "0");
    vi.stubEnv("EVOLVO_ISSUE_GENERATOR_MAX_ISSUES_PER_PROJECT", "-1");
    vi.stubEnv("EVOLVO_PLANNING_LIMIT_PER_PROJECT", "NaN");
    vi.stubEnv("EVOLVO_READY_FOR_DEV_LIMIT_PER_PROJECT", " ");
    vi.stubEnv("EVOLVO_IN_DEV_LIMIT_PER_PROJECT", "abc");

    const { getWorkflowLimitConfig } = await importWorkflowLimits();

    expect(getWorkflowLimitConfig()).toEqual({
      ideaStageTargetPerProject: 5,
      issueGeneratorMaxIssuesPerProject: 5,
      planningLimitPerProject: 5,
      readyForDevLimitPerProject: 3,
      inDevLimitPerProject: 1,
    });
  });
});