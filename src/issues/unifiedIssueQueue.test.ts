import { beforeEach, describe, expect, it, vi } from "vitest";

const readProjectRegistryMock = vi.fn();
const findProjectBySlugMock = vi.fn();
const readActiveProjectsStateMock = vi.fn();

vi.mock("../projects/projectRegistry.js", () => ({
  readProjectRegistry: readProjectRegistryMock,
  findProjectBySlug: findProjectBySlugMock,
}));

vi.mock("../projects/activeProjectsState.js", () => ({
  readActiveProjectsState: readActiveProjectsStateMock,
}));

describe("unifiedIssueQueue", () => {
  beforeEach(() => {
    vi.resetModules();
    readProjectRegistryMock.mockReset();
    findProjectBySlugMock.mockReset();
    readActiveProjectsStateMock.mockReset();
    readActiveProjectsStateMock.mockResolvedValue({
      version: 1,
      projects: [],
    });
  });

  it("returns tracker issues only when there is no active project", async () => {
    const trackerIssueManager = {
      listAuthorizedOpenIssues: vi.fn().mockResolvedValue({
        issues: [
          {
            number: 1,
            title: "Tracker task",
            description: "Do the tracker thing.",
            state: "open",
            labels: [],
          },
        ],
        unauthorizedClosures: [],
      }),
      forRepository: vi.fn(),
    };

    const { buildUnifiedIssueQueue } = await import("./unifiedIssueQueue.js");
    const result = await buildUnifiedIssueQueue({
      trackerIssueManager: trackerIssueManager as never,
      workDir: "/tmp/evolvo",
      defaultProject: {
        owner: "evolvo-auto",
        repo: "evolvo-ts",
        workDir: "/tmp/evolvo",
      },
      activeProjectState: {
        version: 2,
        activeProjectSlug: null,
        selectionState: null,
        updatedAt: null,
        requestedBy: null,
        source: null,
      },
    });

    expect(result.activeManagedProject).toBeNull();
    expect(result.activeManagedProjects).toEqual([]);
    expect(result.issues.map((issue) => issue.queueKey)).toEqual(["tracker:evolvo-auto/evolvo-ts#1"]);
    expect(trackerIssueManager.forRepository).not.toHaveBeenCalled();
  });

  it("adds issues from every active managed project ahead of tracker issues", async () => {
    const evolvoWebIssueManager = {
      listOpenIssues: vi.fn().mockResolvedValue([
        {
          number: 5,
          title: "Homepage shell",
          description: "Build the shell.",
          state: "open",
          labels: ["frontend"],
        },
      ]),
    };
    const habitCliIssueManager = {
      listOpenIssues: vi.fn().mockResolvedValue([
        {
          number: 7,
          title: "Habit sync",
          description: "Add sync support.",
          state: "open",
          labels: ["backend"],
        },
      ]),
    };
    const trackerIssueManager = {
      listAuthorizedOpenIssues: vi.fn().mockResolvedValue({
        issues: [
          {
            number: 1,
            title: "Tracker task",
            description: "Do the tracker thing.",
            state: "open",
            labels: [],
          },
        ],
        unauthorizedClosures: [],
      }),
      forRepository: vi.fn().mockImplementation(({ repo }: { repo: string }) => {
        if (repo === "evolvo-web") {
          return evolvoWebIssueManager;
        }

        if (repo === "habit-cli") {
          return habitCliIssueManager;
        }

        throw new Error(`Unexpected repository ${repo}`);
      }),
    };
    const activeProject = {
      slug: "evolvo-web",
      displayName: "evolvo-web",
      kind: "managed",
      issueLabel: "project:evolvo-web",
      trackerRepo: {
        owner: "evolvo-auto",
        repo: "evolvo-ts",
        url: "https://github.com/evolvo-auto/evolvo-ts",
      },
      executionRepo: {
        owner: "evolvo-auto",
        repo: "evolvo-web",
        url: "https://github.com/evolvo-auto/evolvo-web",
        defaultBranch: "main",
      },
      cwd: "/home/paddy/evolvo-web",
      status: "active",
      sourceIssueNumber: 10,
      createdAt: "2026-03-08T00:00:00.000Z",
      updatedAt: "2026-03-08T00:00:00.000Z",
      provisioning: {
        labelCreated: true,
        repoCreated: true,
        workspacePrepared: true,
        lastError: null,
      },
    };
    const secondaryProject = {
      ...activeProject,
      slug: "habit-cli",
      displayName: "Habit CLI",
      issueLabel: "project:habit-cli",
      executionRepo: {
        owner: "evolvo-auto",
        repo: "habit-cli",
        url: "https://github.com/evolvo-auto/habit-cli",
        defaultBranch: "main",
      },
      cwd: "/home/paddy/habit-cli",
    };
    readActiveProjectsStateMock.mockResolvedValue({
      version: 1,
      projects: [
        {
          slug: "habit-cli",
          updatedAt: "2026-03-08T00:01:00.000Z",
          requestedBy: "operator",
          source: "start-project-command",
        },
        {
          slug: "evolvo-web",
          updatedAt: "2026-03-08T00:00:00.000Z",
          requestedBy: "operator",
          source: "start-project-command",
        },
      ],
    });
    readProjectRegistryMock.mockResolvedValue({ projects: [activeProject, secondaryProject] });
    findProjectBySlugMock.mockImplementation((registry: { projects: Array<{ slug: string }> }, slug: string) =>
      registry.projects.find((project) => project.slug === slug) ?? null
    );

    const { buildUnifiedIssueQueue } = await import("./unifiedIssueQueue.js");
    const result = await buildUnifiedIssueQueue({
      trackerIssueManager: trackerIssueManager as never,
      workDir: "/tmp/evolvo",
      defaultProject: {
        owner: "evolvo-auto",
        repo: "evolvo-ts",
        workDir: "/tmp/evolvo",
      },
      activeProjectState: {
        version: 2,
        activeProjectSlug: "evolvo-web",
        selectionState: "active",
        updatedAt: "2026-03-08T00:00:00.000Z",
        requestedBy: "operator",
        source: "start-project-command",
      },
    });

    expect(trackerIssueManager.forRepository).toHaveBeenCalledWith({
      owner: "evolvo-auto",
      repo: "habit-cli",
    });
    expect(trackerIssueManager.forRepository).toHaveBeenCalledWith({
      owner: "evolvo-auto",
      repo: "evolvo-web",
    });
    expect(result.activeManagedProject?.slug).toBe("evolvo-web");
    expect(result.activeManagedProjects.map((project) => project.slug)).toEqual([
      "evolvo-web",
      "habit-cli",
    ]);
    expect(result.issues.map((issue) => issue.queueKey)).toEqual([
      "project:evolvo-web#5",
      "project:habit-cli#7",
      "tracker:evolvo-auto/evolvo-ts#1",
    ]);
  });

  it("keeps the focused managed project visible even if the active-project set has not caught up yet", async () => {
    const projectIssueManager = {
      listOpenIssues: vi.fn().mockResolvedValue([
        {
          number: 5,
          title: "Homepage shell",
          description: "Build the shell.",
          state: "open",
          labels: ["frontend"],
        },
      ]),
    };
    const trackerIssueManager = {
      listAuthorizedOpenIssues: vi.fn().mockResolvedValue({
        issues: [],
        unauthorizedClosures: [],
      }),
      forRepository: vi.fn().mockReturnValue(projectIssueManager),
    };
    const activeProject = {
      slug: "evolvo-web",
      displayName: "evolvo-web",
      kind: "managed",
      issueLabel: "project:evolvo-web",
      trackerRepo: {
        owner: "evolvo-auto",
        repo: "evolvo-ts",
        url: "https://github.com/evolvo-auto/evolvo-ts",
      },
      executionRepo: {
        owner: "evolvo-auto",
        repo: "evolvo-web",
        url: "https://github.com/evolvo-auto/evolvo-web",
        defaultBranch: "main",
      },
      cwd: "/home/paddy/evolvo-web",
      status: "active",
      sourceIssueNumber: 10,
      createdAt: "2026-03-08T00:00:00.000Z",
      updatedAt: "2026-03-08T00:00:00.000Z",
      provisioning: {
        labelCreated: true,
        repoCreated: true,
        workspacePrepared: true,
        lastError: null,
      },
    };
    readProjectRegistryMock.mockResolvedValue({ projects: [activeProject] });
    findProjectBySlugMock.mockImplementation((registry: { projects: Array<{ slug: string }> }, slug: string) =>
      registry.projects.find((project) => project.slug === slug) ?? null
    );

    const { buildUnifiedIssueQueue } = await import("./unifiedIssueQueue.js");
    const result = await buildUnifiedIssueQueue({
      trackerIssueManager: trackerIssueManager as never,
      workDir: "/tmp/evolvo",
      defaultProject: {
        owner: "evolvo-auto",
        repo: "evolvo-ts",
        workDir: "/tmp/evolvo",
      },
      activeProjectState: {
        version: 2,
        activeProjectSlug: "evolvo-web",
        selectionState: "active",
        updatedAt: "2026-03-08T00:00:00.000Z",
        requestedBy: "operator",
        source: "start-project-command",
      },
    });

    expect(result.activeManagedProject?.slug).toBe("evolvo-web");
    expect(result.activeManagedProjects.map((project) => project.slug)).toEqual(["evolvo-web"]);
    expect(result.issues.map((issue) => issue.queueKey)).toEqual([
      "project:evolvo-web#5",
    ]);
  });

  it("ignores the active project when the registry record is not an active managed project", async () => {
    const trackerIssueManager = {
      listAuthorizedOpenIssues: vi.fn().mockResolvedValue({
        issues: [],
        unauthorizedClosures: [],
      }),
      forRepository: vi.fn(),
    };
    const inactiveProject = {
      slug: "evolvo-web",
      kind: "managed",
      status: "failed",
    };
    readProjectRegistryMock.mockResolvedValue({ projects: [inactiveProject] });
    findProjectBySlugMock.mockReturnValue(inactiveProject);

    const { buildUnifiedIssueQueue } = await import("./unifiedIssueQueue.js");
    const result = await buildUnifiedIssueQueue({
      trackerIssueManager: trackerIssueManager as never,
      workDir: "/tmp/evolvo",
      defaultProject: {
        owner: "evolvo-auto",
        repo: "evolvo-ts",
        workDir: "/tmp/evolvo",
      },
      activeProjectState: {
        version: 2,
        activeProjectSlug: "evolvo-web",
        selectionState: "active",
        updatedAt: "2026-03-08T00:00:00.000Z",
        requestedBy: "operator",
        source: "start-project-command",
      },
    });

    expect(result.activeManagedProject).toBeNull();
    expect(result.activeManagedProjects).toEqual([]);
    expect(trackerIssueManager.forRepository).not.toHaveBeenCalled();
  });
});
