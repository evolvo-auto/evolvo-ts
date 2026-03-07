import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureProjectRegistry,
  findProjectBySlug,
  getProjectRegistryPath,
  readProjectRegistry,
  upsertProjectRecord,
  writeProjectRegistry,
  type ProjectRecord,
} from "./projectRegistry.js";

async function createTempWorkDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "project-registry-"));
}

describe("projectRegistry", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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

  it("writes the registry atomically through a temp file rename", async () => {
    vi.useFakeTimers();
    const writeAtMs = new Date("2026-03-07T23:00:00.000Z").getTime();
    vi.setSystemTime(writeAtMs);
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    const registry = await readProjectRegistry(workDir, {
      owner: "evolvo-auto",
      repo: "evolvo-ts",
      workDir,
      defaultBranch: "main",
    });

    await writeProjectRegistry(workDir, registry);

    await expect(
      access(join(workDir, ".evolvo", `projects.tmp-${writeAtMs}-${process.pid}.json`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(workDir, ".evolvo"))).toEqual(["projects.json"]);
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

  it("preserves malformed registry JSON, rewrites a safe default registry, and warns", async () => {
    vi.useFakeTimers();
    const recoveryAtMs = new Date("2026-03-07T23:10:00.000Z").getTime();
    vi.setSystemTime(recoveryAtMs);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    const evolvoDir = join(workDir, ".evolvo");
    const registryPath = getProjectRegistryPath(workDir);
    const corruptPath = join(evolvoDir, `projects.corrupt-${recoveryAtMs}.json`);
    await mkdir(evolvoDir, { recursive: true });
    await writeFile(registryPath, "{\"projects\":", "utf8");

    const registry = await readProjectRegistry(workDir, {
      owner: "evolvo-auto",
      repo: "evolvo-ts",
      workDir,
      defaultBranch: "main",
    });

    expect(registry.projects.map((project) => project.slug)).toEqual(["evolvo"]);
    expect(await readFile(corruptPath, "utf8")).toBe("{\"projects\":");
    expect(JSON.parse(await readFile(registryPath, "utf8"))).toEqual({
      version: 1,
      projects: [
        expect.objectContaining({
          slug: "evolvo",
          executionRepo: expect.objectContaining({
            defaultBranch: "main",
          }),
        }),
      ],
    });
    expect(warnSpy).toHaveBeenCalledWith(
      `Recovered malformed project registry at ${registryPath}; preserved corrupt file at ${corruptPath}.`,
    );
  });

  it("preserves valid existing projects when recovering malformed registry records", async () => {
    vi.useFakeTimers();
    const recoveryAtMs = new Date("2026-03-07T23:20:00.000Z").getTime();
    vi.setSystemTime(recoveryAtMs);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    const evolvoDir = join(workDir, ".evolvo");
    const registryPath = getProjectRegistryPath(workDir);
    const corruptPath = join(evolvoDir, `projects.corrupt-${recoveryAtMs}.json`);
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
    await mkdir(evolvoDir, { recursive: true });
    await writeFile(
      registryPath,
      `${JSON.stringify({
        version: 1,
        projects: [
          managedProject,
          {
            slug: "",
            displayName: "Broken Project",
          },
        ],
      }, null, 2)}\n`,
      "utf8",
    );

    const registry = await readProjectRegistry(workDir, {
      owner: "evolvo-auto",
      repo: "evolvo-ts",
      workDir,
      defaultBranch: "main",
    });

    expect(registry.projects.map((project) => project.slug)).toEqual(["evolvo", "habit-cli"]);
    expect(findProjectBySlug(registry, "habit-cli")).toEqual(managedProject);
    expect(await readFile(corruptPath, "utf8")).toContain("\"Broken Project\"");
    expect(JSON.parse(await readFile(registryPath, "utf8"))).toEqual({
      version: 1,
      projects: [
        expect.objectContaining({ slug: "evolvo" }),
        expect.objectContaining({ slug: "habit-cli" }),
      ],
    });
    expect(warnSpy).toHaveBeenCalledWith(
      `Recovered malformed project registry at ${registryPath}; preserved corrupt file at ${corruptPath}.`,
    );
  });
});
