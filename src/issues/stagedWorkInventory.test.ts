import { describe, expect, it, vi } from "vitest";
import { buildStagedWorkInventory } from "./stagedWorkInventory.js";
import { createDefaultProjectWorkflow } from "../projects/projectWorkflow.js";
import type { ProjectRecord } from "../projects/projectRegistry.js";

const {
  readProjectRegistryMock,
  readActiveProjectsStateMock,
  synchronizeProjectActivityStateMock,
} = vi.hoisted(() => ({
  readProjectRegistryMock: vi.fn(),
  readActiveProjectsStateMock: vi.fn(),
  synchronizeProjectActivityStateMock: vi.fn(),
}));

vi.mock("../projects/projectRegistry.js", async () => {
  const actual = await vi.importActual<typeof import("../projects/projectRegistry.js")>("../projects/projectRegistry.js");
  return {
    ...actual,
    readProjectRegistry: readProjectRegistryMock,
  };
});

vi.mock("../projects/activeProjectsState.js", async () => {
  const actual = await vi.importActual<typeof import("../projects/activeProjectsState.js")>("../projects/activeProjectsState.js");
  return {
    ...actual,
    readActiveProjectsState: readActiveProjectsStateMock,
  };
});

vi.mock("../projects/projectActivityState.js", async () => {
  const actual = await vi.importActual<typeof import("../projects/projectActivityState.js")>("../projects/projectActivityState.js");
  return {
    ...actual,
    synchronizeProjectActivityState: synchronizeProjectActivityStateMock,
  };
});

function createProject(overrides: Partial<ProjectRecord>): ProjectRecord {
  return {
    slug: "evolvo",
    displayName: "Evolvo",
    kind: "default",
    issueLabel: "project:evolvo",
    trackerRepo: {
      owner: "Evolvo-org",
      repo: "evolvo-ts",
      url: "https://github.com/Evolvo-org/evolvo-ts",
    },
    executionRepo: {
      owner: "Evolvo-org",
      repo: "evolvo-ts",
      url: "https://github.com/Evolvo-org/evolvo-ts",
      defaultBranch: "main",
    },
    cwd: "/tmp/evolvo-ts",
    status: "active",
    sourceIssueNumber: null,
    createdAt: "2026-03-08T00:00:00.000Z",
    updatedAt: "2026-03-08T00:00:00.000Z",
    provisioning: {
      labelCreated: true,
      repoCreated: true,
      workspacePrepared: true,
      lastError: null,
    },
    workflow: createDefaultProjectWorkflow("Evolvo-org"),
    ...overrides,
  };
}

describe("buildStagedWorkInventory", () => {
  it("includes the default project and the active managed project, and syncs missing open issues onto the board", async () => {
    const defaultProject = createProject({});
    const managedProject = createProject({
      slug: "evolvo-web",
      displayName: "Evolvo Web",
      kind: "managed",
      issueLabel: "project:evolvo-web",
      executionRepo: {
        owner: "Evolvo-org",
        repo: "evolvo-web",
        url: "https://github.com/Evolvo-org/evolvo-web",
        defaultBranch: "main",
      },
      trackerRepo: {
        owner: "Evolvo-org",
        repo: "evolvo-ts",
        url: "https://github.com/Evolvo-org/evolvo-ts",
      },
      cwd: "/tmp/evolvo-web",
      sourceIssueNumber: 101,
      workflow: {
        ...createDefaultProjectWorkflow("Evolvo-org"),
        boardId: "project-web",
        stageFieldId: "stage-field-web",
        stageOptionIds: {
          Planning: "opt-planning",
        },
      },
    });
    readProjectRegistryMock.mockResolvedValue({
      version: 1,
      projects: [defaultProject, managedProject],
    });
    readActiveProjectsStateMock.mockResolvedValue({
      version: 1,
      projects: [{ slug: "evolvo-web", requestedBy: "operator", source: "start-project-command", updatedAt: "2026-03-08T00:10:00.000Z" }],
    });
    synchronizeProjectActivityStateMock.mockResolvedValue({
      version: 1,
      projects: [
        {
          slug: "evolvo",
          activityState: "active",
          deferredStopMode: null,
          requestedBy: null,
          updatedAt: null,
          currentCodingLease: null,
          currentWorkItem: null,
          lastStageTransition: null,
          schedulingEligibility: { eligible: true, reason: null, lastScheduledAt: null },
          lastFailure: null,
        },
        {
          slug: "evolvo-web",
          activityState: "active",
          deferredStopMode: null,
          requestedBy: "operator",
          updatedAt: "2026-03-08T00:10:00.000Z",
          currentCodingLease: null,
          currentWorkItem: null,
          lastStageTransition: null,
          schedulingEligibility: { eligible: true, reason: null, lastScheduledAt: null },
          lastFailure: null,
        },
      ],
    });

    const listOpenIssues = vi.fn()
      .mockResolvedValueOnce([{ number: 1, title: "Tracker issue", description: "", state: "open", labels: [] }])
      .mockResolvedValueOnce([{ number: 7, title: "Project issue", description: "", state: "open", labels: [] }]);
    const trackerIssueManager = {
      forRepository: vi.fn().mockReturnValue({
        listOpenIssues,
      }),
    };
    const listProjectIssueItems = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const ensureRepositoryIssueItem = vi.fn()
      .mockResolvedValueOnce({
        itemId: "item-1",
        issueNodeId: "issue-node-1",
        issueNumber: 1,
        title: "Tracker issue",
        body: "",
        state: "OPEN",
        url: "https://github.com/Evolvo-org/evolvo-ts/issues/1",
        labels: [],
        repository: {
          owner: "Evolvo-org",
          repo: "evolvo-ts",
          url: "https://github.com/Evolvo-org/evolvo-ts",
          reference: "Evolvo-org/evolvo-ts",
        },
        stage: null,
        stageOptionId: null,
      })
      .mockResolvedValueOnce({
        itemId: "item-7",
        issueNodeId: "issue-node-7",
        issueNumber: 7,
        title: "Project issue",
        body: "",
        state: "OPEN",
        url: "https://github.com/Evolvo-org/evolvo-web/issues/7",
        labels: [],
        repository: {
          owner: "Evolvo-org",
          repo: "evolvo-web",
          url: "https://github.com/Evolvo-org/evolvo-web",
          reference: "Evolvo-org/evolvo-web",
        },
        stage: null,
        stageOptionId: null,
      });
    const moveProjectItemToStage = vi.fn().mockResolvedValue(undefined);
    const boardsClient = {
      listProjectIssueItems,
      ensureRepositoryIssueItem,
      moveProjectItemToStage,
    };

    const inventory = await buildStagedWorkInventory({
      workDir: "/tmp/evolvo-ts",
      defaultProject: {
        owner: "Evolvo-org",
        repo: "evolvo-ts",
        workDir: "/tmp/evolvo-ts",
      },
      trackerIssueManager: trackerIssueManager as never,
      boardsClient: boardsClient as never,
    });

    expect(inventory.projects).toHaveLength(2);
    expect(moveProjectItemToStage).toHaveBeenCalledWith(defaultProject, "item-1", "Planning");
    expect(moveProjectItemToStage).toHaveBeenCalledWith(managedProject, "item-7", "Planning");
    expect(inventory.projects[1]?.items[0]).toEqual(
      expect.objectContaining({
        queueKey: "evolvo-web#7",
        stage: "Planning",
      }),
    );
  });
});
