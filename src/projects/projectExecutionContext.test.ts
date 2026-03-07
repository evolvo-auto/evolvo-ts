import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { IssueSummary } from "../issues/taskIssueManager.js";
import { DEFAULT_PROJECT_SLUG } from "./projectNaming.js";
import {
  buildProjectRoutingBlockedComment,
  resolveProjectExecutionContextForIssue,
  resolveProjectExecutionContextFromRegistry,
} from "./projectExecutionContext.js";
import {
  readProjectRegistry,
  upsertProjectRecord,
  type ProjectRecord,
} from "./projectRegistry.js";

async function createTempWorkDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "project-execution-context-"));
}

function createIssue(overrides: Partial<IssueSummary> = {}): IssueSummary {
  return {
    number: 42,
    title: "Route this issue",
    description: "context",
    state: "open",
    labels: [],
    ...overrides,
  };
}

function createManagedProject(workDir: string, overrides: Partial<ProjectRecord> = {}): ProjectRecord {
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
    cwd: join(workDir, "projects", "habit-cli"),
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
    ...overrides,
  };
}

describe("projectExecutionContext", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("resolves unlabeled issues to the default Evolvo project", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    const resolution = await resolveProjectExecutionContextForIssue({
      issue: createIssue(),
      workDir,
      defaultProject: {
        owner: "evolvo-auto",
        repo: "evolvo-ts",
        workDir,
        defaultBranch: "main",
      },
    });

    expect(resolution).toEqual({
      ok: true,
      context: expect.objectContaining({
        project: expect.objectContaining({
          slug: DEFAULT_PROJECT_SLUG,
          issueLabel: "project:evolvo",
          cwd: workDir,
        }),
        trackerRepository: "evolvo-auto/evolvo-ts",
        executionRepository: "evolvo-auto/evolvo-ts",
      }),
    });
  });

  it("treats project:evolvo as the default project alias", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    const registry = await readProjectRegistry(workDir, {
      owner: "evolvo-auto",
      repo: "evolvo-ts",
      workDir,
      defaultBranch: "main",
    });

    const resolution = resolveProjectExecutionContextFromRegistry(
      createIssue({ labels: ["project:evolvo"] }),
      registry,
    );

    expect(resolution).toEqual({
      ok: true,
      context: expect.objectContaining({
        project: expect.objectContaining({
          slug: DEFAULT_PROJECT_SLUG,
        }),
      }),
    });
  });

  it("resolves project-labelled issues to the matching managed project", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    await upsertProjectRecord(
      workDir,
      {
        owner: "evolvo-auto",
        repo: "evolvo-ts",
        workDir,
        defaultBranch: "main",
      },
      createManagedProject(workDir),
    );

    const resolution = await resolveProjectExecutionContextForIssue({
      issue: createIssue({ labels: ["project:habit-cli"] }),
      workDir,
      defaultProject: {
        owner: "evolvo-auto",
        repo: "evolvo-ts",
        workDir,
        defaultBranch: "main",
      },
    });

    expect(resolution).toEqual({
      ok: true,
      context: expect.objectContaining({
        project: expect.objectContaining({
          slug: "habit-cli",
          cwd: join(workDir, "projects", "habit-cli"),
        }),
        trackerRepository: "evolvo-auto/evolvo-ts",
        executionRepository: "evolvo-auto/habit-cli",
      }),
    });
  });

  it("blocks issues with unknown project labels and gives actionable guidance", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    const registry = await readProjectRegistry(workDir, {
      owner: "evolvo-auto",
      repo: "evolvo-ts",
      workDir,
      defaultBranch: "main",
    });

    const resolution = resolveProjectExecutionContextFromRegistry(
      createIssue({ labels: ["project:missing-project"] }),
      registry,
    );

    expect(resolution).toEqual({
      ok: false,
      code: "unknown-project",
      message: "No project registry entry exists for label `project:missing-project`.",
      projectLabels: ["project:missing-project"],
    });
    if (resolution.ok) {
      throw new Error("Expected project resolution to be blocked for an unknown project label.");
    }
    expect(buildProjectRoutingBlockedComment(createIssue(), resolution)).toContain("remove the `blocked` label to retry execution");
  });

  it("blocks issues with multiple project labels", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    const registry = await readProjectRegistry(workDir, {
      owner: "evolvo-auto",
      repo: "evolvo-ts",
      workDir,
      defaultBranch: "main",
    });

    const resolution = resolveProjectExecutionContextFromRegistry(
      createIssue({ labels: ["project:habit-cli", "project:other-project"] }),
      registry,
    );

    expect(resolution).toEqual({
      ok: false,
      code: "multiple-project-labels",
      message: "Issue has multiple project labels: project:habit-cli, project:other-project.",
      projectLabels: ["project:habit-cli", "project:other-project"],
    });
  });
});
