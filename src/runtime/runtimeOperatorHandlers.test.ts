import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitHubProjectsV2Client } from "../github/githubProjectsV2.js";
import type { TaskIssueManager } from "../issues/taskIssueManager.js";
import { activateProjectInState, readActiveProjectsState } from "../projects/activeProjectsState.js";
import { readProjectActivityState, setProjectActivityMode } from "../projects/projectActivityState.js";
import {
  type DefaultProjectContext,
  type ProjectRecord,
  upsertProjectRecord,
} from "../projects/projectRegistry.js";
import { createDefaultProjectWorkflow } from "../projects/projectWorkflow.js";
import { createDiscordControlHandlers } from "./runtimeOperatorHandlers.js";

function createManagedProjectRecord(workDir: string, slug: string, displayName: string): ProjectRecord {
  const now = "2026-03-08T00:00:00.000Z";
  return {
    slug,
    displayName,
    kind: "managed",
    issueLabel: `project:${slug}`,
    trackerRepo: {
      owner: "evolvo-auto",
      repo: slug,
      url: `https://github.com/evolvo-auto/${slug}`,
    },
    executionRepo: {
      owner: "evolvo-auto",
      repo: slug,
      url: `https://github.com/evolvo-auto/${slug}`,
      defaultBranch: "main",
    },
    cwd: resolve(workDir, slug),
    status: "active",
    sourceIssueNumber: 500,
    createdAt: now,
    updatedAt: now,
    provisioning: {
      labelCreated: true,
      repoCreated: true,
      workspacePrepared: true,
      lastError: null,
    },
    workflow: createDefaultProjectWorkflow("evolvo-auto"),
  };
}

function createDefaultProjectContext(workDir: string): DefaultProjectContext {
  return {
    owner: "evolvo-auto",
    repo: "evolvo-ts",
    workDir,
    defaultBranch: "main",
  };
}

async function createTempWorkDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "runtime-operator-handlers-"));
}

