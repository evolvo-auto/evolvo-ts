import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProjectProvisioningIssueBody } from "../issues/projectProvisioningIssue.js";
import type { IssueSummary } from "../issues/taskIssueManager.js";
import {
  buildProjectProvisioningCompletionSummary,
  buildProjectProvisioningOutcomeComment,
  createProjectProvisioningRequestIssue,
  executeProjectProvisioningIssue,
  handleStartProjectCommand,
  isProjectProvisioningRequestIssue,
} from "./projectProvisioning.js";
import { getProjectRegistryPath, upsertProjectRecord } from "./projectRegistry.js";
import { getActiveProjectStatePath } from "./activeProjectState.js";

async function createTempWorkDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "project-provisioning-"));
}

function createManagedWorkspacePath(workDir: string, slug = "habit-cli"): string {
  return resolve(workDir, slug);
}

function createProvisioningIssue(description: string): IssueSummary {
  return {
    number: 318,
    title: "Start project Habit CLI",
    description,
    state: "open",
    labels: [],
  };
}

describe("projectProvisioning", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
    vi.restoreAllMocks();
  });

  it("creates a tracker provisioning issue for a normalized project request", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    const issueManager = {
      listOpenIssues: vi.fn().mockResolvedValue([]),
      createIssue: vi.fn().mockResolvedValue({
        ok: true,
        message: "Created issue #401.",
        issue: {
          number: 401,
          title: "Start project Habit CLI",
          description: "body",
          state: "open",
          labels: [],
        },
      }),
    };

    const result = await createProjectProvisioningRequestIssue({
      issueManager,
      workDir,
      trackerOwner: "evolvo-auto",
      trackerRepo: "evolvo-ts",
      projectName: " Habit   CLI ",
      requestedBy: "discord:operator-1",
      requestedAt: "2026-03-07T12:00:00.000Z",
      workspaceRoot: workDir,
    });

    expect(result).toEqual({
      ok: true,
      message: "Created issue #401.",
      issueNumber: 401,
      issueUrl: "https://github.com/evolvo-auto/evolvo-ts/issues/401",
      metadata: {
        owner: "evolvo-auto",
        displayName: "Habit CLI",
        slug: "habit-cli",
        repositoryName: "habit-cli",
        issueLabel: "project:habit-cli",
        workspacePath: createManagedWorkspacePath(workDir),
        requestedBy: "discord:operator-1",
        requestedAt: "2026-03-07T12:00:00.000Z",
      },
    });
    expect(issueManager.createIssue).toHaveBeenCalledWith(
      "Start project Habit CLI",
      expect.stringContaining("project:habit-cli"),
    );
  });

  it("rejects duplicate open provisioning requests for the same slug", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    const issueManager = {
      listOpenIssues: vi.fn().mockResolvedValue([
        {
          number: 402,
          title: "Start project Habit CLI",
          description: buildProjectProvisioningIssueBody({
            owner: "evolvo-auto",
            displayName: "Habit CLI",
            slug: "habit-cli",
            repositoryName: "habit-cli",
            issueLabel: "project:habit-cli",
            workspacePath: createManagedWorkspacePath(workDir),
            requestedBy: "discord:operator-1",
            requestedAt: "2026-03-07T12:00:00.000Z",
          }),
          state: "open",
          labels: [],
        },
      ]),
      createIssue: vi.fn(),
    };

    const result = await createProjectProvisioningRequestIssue({
      issueManager,
      workDir,
      trackerOwner: "evolvo-auto",
      trackerRepo: "evolvo-ts",
      projectName: "Habit CLI",
      requestedBy: "discord:operator-1",
      workspaceRoot: workDir,
    });

    expect(result).toEqual({
      ok: false,
      message: "Project `habit-cli` already has an open provisioning request issue #402.",
    });
    expect(issueManager.createIssue).not.toHaveBeenCalled();
  });

  it("allows a new provisioning request when the existing registry record is failed", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    await upsertProjectRecord(
      workDir,
      {
        owner: "evolvo-auto",
        repo: "evolvo-ts",
        workDir,
      },
      {
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
        cwd: createManagedWorkspacePath(workDir),
        status: "failed",
        sourceIssueNumber: 318,
        createdAt: "2026-03-07T12:00:00.000Z",
        updatedAt: "2026-03-07T12:00:00.000Z",
        provisioning: {
          labelCreated: true,
          repoCreated: true,
          workspacePrepared: false,
          lastError: "workspace creation failed",
        },
      },
    );
    const issueManager = {
      listOpenIssues: vi.fn().mockResolvedValue([]),
      createIssue: vi.fn().mockResolvedValue({
        ok: true,
        message: "Created issue #403.",
        issue: {
          number: 403,
          title: "Start project Habit CLI",
          description: "body",
          state: "open",
          labels: [],
        },
      }),
    };

    const result = await createProjectProvisioningRequestIssue({
      issueManager,
      workDir,
      trackerOwner: "evolvo-auto",
      trackerRepo: "evolvo-ts",
      projectName: "Habit CLI",
      requestedBy: "discord:operator-1",
      workspaceRoot: workDir,
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        issueNumber: 403,
      }),
    );
    expect(issueManager.createIssue).toHaveBeenCalledTimes(1);
  });

  it("recovers a malformed registry before creating a provisioning request issue", async () => {
    vi.useFakeTimers();
    const recoveryAtMs = new Date("2026-03-07T23:30:00.000Z").getTime();
    vi.setSystemTime(recoveryAtMs);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    const registryPath = getProjectRegistryPath(workDir);
    const corruptPath = join(workDir, ".evolvo", `projects.corrupt-${recoveryAtMs}.json`);
    await mkdir(join(workDir, ".evolvo"), { recursive: true });
    await writeFile(registryPath, "{\"projects\":", "utf8");
    const issueManager = {
      listOpenIssues: vi.fn().mockResolvedValue([]),
      createIssue: vi.fn().mockResolvedValue({
        ok: true,
        message: "Created issue #404.",
        issue: {
          number: 404,
          title: "Start project Habit CLI",
          description: "body",
          state: "open",
          labels: [],
        },
      }),
    };

    const result = await createProjectProvisioningRequestIssue({
      issueManager,
      workDir,
      trackerOwner: "evolvo-auto",
      trackerRepo: "evolvo-ts",
      projectName: "Habit CLI",
      requestedBy: "discord:operator-1",
      workspaceRoot: workDir,
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        issueNumber: 404,
      }),
    );
    expect(await readFile(corruptPath, "utf8")).toBe("{\"projects\":");
    expect(JSON.parse(await readFile(registryPath, "utf8"))).toEqual({
      version: 1,
      projects: [
        expect.objectContaining({
          slug: "evolvo",
        }),
      ],
    });
    expect(warnSpy).toHaveBeenCalledWith(
      `Recovered malformed project registry at ${registryPath}; preserved corrupt file at ${corruptPath}.`,
    );
  });

  it("creates a missing project start flow and stores the requested project as active", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    const issueManager = {
      listOpenIssues: vi.fn().mockResolvedValue([]),
      createIssue: vi.fn().mockResolvedValue({
        ok: true,
        message: "Created issue #405.",
        issue: {
          number: 405,
          title: "Start project Habit CLI",
          description: "body",
          state: "open",
          labels: [],
        },
      }),
    };

    const result = await handleStartProjectCommand({
      issueManager,
      workDir,
      trackerOwner: "evolvo-auto",
      trackerRepo: "evolvo-ts",
      projectName: "Habit CLI",
      requestedBy: "discord:operator-1",
      requestedAt: "2026-03-08T08:00:00.000Z",
      workspaceRoot: workDir,
    });

    expect(result).toEqual({
      ok: true,
      action: "created",
      message: `Created provisioning issue #405 for project \`habit-cli\`. Canonical workspace: \`${createManagedWorkspacePath(workDir)}\`.`,
      project: {
        displayName: "Habit CLI",
        slug: "habit-cli",
        repositoryName: "habit-cli",
        workspacePath: createManagedWorkspacePath(workDir),
        status: "provisioning",
      },
      trackerIssue: {
        number: 405,
        url: "https://github.com/evolvo-auto/evolvo-ts/issues/405",
        alreadyOpen: false,
      },
    });
    expect(JSON.parse(await readFile(getActiveProjectStatePath(workDir), "utf8"))).toEqual({
      version: 2,
      activeProjectSlug: "habit-cli",
      selectionState: "active",
      deferredStopMode: null,
      updatedAt: "2026-03-08T08:00:00.000Z",
      requestedBy: "discord:operator-1",
      source: "start-project-command",
    });
  });

  it("resumes an existing active project without creating a new provisioning issue", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await mkdir(createManagedWorkspacePath(workDir), { recursive: true });
    await upsertProjectRecord(
      workDir,
      {
        owner: "evolvo-auto",
        repo: "evolvo-ts",
        workDir,
      },
      {
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
        cwd: createManagedWorkspacePath(workDir),
        status: "active",
        sourceIssueNumber: 318,
        createdAt: "2026-03-07T12:00:00.000Z",
        updatedAt: "2026-03-07T12:00:00.000Z",
        provisioning: {
          labelCreated: true,
          repoCreated: true,
          workspacePrepared: true,
          lastError: null,
        },
      },
    );
    const issueManager = {
      listOpenIssues: vi.fn().mockResolvedValue([]),
      createIssue: vi.fn(),
    };

    const result = await handleStartProjectCommand({
      issueManager,
      workDir,
      trackerOwner: "evolvo-auto",
      trackerRepo: "evolvo-ts",
      projectName: "Habit CLI",
      requestedBy: "discord:operator-1",
      requestedAt: "2026-03-08T08:05:00.000Z",
      workspaceRoot: workDir,
    });

    expect(result).toEqual({
      ok: true,
      action: "resumed",
      message: `Resumed existing project \`habit-cli\`. Reused existing workspace directory \`${createManagedWorkspacePath(workDir)}\`, and that path is now the active working directory.`,
      project: {
        displayName: "Habit CLI",
        slug: "habit-cli",
        repositoryName: "habit-cli",
        repositoryUrl: "https://github.com/evolvo-auto/habit-cli",
        workspacePath: createManagedWorkspacePath(workDir),
        status: "active",
      },
    });
    expect(issueManager.createIssue).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(getActiveProjectStatePath(workDir), "utf8"))).toEqual({
      version: 2,
      activeProjectSlug: "habit-cli",
      selectionState: "active",
      deferredStopMode: null,
      updatedAt: "2026-03-08T08:05:00.000Z",
      requestedBy: "discord:operator-1",
      source: "start-project-command",
    });
    const registry = JSON.parse(await readFile(getProjectRegistryPath(workDir), "utf8")) as {
      projects: Array<{ slug: string; trackerRepo: { owner: string; repo: string; url: string } }>;
    };
    expect(registry.projects.find((project) => project.slug === "habit-cli")).toEqual(
      expect.objectContaining({
        trackerRepo: {
          owner: "evolvo-auto",
          repo: "habit-cli",
          url: "https://github.com/evolvo-auto/habit-cli",
        },
      }),
    );
    expect(logSpy).toHaveBeenCalledWith(
      `[project-workspace] resolved ${createManagedWorkspacePath(workDir)}; reused existing directory; ${createManagedWorkspacePath(workDir)} is now the active working directory for project habit-cli.`,
    );
    expect(logSpy).toHaveBeenCalledWith(
      "[project-registry] corrected tracker repository for project habit-cli; projects.json now records evolvo-auto/habit-cli.",
    );
  });

  it("resumes a failed project by reusing its existing recovery issue", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    await upsertProjectRecord(
      workDir,
      {
        owner: "evolvo-auto",
        repo: "evolvo-ts",
        workDir,
      },
      {
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
        cwd: createManagedWorkspacePath(workDir),
        status: "failed",
        sourceIssueNumber: 318,
        createdAt: "2026-03-07T12:00:00.000Z",
        updatedAt: "2026-03-07T12:00:00.000Z",
        provisioning: {
          labelCreated: true,
          repoCreated: true,
          workspacePrepared: false,
          lastError: "workspace failed",
        },
      },
    );
    const issueManager = {
      listOpenIssues: vi.fn().mockResolvedValue([
        {
          number: 406,
          title: "Start project Habit CLI",
          description: buildProjectProvisioningIssueBody({
            owner: "evolvo-auto",
            displayName: "Habit CLI",
            slug: "habit-cli",
            repositoryName: "habit-cli",
            issueLabel: "project:habit-cli",
            workspacePath: createManagedWorkspacePath(workDir),
            requestedBy: "discord:operator-1",
            requestedAt: "2026-03-08T07:50:00.000Z",
          }),
          state: "open",
          labels: [],
        },
      ]),
      createIssue: vi.fn(),
    };

    const result = await handleStartProjectCommand({
      issueManager,
      workDir,
      trackerOwner: "evolvo-auto",
      trackerRepo: "evolvo-ts",
      projectName: "Habit CLI",
      requestedBy: "discord:operator-1",
      requestedAt: "2026-03-08T08:10:00.000Z",
      workspaceRoot: workDir,
    });

    expect(result).toEqual({
      ok: true,
      action: "resumed",
      message: `Resumed existing project \`habit-cli\` and kept recovery issue #406 active. Canonical workspace: \`${createManagedWorkspacePath(workDir)}\`.`,
      project: {
        displayName: "Habit CLI",
        slug: "habit-cli",
        repositoryName: "habit-cli",
        repositoryUrl: "https://github.com/evolvo-auto/habit-cli",
        workspacePath: createManagedWorkspacePath(workDir),
        status: "failed",
      },
      trackerIssue: {
        number: 406,
        url: "https://github.com/evolvo-auto/evolvo-ts/issues/406",
        alreadyOpen: true,
      },
    });
    expect(issueManager.createIssue).not.toHaveBeenCalled();
  });

  it("resumes a failed project by queuing a recovery issue when none is open", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    await upsertProjectRecord(
      workDir,
      {
        owner: "evolvo-auto",
        repo: "evolvo-ts",
        workDir,
      },
      {
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
        cwd: createManagedWorkspacePath(workDir),
        status: "failed",
        sourceIssueNumber: 318,
        createdAt: "2026-03-07T12:00:00.000Z",
        updatedAt: "2026-03-07T12:00:00.000Z",
        provisioning: {
          labelCreated: true,
          repoCreated: true,
          workspacePrepared: false,
          lastError: "workspace failed",
        },
      },
    );
    const issueManager = {
      listOpenIssues: vi.fn().mockResolvedValue([]),
      createIssue: vi.fn().mockResolvedValue({
        ok: true,
        message: "Created issue #407.",
        issue: {
          number: 407,
          title: "Start project Habit CLI",
          description: "body",
          state: "open",
          labels: [],
        },
      }),
    };

    const result = await handleStartProjectCommand({
      issueManager,
      workDir,
      trackerOwner: "evolvo-auto",
      trackerRepo: "evolvo-ts",
      projectName: "Habit CLI",
      requestedBy: "discord:operator-1",
      requestedAt: "2026-03-08T08:15:00.000Z",
      workspaceRoot: workDir,
    });

    expect(result).toEqual({
      ok: true,
      action: "resumed",
      message: `Resumed existing project \`habit-cli\` and queued recovery issue #407. Canonical workspace: \`${createManagedWorkspacePath(workDir)}\`.`,
      project: {
        displayName: "Habit CLI",
        slug: "habit-cli",
        repositoryName: "habit-cli",
        repositoryUrl: "https://github.com/evolvo-auto/habit-cli",
        workspacePath: createManagedWorkspacePath(workDir),
        status: "failed",
      },
      trackerIssue: {
        number: 407,
        url: "https://github.com/evolvo-auto/evolvo-ts/issues/407",
        alreadyOpen: false,
      },
    });
    expect(JSON.parse(await readFile(getActiveProjectStatePath(workDir), "utf8"))).toEqual({
      version: 2,
      activeProjectSlug: "habit-cli",
      selectionState: "active",
      deferredStopMode: null,
      updatedAt: "2026-03-08T08:15:00.000Z",
      requestedBy: "discord:operator-1",
      source: "start-project-command",
    });
  });

  it("provisions a managed project and records active registry state on success", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const deployRepository = vi.fn().mockResolvedValue({
      status: "skipped",
      repository: "evolvo-auto/habit-cli",
      deployableMarkerPresent: false,
      vercelConfigured: false,
      reason: "Repository description does not include <deployable>.",
      logs: [
        "[deploy] evaluating repository evolvo-auto/habit-cli for Vercel deployment.",
        "[deploy] deployable marker present for evolvo-auto/habit-cli: no.",
        "[deploy] deployment skipped for evolvo-auto/habit-cli: repository description is not marked with <deployable>.",
      ],
    });
    const issue = createProvisioningIssue(
      buildProjectProvisioningIssueBody({
        owner: "evolvo-auto",
        displayName: "Habit CLI",
        slug: "habit-cli",
        repositoryName: "habit-cli",
        issueLabel: "project:habit-cli",
        workspacePath: createManagedWorkspacePath(workDir),
        requestedBy: "discord:operator-1",
        requestedAt: "2026-03-07T12:00:00.000Z",
      }),
    );
    const adminClient = {
      ensureLabel: vi.fn().mockResolvedValue(undefined),
      ensureRepository: vi.fn().mockResolvedValue({
        id: 1001,
        owner: "evolvo-auto",
        repo: "habit-cli",
        url: "https://github.com/evolvo-auto/habit-cli",
        defaultBranch: "main",
        description: "Managed by Evolvo for project Habit CLI.",
      }),
    };

    const result = await executeProjectProvisioningIssue({
      issue,
      workDir,
      trackerOwner: "evolvo-auto",
      trackerRepo: "evolvo-ts",
      adminClient,
      workspaceRoot: workDir,
      deployRepository,
    });

    expect(isProjectProvisioningRequestIssue(issue)).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.failureStep).toBeNull();
    expect(result.record.status).toBe("active");
    expect(result.record.trackerRepo).toEqual({
      owner: "evolvo-auto",
      repo: "habit-cli",
      url: "https://github.com/evolvo-auto/habit-cli",
    });
    expect(result.record.provisioning).toEqual({
      labelCreated: true,
      repoCreated: true,
      workspacePrepared: true,
      lastError: null,
    });
    expect(result.deployment).toEqual({
      status: "skipped",
      repository: "evolvo-auto/habit-cli",
      deployableMarkerPresent: false,
      vercelConfigured: false,
      reason: "Repository description does not include <deployable>.",
      logs: expect.any(Array),
    });
    expect(buildProjectProvisioningCompletionSummary(result)).toContain("Provisioned managed project `Habit CLI`.");
    expect(buildProjectProvisioningOutcomeComment(result)).toContain("- Outcome: succeeded.");
    expect(buildProjectProvisioningOutcomeComment(result)).toContain("- Deployment: skipped for `evolvo-auto/habit-cli`.");

    const registry = JSON.parse(await readFile(getProjectRegistryPath(workDir), "utf8")) as {
      projects: Array<{
        slug: string;
        status: string;
        trackerRepo: { owner: string; repo: string; url: string };
        provisioning: { repoCreated: boolean };
      }>;
    };
    const managedProject = registry.projects.find((project) => project.slug === "habit-cli");
    expect(managedProject).toEqual(
      expect.objectContaining({
        slug: "habit-cli",
        status: "active",
        trackerRepo: {
          owner: "evolvo-auto",
          repo: "habit-cli",
          url: "https://github.com/evolvo-auto/habit-cli",
        },
        provisioning: expect.objectContaining({
          repoCreated: true,
        }),
      }),
    );
    expect(createManagedWorkspacePath(workDir)).toBe(result.record.cwd);
    expect(JSON.parse(await readFile(getActiveProjectStatePath(workDir), "utf8"))).toEqual({
      version: 2,
      activeProjectSlug: "habit-cli",
      selectionState: "active",
      deferredStopMode: null,
      updatedAt: expect.any(String),
      requestedBy: "discord:operator-1",
      source: "project-provisioning",
    });
    expect(logSpy).toHaveBeenCalledWith(
      `[project-workspace] resolved ${createManagedWorkspacePath(workDir)}; created directory; ${createManagedWorkspacePath(workDir)} is now the active working directory for project habit-cli.`,
    );
    expect(logSpy).toHaveBeenCalledWith(
      "[project-registry] project habit-cli repository created: evolvo-auto/habit-cli; tracker repository written to projects.json: evolvo-auto/habit-cli.",
    );
    expect(deployRepository).toHaveBeenCalledWith({
      repository: {
        id: 1001,
        owner: "evolvo-auto",
        repo: "habit-cli",
        url: "https://github.com/evolvo-auto/habit-cli",
        defaultBranch: "main",
        description: "Managed by Evolvo for project Habit CLI.",
      },
    });
  });

  it("preserves partial success in failed registry state when workspace preparation fails", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    await writeFile(createManagedWorkspacePath(workDir), "not a directory", "utf8");
    const issue = createProvisioningIssue(
      buildProjectProvisioningIssueBody({
        owner: "evolvo-auto",
        displayName: "Habit CLI",
        slug: "habit-cli",
        repositoryName: "habit-cli",
        issueLabel: "project:habit-cli",
        workspacePath: createManagedWorkspacePath(workDir),
        requestedBy: "discord:operator-1",
        requestedAt: "2026-03-07T12:00:00.000Z",
      }),
    );
    const adminClient = {
      ensureLabel: vi.fn().mockResolvedValue(undefined),
      ensureRepository: vi.fn().mockResolvedValue({
        id: 1001,
        owner: "evolvo-auto",
        repo: "habit-cli",
        url: "https://github.com/evolvo-auto/habit-cli",
        defaultBranch: "main",
        description: "Managed by Evolvo for project Habit CLI.",
      }),
    };

    const result = await executeProjectProvisioningIssue({
      issue,
      workDir,
      trackerOwner: "evolvo-auto",
      trackerRepo: "evolvo-ts",
      adminClient,
      workspaceRoot: workDir,
    });

    expect(result.ok).toBe(false);
    expect(result.failureStep).toBe("workspace");
    expect(result.record.status).toBe("failed");
    expect(result.record.provisioning).toEqual({
      labelCreated: true,
      repoCreated: true,
      workspacePrepared: false,
      lastError: expect.any(String),
    });
    expect(buildProjectProvisioningOutcomeComment(result)).toContain("- Outcome: failed.");
    expect(buildProjectProvisioningOutcomeComment(result)).toContain("- Recovery: inspect `.evolvo/projects.json`");

    const registry = JSON.parse(await readFile(getProjectRegistryPath(workDir), "utf8")) as {
      projects: Array<{
        slug: string;
        status: string;
        provisioning: {
          labelCreated: boolean;
          repoCreated: boolean;
          workspacePrepared: boolean;
          lastError: string | null;
        };
      }>;
    };
    const managedProject = registry.projects.find((project) => project.slug === "habit-cli");
    expect(managedProject).toEqual(
      expect.objectContaining({
        slug: "habit-cli",
        status: "failed",
        provisioning: {
          labelCreated: true,
          repoCreated: true,
          workspacePrepared: false,
          lastError: expect.any(String),
        },
      }),
    );
  });

  it("fails provisioning clearly when a deployable repository cannot be deployed", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    const deployRepository = vi.fn().mockResolvedValue({
      status: "failed",
      repository: "evolvo-auto/habit-cli",
      deployableMarkerPresent: true,
      vercelConfigured: false,
      reason: "Repository is marked <deployable> but Vercel configuration is missing: VERCEL_TOKEN.",
      logs: [
        "[deploy] evaluating repository evolvo-auto/habit-cli for Vercel deployment.",
        "[deploy] deployable marker present for evolvo-auto/habit-cli: yes.",
        "[deploy] Vercel configuration available for evolvo-auto/habit-cli: no.",
      ],
      project: null,
      deployment: null,
    });
    const issue = createProvisioningIssue(
      buildProjectProvisioningIssueBody({
        owner: "evolvo-auto",
        displayName: "Habit CLI",
        slug: "habit-cli",
        repositoryName: "habit-cli",
        issueLabel: "project:habit-cli",
        workspacePath: createManagedWorkspacePath(workDir),
        requestedBy: "discord:operator-1",
        requestedAt: "2026-03-07T12:00:00.000Z",
      }),
    );
    const adminClient = {
      ensureLabel: vi.fn().mockResolvedValue(undefined),
      ensureRepository: vi.fn().mockResolvedValue({
        id: 1001,
        owner: "evolvo-auto",
        repo: "habit-cli",
        url: "https://github.com/evolvo-auto/habit-cli",
        defaultBranch: "main",
        description: "Managed by Evolvo for project Habit CLI. <deployable>",
      }),
    };

    const result = await executeProjectProvisioningIssue({
      issue,
      workDir,
      trackerOwner: "evolvo-auto",
      trackerRepo: "evolvo-ts",
      adminClient,
      workspaceRoot: workDir,
      deployRepository,
    });

    expect(result.ok).toBe(false);
    expect(result.failureStep).toBe("deployment");
    expect(result.record.status).toBe("failed");
    expect(result.message).toContain("Repository is marked <deployable>");
    expect(buildProjectProvisioningOutcomeComment(result)).toContain("- Deployment: failed for `evolvo-auto/habit-cli`.");
    expect(buildProjectProvisioningOutcomeComment(result)).toContain("Vercel configuration is missing");
  });
});
