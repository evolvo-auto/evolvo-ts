import { afterEach, describe, expect, it, vi } from "vitest";
import { runPlanningStageAgent } from "./planningStageAgent.js";

describe("runPlanningStageAgent", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns planner actions from the Responses API", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output_text: JSON.stringify({
          actions: [
            {
              issueNumber: 14,
              decision: "ready-for-dev",
              title: "Implement stage-aware scheduler",
              description: "Replace the old issue loop with board-stage scheduling.",
              splitIssues: [
                {
                  title: "Add scheduler metrics",
                  description: "Track per-agent stage throughput.",
                },
              ],
              reasons: ["The issue is implementation-ready after being tightened."],
            },
          ],
        }),
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runPlanningStageAgent({
      apiKey: "test-key",
      projectSlug: "evolvo",
      projectDisplayName: "Evolvo",
      repository: "Evolvo-org/evolvo-ts",
      maxIssues: 10,
      planningIssues: [
        {
          number: 14,
          title: "Scheduler",
          description: "Make it better",
          stage: "Inbox",
        },
      ],
      openIssueTitles: [],
      recentClosedIssueTitles: [],
    });

    expect(result).toEqual([
      {
        issueNumber: 14,
        decision: "ready-for-dev",
        title: "Implement stage-aware scheduler",
        description: "Replace the old issue loop with board-stage scheduling.",
        splitIssues: [
          {
            title: "Add scheduler metrics",
            description: "Track per-agent stage throughput.",
          },
        ],
        reasons: ["The issue is implementation-ready after being tightened."],
      },
    ]);
  });
});
