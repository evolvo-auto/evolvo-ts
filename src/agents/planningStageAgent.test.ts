import { afterEach, describe, expect, it, vi } from "vitest";
import { formatPlannedIssueDescription, runPlanningStageAgent } from "./planningStageAgent.js";

describe("formatPlannedIssueDescription", () => {
  it("renders the planner issue template into the final markdown body", () => {
    expect(formatPlannedIssueDescription({
      summary: "Replace the old issue loop with stage-based scheduling.",
      scope: ["Wire the scheduler into main startup.", "Remove the old direct issue runner path."],
      acceptanceCriteria: ["The staged workflow loop runs on startup.", "Legacy direct issue selection no longer executes."],
      validation: ["pnpm test", "pnpm build"],
    })).toBe([
      "Summary",
      "Replace the old issue loop with stage-based scheduling.",
      "",
      "Scope",
      "- Wire the scheduler into main startup.",
      "- Remove the old direct issue runner path.",
      "",
      "Acceptance Criteria",
      "- The staged workflow loop runs on startup.",
      "- Legacy direct issue selection no longer executes.",
      "",
      "Validation",
      "- pnpm test",
      "- pnpm build",
    ].join("\n"));
  });
});

describe("runPlanningStageAgent", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns planning actions for Inbox issues from the Responses API", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output_text: JSON.stringify({
          actions: [
            {
              issueNumber: 14,
              decision: "planning",
              issue: {
                title: "Implement stage-aware scheduler",
                summary: "Replace the old issue loop with board-stage scheduling.",
                scope: [
                  "Wire the staged scheduler into the runtime startup path.",
                ],
                acceptanceCriteria: [
                  "The runtime uses the staged scheduler path instead of the old issue loop.",
                ],
                validation: ["pnpm build"],
              },
              splitIssues: [
                {
                  title: "Add scheduler metrics",
                  summary: "Track per-agent stage throughput.",
                  scope: ["Add stage throughput counters for each workflow agent."],
                  acceptanceCriteria: ["Workflow logs include stage throughput metrics."],
                  validation: ["pnpm test"],
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
        decision: "planning",
        title: "Implement stage-aware scheduler",
        description: [
          "Summary",
          "Replace the old issue loop with board-stage scheduling.",
          "",
          "Scope",
          "- Wire the staged scheduler into the runtime startup path.",
          "",
          "Acceptance Criteria",
          "- The runtime uses the staged scheduler path instead of the old issue loop.",
          "",
          "Validation",
          "- pnpm build",
        ].join("\n"),
        splitIssues: [
          {
            title: "Add scheduler metrics",
            description: [
              "Summary",
              "Track per-agent stage throughput.",
              "",
              "Scope",
              "- Add stage throughput counters for each workflow agent.",
              "",
              "Acceptance Criteria",
              "- Workflow logs include stage throughput metrics.",
              "",
              "Validation",
              "- pnpm test",
            ].join("\n"),
          },
        ],
        reasons: ["The issue is implementation-ready after being tightened."],
      },
    ]);
  });

  it("returns ready-for-dev actions for already-planned issues", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output_text: JSON.stringify({
          actions: [
            {
              issueNumber: 18,
              decision: "ready-for-dev",
              issue: {
                title: "Wire stage-aware scheduler into runtime startup",
                summary: "The issue is now specific enough for direct implementation.",
                scope: ["Connect the staged scheduler to runtime startup."],
                acceptanceCriteria: ["Runtime startup executes the staged scheduler loop."],
                validation: ["pnpm build"],
              },
              splitIssues: [],
              reasons: ["This item is already well-scoped and ready to build."],
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
          number: 18,
          title: "Scheduler runtime integration",
          description: "Connect the new scheduler to the staged workflow loop.",
          stage: "Planning",
        },
      ],
      openIssueTitles: [],
      recentClosedIssueTitles: [],
    });

    expect(result).toEqual([
      {
        issueNumber: 18,
        decision: "ready-for-dev",
        title: "Wire stage-aware scheduler into runtime startup",
        description: [
          "Summary",
          "The issue is now specific enough for direct implementation.",
          "",
          "Scope",
          "- Connect the staged scheduler to runtime startup.",
          "",
          "Acceptance Criteria",
          "- Runtime startup executes the staged scheduler loop.",
          "",
          "Validation",
          "- pnpm build",
        ].join("\n"),
        splitIssues: [],
        reasons: ["This item is already well-scoped and ready to build."],
      },
    ]);
  });

  it("parses assistant output from the output message content when output_text is absent", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  actions: [
                    {
                      issueNumber: 21,
                      decision: "blocked",
                      issue: {
                        title: "Clarify release-stage board transitions",
                        summary: "The issue depends on unresolved release ownership and should be blocked.",
                        scope: ["Define which agent owns merge-conflict resolution."],
                        acceptanceCriteria: ["Release ownership is explicitly documented."],
                        validation: ["pnpm test"],
                      },
                      splitIssues: [],
                      reasons: ["Release ownership is still undefined."],
                    },
                  ],
                }),
              },
            ],
          },
        ],
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
          number: 21,
          title: "Release stage transitions",
          description: "Need to define this properly",
          stage: "Planning",
        },
      ],
      openIssueTitles: [],
      recentClosedIssueTitles: [],
    });

    expect(result).toEqual([
      {
        issueNumber: 21,
        decision: "blocked",
        title: "Clarify release-stage board transitions",
        description: [
          "Summary",
          "The issue depends on unresolved release ownership and should be blocked.",
          "",
          "Scope",
          "- Define which agent owns merge-conflict resolution.",
          "",
          "Acceptance Criteria",
          "- Release ownership is explicitly documented.",
          "",
          "Validation",
          "- pnpm test",
        ].join("\n"),
        splitIssues: [],
        reasons: ["Release ownership is still undefined."],
      },
    ]);
  });
});