describe("runtimeOperatorHandlers", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
    vi.restoreAllMocks();
  });

  it("rejects start requests for non-registered projects", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    const issueManager = {
      listOpenIssues: vi.fn().mockResolvedValue([]),
      createIssue: vi.fn(),
    };
    const handlers = createDiscordControlHandlers({
      workDir,
      trackerOwner: "evolvo-auto",
      trackerRepo: "evolvo-ts",
      defaultProjectContext: createDefaultProjectContext(workDir),
      issueManager: issueManager as unknown as TaskIssueManager,
      boardsClient: {} as unknown as GitHubProjectsV2Client,
      runtimeState: {
        runtimeStatusState: "active",
        runtimeStatusActivitySummary: "idle",
        runtimeStatusCycle: null,
        runtimeStatusCycleLimit: null,
        runtimeStatusIssue: null,
      },
    });

    const result = await handlers.onStartProject?.({
      messageId: "start-1",
      requestedAt: "2026-03-08T10:00:00.000Z",
      requestedBy: "discord:operator-1",
      mode: "existing",
      displayName: "Missing Project",
      slug: "missing-project",
      repositoryName: "missing-project",
      issueLabel: "project:missing-project",
      workspacePath: "/tmp/missing-project",
    });

    expect(result).toEqual({
      ok: false,
      message: "Project `missing-project` is not registered. Select a registered project with `/startproject existing`.",
    });
    expect(issueManager.listOpenIssues).not.toHaveBeenCalled();
    expect(issueManager.createIssue).not.toHaveBeenCalled();
  });

  it("stops only the targeted project in now mode", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    const defaultProjectContext = createDefaultProjectContext(workDir);
    await upsertProjectRecord(workDir, defaultProjectContext, createManagedProjectRecord(workDir, "habit-cli", "Habit CLI"));
    await upsertProjectRecord(workDir, defaultProjectContext, createManagedProjectRecord(workDir, "evolvo-web", "Evolvo Web"));
    await activateProjectInState({
      workDir,
      slug: "habit-cli",
      requestedBy: "discord:operator-1",
      source: "start-project-command",
      updatedAt: "2026-03-08T10:00:00.000Z",
    });
    await activateProjectInState({
      workDir,
      slug: "evolvo-web",
      requestedBy: "discord:operator-1",
      source: "start-project-command",
      updatedAt: "2026-03-08T10:00:00.000Z",
    });
    await setProjectActivityMode({
      workDir,
      slug: "habit-cli",
      activityState: "active",
      requestedBy: "discord:operator-1",
    });
    await setProjectActivityMode({
      workDir,
      slug: "evolvo-web",
      activityState: "active",
      requestedBy: "discord:operator-1",
    });

    const handlers = createDiscordControlHandlers({
      workDir,
      trackerOwner: "evolvo-auto",
      trackerRepo: "evolvo-ts",
      defaultProjectContext,
      issueManager: {
        listOpenIssues: vi.fn().mockResolvedValue([]),
        createIssue: vi.fn(),
      } as unknown as TaskIssueManager,
      boardsClient: {} as unknown as GitHubProjectsV2Client,
      runtimeState: {
        runtimeStatusState: "active",
        runtimeStatusActivitySummary: "idle",
        runtimeStatusCycle: null,
        runtimeStatusCycleLimit: null,
        runtimeStatusIssue: null,
      },
    });

    const result = await handlers.onStopProject?.({
      messageId: "stop-1",
      requestedAt: "2026-03-08T10:10:00.000Z",
      requestedBy: "discord:operator-1",
      projectName: "Habit CLI",
      projectSlug: "habit-cli",
      mode: "now",
    });

    expect(result).toEqual({
      ok: true,
      action: "stopped",
      message: "Project `habit-cli` will not be scheduled again until `startProject existing <registered-project>` is used.",
      project: {
        displayName: "Habit CLI",
        slug: "habit-cli",
      },
    });

    const activeProjects = await readActiveProjectsState(workDir);
    expect(activeProjects.projects.map((entry) => entry.slug)).toEqual(["evolvo-web"]);

    const activityState = await readProjectActivityState(workDir);
    const habitCliState = activityState.projects.find((entry) => entry.slug === "habit-cli");
    const evolvoWebState = activityState.projects.find((entry) => entry.slug === "evolvo-web");
    expect(habitCliState?.activityState).toBe("stopped");
    expect(evolvoWebState?.activityState).toBe("active");
  });

  it("does not reactivate a stopped project when stop mode is whenComplete", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    const defaultProjectContext = createDefaultProjectContext(workDir);
    await upsertProjectRecord(workDir, defaultProjectContext, createManagedProjectRecord(workDir, "habit-cli", "Habit CLI"));
    await setProjectActivityMode({
      workDir,
      slug: "habit-cli",
      activityState: "stopped",
      requestedBy: "discord:operator-1",
    });

    const handlers = createDiscordControlHandlers({
      workDir,
      trackerOwner: "evolvo-auto",
      trackerRepo: "evolvo-ts",
      defaultProjectContext,
      issueManager: {
        listOpenIssues: vi.fn().mockResolvedValue([]),
        createIssue: vi.fn(),
      } as unknown as TaskIssueManager,
      boardsClient: {} as unknown as GitHubProjectsV2Client,
      runtimeState: {
        runtimeStatusState: "active",
        runtimeStatusActivitySummary: "idle",
        runtimeStatusCycle: null,
        runtimeStatusCycleLimit: null,
        runtimeStatusIssue: null,
      },
    });

    const result = await handlers.onStopProject?.({
      messageId: "stop-2",
      requestedAt: "2026-03-08T10:20:00.000Z",
      requestedBy: "discord:operator-1",
      projectName: "Habit CLI",
      projectSlug: "habit-cli",
      mode: "when-project-complete",
    });

    expect(result).toEqual({
      ok: true,
      action: "already-stopped",
      message: "Project `habit-cli` is already halted. Use `startProject existing <registered-project>` to resume it later.",
      project: {
        displayName: "Habit CLI",
        slug: "habit-cli",
      },
    });

    const activityState = await readProjectActivityState(workDir);
    const habitCliState = activityState.projects.find((entry) => entry.slug === "habit-cli");
    expect(habitCliState?.activityState).toBe("stopped");
    expect(habitCliState?.deferredStopMode).toBeNull();
  });
});
