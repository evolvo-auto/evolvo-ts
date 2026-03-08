import { describe, expect, it, vi } from "vitest";
import type { ProjectRecord } from "./projectRegistry.js";
import { createDefaultProjectWorkflow } from "./projectWorkflow.js";
import {
  ProjectRepositoryIssueInspector,
  buildProjectRepositoryIssueInspectionLogLines,
} from "./projectRepositoryIssues.js";

function createProjectRecord(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    slug: "habit-cli",
    displayName: "Habit CLI",
    kind: "managed",
    issueLabel: "project:habit-cli",
    trackerRepo: {
      owner: "evolvo-auto",
      repo: "evolvo-ts",
      url: "https://github.com/evolvo-auto/evolvo-ts",
    },
    executionRepo: {
      owner: "evolvo-auto",
      repo: "habit-cli",
      url: "https://github.com/evolvo-auto/habit-cli",
      defaultBranch: "main",
    },
    cwd: "/tmp/projects/habit-cli",
    status: "active",
    sourceIssueNumber: 398,
    createdAt: "2026-03-08T10:00:00.000Z",
    updatedAt: "2026-03-08T10:00:00.000Z",
    provisioning: {
      labelCreated: true,
      repoCreated: true,
      workspacePrepared: true,
      lastError: null,
    },
    workflow: createDefaultProjectWorkflow("evolvo-auto"),
    ...overrides,
  };
}

describe("projectRepositoryIssues", () => {
  it("inspects open and recent closed issues from the managed project repository", async () => {
    const client = {
      getApi: vi.fn()
        .mockResolvedValueOnce([
          {
            number: 11,
            title: "Open project issue",
            body: "Still open",
            state: "open",
            labels: [{ name: "bug" }],
          },
        ])
        .mockResolvedValueOnce([
          {
            number: 10,
            title: "Recently closed project issue",
            body: "Done",
            state: "closed",
            labels: [{ name: "completed" }],
          },
        ]),
    };
    const inspector = new ProjectRepositoryIssueInspector(client as never);

    const state = await inspector.inspectProject(createProjectRecord(), { recentClosedLimit: 5 });

    expect(client.getApi).toHaveBeenNthCalledWith(
      1,
      "/repos/evolvo-auto/habit-cli/issues?state=open&per_page=100&page=1",
    );
    expect(client.getApi).toHaveBeenNthCalledWith(
      2,
      "/repos/evolvo-auto/habit-cli/issues?state=closed&sort=updated&direction=desc&per_page=5&page=1",
    );
    expect(state).toEqual({
      projectSlug: "habit-cli",
      repository: {
        owner: "evolvo-auto",
        repo: "habit-cli",
        reference: "evolvo-auto/habit-cli",
        url: "https://github.com/evolvo-auto/habit-cli",
      },
      openIssues: [
        {
          number: 11,
          title: "Open project issue",
          description: "Still open",
          state: "open",
          labels: ["bug"],
        },
      ],
      recentClosedIssues: [
        {
          number: 10,
          title: "Recently closed project issue",
          description: "Done",
          state: "closed",
          labels: ["completed"],
        },
      ],
    });
  });

  it("formats inspection logs with explicit project and repository context", () => {
    const lines = buildProjectRepositoryIssueInspectionLogLines({
      projectSlug: "habit-cli",
      repository: {
        owner: "evolvo-auto",
        repo: "habit-cli",
        reference: "evolvo-auto/habit-cli",
        url: "https://github.com/evolvo-auto/habit-cli",
      },
      openIssues: [
        {
          number: 11,
          title: "Open project issue",
          description: "Still open",
          state: "open",
          labels: [],
        },
      ],
      recentClosedIssues: [],
    });

    expect(lines).toEqual([
      "[project-issues] inspected project=habit-cli repository=evolvo-auto/habit-cli open=1 recentClosed=0",
      "[project-issues] open sample for evolvo-auto/habit-cli: #11 Open project issue",
      "[project-issues] recent closed sample for evolvo-auto/habit-cli: none",
    ]);
  });
});
