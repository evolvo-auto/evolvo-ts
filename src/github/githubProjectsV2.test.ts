import { describe, expect, it, vi } from "vitest";
import { GitHubProjectsV2Client } from "./githubProjectsV2.js";
import { createDefaultProjectWorkflow } from "../projects/projectWorkflow.js";
import type { ProjectRecord } from "../projects/projectRegistry.js";

function createProject(): ProjectRecord {
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
    cwd: "/tmp/habit-cli",
    status: "active",
    sourceIssueNumber: 25,
    createdAt: "2026-03-08T10:00:00.000Z",
    updatedAt: "2026-03-08T10:00:00.000Z",
    provisioning: {
      labelCreated: true,
      repoCreated: true,
      workspacePrepared: true,
      lastError: null,
    },
    workflow: createDefaultProjectWorkflow("evolvo-auto"),
  };
}

describe("GitHubProjectsV2Client", () => {
  it("returns existing board metadata when the board and stage field already exist", async () => {
    const graphql = vi.fn()
      .mockResolvedValueOnce({
        organization: {
          id: "owner-id",
          login: "evolvo-auto",
          __typename: "Organization",
          projectsV2: {
            nodes: [
              {
                id: "project-id",
                number: 7,
                title: "habit-cli Workflow",
                url: "https://github.com/orgs/evolvo-auto/projects/7",
              },
            ],
          },
        },
        user: null,
      })
      .mockResolvedValueOnce({
        organization: {
          projectV2: {
            fields: {
              nodes: [
                {
                  id: "stage-field-id",
                  name: "Stage",
                  options: [
                    { id: "opt-inbox", name: "Inbox" },
                    { id: "opt-ready", name: "Ready for Dev" },
                  ],
                },
              ],
            },
          },
        },
        user: null,
      });

    const client = new GitHubProjectsV2Client({ graphql } as never);

    const result = await client.ensureProjectBoard(createProject());

    expect(result.workflow).toEqual(
      expect.objectContaining({
        boardOwner: "evolvo-auto",
        boardNumber: 7,
        boardId: "project-id",
        boardUrl: "https://github.com/orgs/evolvo-auto/projects/7",
        stageFieldId: "stage-field-id",
        boardProvisioned: true,
        stageOptionIds: expect.objectContaining({
          Inbox: "opt-inbox",
          "Ready for Dev": "opt-ready",
        }),
      }),
    );
    expect(graphql).toHaveBeenCalledTimes(2);
  });

  it("creates the board and stage field when they are missing", async () => {
    const graphql = vi.fn()
      .mockResolvedValueOnce({
        organization: {
          id: "owner-id",
          login: "evolvo-auto",
          __typename: "Organization",
          projectsV2: { nodes: [] },
        },
        user: null,
      })
      .mockResolvedValueOnce({
        createProjectV2: {
          projectV2: {
            id: "project-id",
            number: 12,
            url: "https://github.com/orgs/evolvo-auto/projects/12",
          },
        },
      })
      .mockResolvedValueOnce({
        organization: {
          projectV2: {
            fields: { nodes: [] },
          },
        },
        user: null,
      })
      .mockResolvedValueOnce({
        createProjectV2Field: {
          projectV2Field: {
            id: "stage-field-id",
            name: "Stage",
            options: [
              { id: "opt-inbox", name: "Inbox" },
              { id: "opt-planning", name: "Planning" },
            ],
          },
        },
      });

    const client = new GitHubProjectsV2Client({ graphql } as never);

    const result = await client.ensureProjectBoard(createProject());

    expect(result.workflow.boardNumber).toBe(12);
    expect(result.workflow.stageFieldId).toBe("stage-field-id");
    expect(result.workflow.stageOptionIds.Inbox).toBe("opt-inbox");
    expect(result.workflow.boardProvisioned).toBe(true);
    expect(graphql).toHaveBeenCalledTimes(4);
  });
});
