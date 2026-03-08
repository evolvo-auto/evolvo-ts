import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activateProjectInState,
  deactivateProjectInState,
  getActiveProjectsStatePath,
  readActiveProjectsState,
} from "./activeProjectsState.js";

async function createTempWorkDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "active-projects-state-"));
}

describe("activeProjectsState", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("returns an empty active-projects state when the file is missing", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    await expect(readActiveProjectsState(workDir)).resolves.toEqual({
      version: 1,
      projects: [],
    });
  });

  it("adds multiple active projects without overwriting earlier ones", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    await activateProjectInState({
      workDir,
      slug: "beta",
      requestedBy: "discord:operator-1",
      source: "start-project-command",
      updatedAt: "2026-03-08T12:00:00.000Z",
    });
    const state = await activateProjectInState({
      workDir,
      slug: "alpha",
      requestedBy: "discord:operator-1",
      source: "start-project-command",
      updatedAt: "2026-03-08T12:05:00.000Z",
    });

    expect(state).toEqual({
      version: 1,
      projects: [
        {
          slug: "alpha",
          updatedAt: "2026-03-08T12:05:00.000Z",
          requestedBy: "discord:operator-1",
          source: "start-project-command",
        },
        {
          slug: "beta",
          updatedAt: "2026-03-08T12:00:00.000Z",
          requestedBy: "discord:operator-1",
          source: "start-project-command",
        },
      ],
    });
    await expect(readFile(getActiveProjectsStatePath(workDir), "utf8")).resolves.toBe(
      `${JSON.stringify(state, null, 2)}\n`,
    );
  });

  it("updates an existing project entry without duplicating it", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    await activateProjectInState({
      workDir,
      slug: "habit-cli",
      requestedBy: "discord:operator-1",
      source: "start-project-command",
      updatedAt: "2026-03-08T12:00:00.000Z",
    });

    await expect(
      activateProjectInState({
        workDir,
        slug: "habit-cli",
        requestedBy: "runtime:provisioner",
        source: "project-provisioning",
        updatedAt: "2026-03-08T12:10:00.000Z",
      }),
    ).resolves.toEqual({
      version: 1,
      projects: [
        {
          slug: "habit-cli",
          updatedAt: "2026-03-08T12:10:00.000Z",
          requestedBy: "runtime:provisioner",
          source: "project-provisioning",
        },
      ],
    });
  });

  it("removes a project from the active set without affecting others", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    await activateProjectInState({
      workDir,
      slug: "alpha",
      requestedBy: "discord:operator-1",
      source: "start-project-command",
      updatedAt: "2026-03-08T12:00:00.000Z",
    });
    await activateProjectInState({
      workDir,
      slug: "beta",
      requestedBy: "discord:operator-1",
      source: "start-project-command",
      updatedAt: "2026-03-08T12:01:00.000Z",
    });

    await expect(deactivateProjectInState(workDir, "alpha")).resolves.toEqual({
      version: 1,
      projects: [
        {
          slug: "beta",
          updatedAt: "2026-03-08T12:01:00.000Z",
          requestedBy: "discord:operator-1",
          source: "start-project-command",
        },
      ],
    });
  });
});
