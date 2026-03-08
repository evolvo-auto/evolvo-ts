import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getActiveProjectStatePath,
  readActiveProjectState,
  stopActiveProjectState,
  setActiveProjectState,
} from "./activeProjectState.js";

async function createTempWorkDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "active-project-state-"));
}

describe("activeProjectState", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("returns an empty active-project state when the file is missing", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    await expect(readActiveProjectState(workDir)).resolves.toEqual({
      version: 2,
      activeProjectSlug: null,
      selectionState: null,
      updatedAt: null,
      requestedBy: null,
      source: null,
    });
  });

  it("writes the active project state atomically", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    const state = await setActiveProjectState({
      workDir,
      slug: "habit-cli",
      requestedBy: "discord:operator-1",
      source: "start-project-command",
      updatedAt: "2026-03-08T12:00:00.000Z",
    });

    expect(state).toEqual({
      version: 2,
      activeProjectSlug: "habit-cli",
      selectionState: "active",
      updatedAt: "2026-03-08T12:00:00.000Z",
      requestedBy: "discord:operator-1",
      source: "start-project-command",
    });
    await expect(readFile(getActiveProjectStatePath(workDir), "utf8")).resolves.toBe(
      `${JSON.stringify(state, null, 2)}\n`,
    );
    await expect(readActiveProjectState(workDir)).resolves.toEqual(state);
  });

  it("migrates version-1 active project state into the current shape without warning", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    const statePath = getActiveProjectStatePath(workDir);
    await mkdir(join(workDir, ".evolvo"), { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        activeProjectSlug: "habit-cli",
        updatedAt: "2026-03-08T12:00:00.000Z",
        requestedBy: "discord:operator-1",
        source: "start-project-command",
      }),
      "utf8",
    );

    await expect(readActiveProjectState(workDir)).resolves.toEqual({
      version: 2,
      activeProjectSlug: "habit-cli",
      selectionState: "active",
      updatedAt: "2026-03-08T12:00:00.000Z",
      requestedBy: "discord:operator-1",
      source: "start-project-command",
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("stops the active project without clearing its identity", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    await setActiveProjectState({
      workDir,
      slug: "habit-cli",
      requestedBy: "discord:operator-1",
      source: "start-project-command",
      updatedAt: "2026-03-08T12:00:00.000Z",
    });

    await expect(
      stopActiveProjectState({
        workDir,
        requestedBy: "discord:operator-1",
        updatedAt: "2026-03-08T12:10:00.000Z",
      }),
    ).resolves.toEqual({
      status: "stopped",
      state: {
        version: 2,
        activeProjectSlug: "habit-cli",
        selectionState: "stopped",
        updatedAt: "2026-03-08T12:10:00.000Z",
        requestedBy: "discord:operator-1",
        source: "stop-project-command",
      },
    });
  });

  it("reports when there is no active project to stop", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    await expect(
      stopActiveProjectState({
        workDir,
        requestedBy: "discord:operator-1",
        updatedAt: "2026-03-08T12:15:00.000Z",
      }),
    ).resolves.toEqual({
      status: "no-active-project",
      state: {
        version: 2,
        activeProjectSlug: null,
        selectionState: null,
        updatedAt: null,
        requestedBy: null,
        source: null,
      },
    });
  });

  it("treats repeated stop requests as already stopped", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    await setActiveProjectState({
      workDir,
      slug: "habit-cli",
      requestedBy: "discord:operator-1",
      source: "start-project-command",
      updatedAt: "2026-03-08T12:20:00.000Z",
    });
    await stopActiveProjectState({
      workDir,
      requestedBy: "discord:operator-1",
      updatedAt: "2026-03-08T12:25:00.000Z",
    });

    await expect(
      stopActiveProjectState({
        workDir,
        requestedBy: "discord:operator-1",
        updatedAt: "2026-03-08T12:30:00.000Z",
      }),
    ).resolves.toEqual({
      status: "already-stopped",
      state: {
        version: 2,
        activeProjectSlug: "habit-cli",
        selectionState: "stopped",
        updatedAt: "2026-03-08T12:25:00.000Z",
        requestedBy: "discord:operator-1",
        source: "stop-project-command",
      },
    });
  });

  it("recovers malformed state files with a safe empty state", async () => {
    vi.useFakeTimers();
    const recoveryAtMs = new Date("2026-03-08T13:00:00.000Z").getTime();
    vi.setSystemTime(recoveryAtMs);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    const statePath = getActiveProjectStatePath(workDir);
    const corruptPath = join(workDir, ".evolvo", `active-project.corrupt-${recoveryAtMs}.json`);
    await mkdir(join(workDir, ".evolvo"), { recursive: true });
    await writeFile(statePath, "{\"activeProjectSlug\":", "utf8");

    await expect(readActiveProjectState(workDir)).resolves.toEqual({
      version: 2,
      activeProjectSlug: null,
      selectionState: null,
      updatedAt: null,
      requestedBy: null,
      source: null,
    });
    await expect(readFile(corruptPath, "utf8")).resolves.toBe("{\"activeProjectSlug\":");
    expect(warnSpy).toHaveBeenCalledWith(
      `Recovered malformed active project state at ${statePath}; preserved corrupt file at ${corruptPath}.`,
    );
  });

  it("recovers invalid state files with a safe empty state", async () => {
    vi.useFakeTimers();
    const recoveryAtMs = new Date("2026-03-08T13:05:00.000Z").getTime();
    vi.setSystemTime(recoveryAtMs);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    const statePath = getActiveProjectStatePath(workDir);
    const corruptPath = join(workDir, ".evolvo", `active-project.corrupt-${recoveryAtMs}.json`);
    await mkdir(join(workDir, ".evolvo"), { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify({
        version: 99,
        activeProjectSlug: 7,
        selectionState: "paused",
        updatedAt: false,
        requestedBy: "discord:operator-1",
        source: "unknown",
      }),
      "utf8",
    );

    await expect(readActiveProjectState(workDir)).resolves.toEqual({
      version: 2,
      activeProjectSlug: null,
      selectionState: null,
      updatedAt: null,
      requestedBy: null,
      source: null,
    });
    await expect(readFile(corruptPath, "utf8")).resolves.toContain("\"version\":99");
    expect(warnSpy).toHaveBeenCalledWith(
      `Recovered invalid active project state at ${statePath}; preserved corrupt file at ${corruptPath}.`,
    );
  });
});
