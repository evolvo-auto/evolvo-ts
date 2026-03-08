import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VercelApiError,
  VercelClient,
  deployProjectRepositoryWithVercel,
  hasDeployableRepositoryMarker,
  readVercelConfiguration,
} from "./vercelDeployment.js";

const DEPLOYABLE_REPOSITORY = {
  id: 1001,
  owner: "evolvo-auto",
  repo: "habit-cli",
  url: "https://github.com/evolvo-auto/habit-cli",
  defaultBranch: "main",
  description: "Habit CLI <deployable>",
};

describe("vercelDeployment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("detects the deployable marker in repository descriptions", () => {
    expect(hasDeployableRepositoryMarker("managed repo <deployable>")).toBe(true);
    expect(hasDeployableRepositoryMarker("managed repo")).toBe(false);
    expect(hasDeployableRepositoryMarker(null)).toBe(false);
  });

  it("reports when Vercel configuration is unavailable", () => {
    const configuration = readVercelConfiguration({
      VERCEL_TOKEN: "",
    });

    expect(configuration).toEqual({
      available: false,
      config: null,
      missing: ["VERCEL_TOKEN"],
    });
  });

  it("parses the optional Vercel configuration values", () => {
    const configuration = readVercelConfiguration({
      VERCEL_TOKEN: " vercel-token ",
      VERCEL_TEAM_ID: "team_123",
      VERCEL_DEFAULT_FRAMEWORK: "nextjs",
      VERCEL_DEPLOY_TIMEOUT_MS: "4000",
      VERCEL_DEPLOY_POLL_INTERVAL_MS: "250",
    });

    expect(configuration).toEqual({
      available: true,
      config: {
        token: "vercel-token",
        teamId: "team_123",
        defaultFramework: "nextjs",
        deployTimeoutMs: 4000,
        deployPollIntervalMs: 250,
      },
      missing: [],
    });
  });

  it("skips deployment for repositories without the deployable marker", async () => {
    const result = await deployProjectRepositoryWithVercel({
      repository: {
        ...DEPLOYABLE_REPOSITORY,
        description: "Habit CLI",
      },
      env: {},
    });

    expect(result).toEqual({
      status: "skipped",
      repository: "evolvo-auto/habit-cli",
      deployableMarkerPresent: false,
      vercelConfigured: false,
      reason: "Repository description does not include <deployable>.",
      logs: expect.any(Array),
    });
    expect(result.logs).toContain("[deploy] Vercel configuration available for evolvo-auto/habit-cli: no.");
  });

  it("fails clearly when a deployable repository is missing Vercel configuration", async () => {
    const result = await deployProjectRepositoryWithVercel({
      repository: DEPLOYABLE_REPOSITORY,
      env: {},
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") {
      throw new Error("Expected deployment result to fail when Vercel configuration is missing.");
    }
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("Repository is marked <deployable> but Vercel configuration is missing");
    expect(result.project).toBeNull();
    expect(result.deployment).toBeNull();
  });

  it("creates or reuses a Vercel project and waits for the deployment to become ready", async () => {
    const client = {
      findProjectsByRepoUrl: vi.fn().mockResolvedValue([
        {
          id: "prj_123",
          name: "habit-cli",
          link: {
            org: "evolvo-auto",
            repo: "habit-cli",
            repoId: 1001,
            productionBranch: "main",
          },
        },
      ]),
      getProject: vi.fn(),
      createProject: vi.fn(),
      createDeployment: vi.fn().mockResolvedValue({
        id: "dpl_123",
        readyState: "BUILDING",
        url: "habit-cli-git-main-evolvo-auto.vercel.app",
      }),
      getDeployment: vi.fn().mockResolvedValue({
        id: "dpl_123",
        readyState: "READY",
        url: "habit-cli-git-main-evolvo-auto.vercel.app",
      }),
    };

    const result = await deployProjectRepositoryWithVercel({
      repository: DEPLOYABLE_REPOSITORY,
      env: {
        VERCEL_TOKEN: "vercel-token",
        VERCEL_DEPLOY_TIMEOUT_MS: "5000",
        VERCEL_DEPLOY_POLL_INTERVAL_MS: "1",
      },
      client,
    });

    expect(result).toEqual({
      status: "deployed",
      repository: "evolvo-auto/habit-cli",
      deployableMarkerPresent: true,
      vercelConfigured: true,
      logs: expect.any(Array),
      project: {
        id: "prj_123",
        name: "habit-cli",
        action: "reused",
      },
      deployment: {
        id: "dpl_123",
        readyState: "READY",
        url: "https://habit-cli-git-main-evolvo-auto.vercel.app",
      },
    });
    expect(client.findProjectsByRepoUrl).toHaveBeenCalledWith("https://github.com/evolvo-auto/habit-cli");
    expect(client.createProject).not.toHaveBeenCalled();
    expect(client.createDeployment).toHaveBeenCalledWith({
      projectName: "habit-cli",
      repoId: 1001,
      ref: "main",
      framework: null,
    });
  });

  it("fails when the deployment settles in a non-ready state", async () => {
    const client = {
      findProjectsByRepoUrl: vi.fn().mockResolvedValue([]),
      getProject: vi.fn().mockRejectedValue(new VercelApiError("not found", 404, null)),
      createProject: vi.fn().mockResolvedValue({
        id: "prj_123",
        name: "habit-cli",
        link: null,
      }),
      createDeployment: vi.fn().mockResolvedValue({
        id: "dpl_123",
        readyState: "BUILDING",
        url: "habit-cli-git-main-evolvo-auto.vercel.app",
      }),
      getDeployment: vi.fn().mockResolvedValue({
        id: "dpl_123",
        readyState: "ERROR",
        url: "habit-cli-git-main-evolvo-auto.vercel.app",
      }),
    };

    const result = await deployProjectRepositoryWithVercel({
      repository: DEPLOYABLE_REPOSITORY,
      env: {
        VERCEL_TOKEN: "vercel-token",
        VERCEL_DEFAULT_FRAMEWORK: "nextjs",
        VERCEL_DEPLOY_TIMEOUT_MS: "5000",
        VERCEL_DEPLOY_POLL_INTERVAL_MS: "1",
      },
      client,
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") {
      throw new Error("Expected deployment result to fail when the deployment settles in an error state.");
    }
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("finished in state ERROR");
    expect(result.project).toEqual({
      id: "prj_123",
      name: "habit-cli",
      action: "created",
    });
  });

  it("fails rather than reusing an unlinked same-name Vercel project", async () => {
    const client = {
      findProjectsByRepoUrl: vi.fn().mockResolvedValue([]),
      getProject: vi.fn().mockResolvedValue({
        id: "prj_123",
        name: "habit-cli",
        link: null,
      }),
      createProject: vi.fn(),
      createDeployment: vi.fn(),
      getDeployment: vi.fn(),
    };

    const result = await deployProjectRepositoryWithVercel({
      repository: DEPLOYABLE_REPOSITORY,
      env: {
        VERCEL_TOKEN: "vercel-token",
      },
      client,
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") {
      throw new Error("Expected deployment result to fail for an unlinked same-name Vercel project.");
    }
    expect(result.reason).toContain("cannot safely reuse");
    expect(client.createProject).not.toHaveBeenCalled();
  });

  it("lists projects by repoUrl with the team scope applied", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        projects: [
          {
            id: "prj_123",
            name: "habit-cli",
            link: {
              org: "evolvo-auto",
              repo: "habit-cli",
              repoId: 1001,
              productionBranch: "main",
            },
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new VercelClient({
      token: "vercel-token",
      teamId: "team_123",
      defaultFramework: null,
      deployTimeoutMs: 1000,
      deployPollIntervalMs: 100,
    });

    const projects = await client.findProjectsByRepoUrl("https://github.com/evolvo-auto/habit-cli");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.vercel.com/v10/projects?repoUrl=https%3A%2F%2Fgithub.com%2Fevolvo-auto%2Fhabit-cli&teamId=team_123",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer vercel-token",
        }),
      }),
    );
    expect(projects).toEqual([
      {
        id: "prj_123",
        name: "habit-cli",
        link: {
          org: "evolvo-auto",
          repo: "habit-cli",
          repoId: 1001,
          productionBranch: "main",
        },
      },
    ]);
  });

  it("creates deployments against the documented Vercel endpoint shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "dpl_123",
        readyState: "BUILDING",
        url: "habit-cli-git-main-evolvo-auto.vercel.app",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new VercelClient({
      token: "vercel-token",
      teamId: null,
      defaultFramework: "nextjs",
      deployTimeoutMs: 1000,
      deployPollIntervalMs: 100,
    });

    const deployment = await client.createDeployment({
      projectName: "habit-cli",
      repoId: 1001,
      ref: "main",
      framework: "nextjs",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.vercel.com/v13/deployments",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          project: "habit-cli",
          target: "production",
          gitSource: {
            type: "github",
            repoId: 1001,
            ref: "main",
          },
          projectSettings: {
            framework: "nextjs",
          },
        }),
      }),
    );
    expect(deployment).toEqual({
      id: "dpl_123",
      readyState: "BUILDING",
      url: "habit-cli-git-main-evolvo-auto.vercel.app",
    });
  });
});
