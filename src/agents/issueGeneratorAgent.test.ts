import { afterEach, describe, expect, it, vi } from "vitest";
import { runIssueGeneratorAgent } from "./issueGeneratorAgent.js";

describe("runIssueGeneratorAgent", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns parsed issue drafts from the Responses API", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output_text: JSON.stringify({
          issues: [
            {
              title: "Add workflow telemetry",
              description: "Emit board-stage metrics for every project.",
            },
          ],
        }),
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runIssueGeneratorAgent({
      apiKey: "test-key",
      projectSlug: "evolvo",
      projectDisplayName: "Evolvo",
      repository: "Evolvo-org/evolvo-ts",
      counts: {
        inbox: 0,
        planning: 0,
        readyForDev: 0,
        inDev: 0,
      },
      openIssueTitles: [],
      recentClosedIssueTitles: [],
      maxIssues: 5,
    });

    expect(result).toEqual([
      {
        title: "Add workflow telemetry",
        description: "Emit board-stage metrics for every project.",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
