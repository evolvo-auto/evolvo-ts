import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureProjectRegistry,
  findProjectBySlug,
  getProjectRegistryPath,
  readProjectRegistry,
  upsertProjectRecord,
  type ProjectRecord,
} from "./projectRegistry.js";

async function createTempWorkDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "project-registry-"));
}

describe("projectRegistry", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("returns a default Evolvo project when no registry file exists", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    const registry = await readProjectRegistry(workDir, {
      owner: "evolvo-auto",
      repo: "evolvo-ts",
      workDir,
      defaultBranch: "main",
    });

    expect(registry.projects).toHaveLength(1);
    expect(registry.projects[0]).toEqual(
      expect.objectContaining({
        slug: "evolvo",
        issueLabel: "project:evolvo",
        status: "active",
        cwd: workDir,
      }),
    );
  });

  it("persists the canonical registry file with the default Evolvo project", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    const registry = await ensureProjectRegistry(workDir, {
      owner: "evolvo-auto",
      repo: "evolvo-ts",
      workDir,
      defaultBranch: "main",
    });

    expect(registry.projects).toHaveLength(1);
    const persisted = JSON.parse(await readFile(getProjectRegistryPath(workDir), "utf8")) as {
      projects: Array<{ slug: string; executionRepo: { defaultBranch: string | null } }>;
    };
    expect(persisted.projects).toEqual([
      expect.objectContaining({
        slug: "evolvo",
        executionRepo: expect.objectContaining({
          defaultBranch: "main",
        }),
      }),
    ]);
  });

  it("upserts a managed project record while preserving the default project", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    const managedProject: ProjectRecord = {
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
    };

    const registry = await upsertProjectRecord(
      workDir,
      {
        owner: "evolvo-auto",
        repo: "evolvo-ts",
        workDir,
        defaultBranch: "main",
      },
      managedProject,
    );

    expect(registry.projects.map((project) => project.slug)).toEqual(["evolvo", "habit-cli"]);
    expect(findProjectBySlug(registry, "habit-cli")).toEqual(managedProject);

    const persisted = JSON.parse(await readFile(getProjectRegistryPath(workDir), "utf8")) as {
      projects: Array<{ slug: string }>;
    };
    expect(persisted.projects.map((project) => project.slug)).toEqual(["evolvo", "habit-cli"]);
  });
});
