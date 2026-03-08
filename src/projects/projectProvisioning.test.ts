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
        workspaceRelativePath: "projects/habit-cli",
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
            workspaceRelativePath: "projects/habit-cli",
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
        cwd: resolve(workDir, "projects", "habit-cli"),
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
    });

    expect(result).toEqual({
      ok: true,
      action: "created",
      message: "Created provisioning issue #405 for project `habit-cli`.",
      project: {
        displayName: "Habit CLI",
        slug: "habit-cli",
        repositoryName: "habit-cli",
        workspacePath: "projects/habit-cli",
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
      updatedAt: "2026-03-08T08:00:00.000Z",
      requestedBy: "discord:operator-1",
      source: "start-project-command",
    });
  });

  it("resumes an existing active project without creating a new provisioning issue", async () => {
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
        cwd: resolve(workDir, "projects", "habit-cli"),
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
    });

    expect(result).toEqual({
      ok: true,
      action: "resumed",
      message: "Resumed existing project `habit-cli`.",
      project: {
        displayName: "Habit CLI",
        slug: "habit-cli",
        repositoryName: "habit-cli",
        repositoryUrl: "https://github.com/evolvo-auto/habit-cli",
        workspacePath: resolve(workDir, "projects", "habit-cli"),
        status: "active",
      },
    });
    expect(issueManager.createIssue).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(getActiveProjectStatePath(workDir), "utf8"))).toEqual({
      version: 2,
      activeProjectSlug: "habit-cli",
      selectionState: "active",
      updatedAt: "2026-03-08T08:05:00.000Z",
      requestedBy: "discord:operator-1",
      source: "start-project-command",
    });
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
        cwd: resolve(workDir, "projects", "habit-cli"),
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
            workspaceRelativePath: "projects/habit-cli",
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
    });

    expect(result).toEqual({
      ok: true,
      action: "resumed",
      message: "Resumed existing project `habit-cli` and kept recovery issue #406 active.",
      project: {
        displayName: "Habit CLI",
        slug: "habit-cli",
        repositoryName: "habit-cli",
        repositoryUrl: "https://github.com/evolvo-auto/habit-cli",
        workspacePath: resolve(workDir, "projects", "habit-cli"),
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
        cwd: resolve(workDir, "projects", "habit-cli"),
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
    });

    expect(result).toEqual({
      ok: true,
      action: "resumed",
      message: "Resumed existing project `habit-cli` and queued recovery issue #407.",
      project: {
        displayName: "Habit CLI",
        slug: "habit-cli",
        repositoryName: "habit-cli",
        repositoryUrl: "https://github.com/evolvo-auto/habit-cli",
        workspacePath: resolve(workDir, "projects", "habit-cli"),
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
      updatedAt: "2026-03-08T08:15:00.000Z",
      requestedBy: "discord:operator-1",
      source: "start-project-command",
    });
  });

  it("provisions a managed project and records active registry state on success", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    const issue = createProvisioningIssue(
      buildProjectProvisioningIssueBody({
        owner: "evolvo-auto",
        displayName: "Habit CLI",
        slug: "habit-cli",
        repositoryName: "habit-cli",
        issueLabel: "project:habit-cli",
        workspaceRelativePath: "projects/habit-cli",
        requestedBy: "discord:operator-1",
        requestedAt: "2026-03-07T12:00:00.000Z",
      }),
    );
    const adminClient = {
      ensureLabel: vi.fn().mockResolvedValue(undefined),
      ensureRepository: vi.fn().mockResolvedValue({
        owner: "evolvo-auto",
        repo: "habit-cli",
        url: "https://github.com/evolvo-auto/habit-cli",
        defaultBranch: "main",
      }),
    };

    const result = await executeProjectProvisioningIssue({
      issue,
      workDir,
      trackerOwner: "evolvo-auto",
      trackerRepo: "evolvo-ts",
      adminClient,
    });

    expect(isProjectProvisioningRequestIssue(issue)).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.failureStep).toBeNull();
    expect(result.record.status).toBe("active");
    expect(result.record.provisioning).toEqual({
      labelCreated: true,
      repoCreated: true,
      workspacePrepared: true,
      lastError: null,
    });
    expect(buildProjectProvisioningCompletionSummary(result)).toContain("Provisioned managed project `Habit CLI`.");
    expect(buildProjectProvisioningOutcomeComment(result)).toContain("- Outcome: succeeded.");

    const registry = JSON.parse(await readFile(getProjectRegistryPath(workDir), "utf8")) as {
      projects: Array<{ slug: string; status: string; provisioning: { repoCreated: boolean } }>;
    };
    const managedProject = registry.projects.find((project) => project.slug === "habit-cli");
    expect(managedProject).toEqual(
      expect.objectContaining({
        slug: "habit-cli",
        status: "active",
        provisioning: expect.objectContaining({
          repoCreated: true,
        }),
      }),
    );
    expect(resolve(workDir, "projects", "habit-cli")).toBe(result.record.cwd);
    expect(JSON.parse(await readFile(getActiveProjectStatePath(workDir), "utf8"))).toEqual({
      version: 2,
      activeProjectSlug: "habit-cli",
      selectionState: "active",
      updatedAt: expect.any(String),
      requestedBy: "discord:operator-1",
      source: "project-provisioning",
    });
  });

  it("preserves partial success in failed registry state when workspace preparation fails", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    await writeFile(join(workDir, "projects"), "not a directory", "utf8");
    const issue = createProvisioningIssue(
      buildProjectProvisioningIssueBody({
        owner: "evolvo-auto",
        displayName: "Habit CLI",
        slug: "habit-cli",
        repositoryName: "habit-cli",
        issueLabel: "project:habit-cli",
        workspaceRelativePath: "projects/habit-cli",
        requestedBy: "discord:operator-1",
        requestedAt: "2026-03-07T12:00:00.000Z",
      }),
    );
    const adminClient = {
      ensureLabel: vi.fn().mockResolvedValue(undefined),
      ensureRepository: vi.fn().mockResolvedValue({
        owner: "evolvo-auto",
        repo: "habit-cli",
        url: "https://github.com/evolvo-auto/habit-cli",
        defaultBranch: "main",
      }),
    };

    const result = await executeProjectProvisioningIssue({
      issue,
      workDir,
      trackerOwner: "evolvo-auto",
      trackerRepo: "evolvo-ts",
      adminClient,
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
});
