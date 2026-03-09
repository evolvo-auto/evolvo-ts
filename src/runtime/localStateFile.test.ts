import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readRecoverableJsonState,
  writeAtomicJsonState,
  writeAtomicJsonStateIfMissing,
} from "./localStateFile.js";

async function createTempWorkDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "local-state-file-"));
}

describe("localStateFile", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("returns the default state when the file is missing", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    const state = await readRecoverableJsonState({
      statePath: join(workDir, ".evolvo", "test-state.json"),
      createDefaultState: () => ({ value: 1 }),
      normalizeState: (raw) => ({ state: raw as { value: number }, recoveredInvalid: false }),
      warningLabel: "test state store",
    });

    expect(state).toEqual({ value: 1 });
  });

  it("creates missing state files atomically without leaving temp files behind", async () => {
    vi.useFakeTimers();
    const writeAtMs = new Date("2026-03-08T01:00:00.000Z").getTime();
    vi.setSystemTime(writeAtMs);
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    const statePath = join(workDir, ".evolvo", "test-state.json");

    await expect(writeAtomicJsonStateIfMissing(statePath, { value: 2 })).resolves.toBe(true);
    await expect(readFile(statePath, "utf8")).resolves.toBe(`${JSON.stringify({ value: 2 }, null, 2)}\n`);
    await expect(readdir(join(workDir, ".evolvo"))).resolves.toEqual(["test-state.json"]);
  });

  it("does not overwrite existing state when create-once atomic writes race", async () => {
    vi.useFakeTimers();
    const writeAtMs = new Date("2026-03-08T01:05:00.000Z").getTime();
    vi.setSystemTime(writeAtMs);
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    const evolvoDir = join(workDir, ".evolvo");
    const statePath = join(evolvoDir, "test-state.json");
    await mkdir(evolvoDir, { recursive: true });
    await writeFile(statePath, `${JSON.stringify({ value: 3 }, null, 2)}\n`, "utf8");

    await expect(writeAtomicJsonStateIfMissing(statePath, { value: 4 })).resolves.toBe(false);
    await expect(readFile(statePath, "utf8")).resolves.toBe(`${JSON.stringify({ value: 3 }, null, 2)}\n`);
    await expect(readdir(evolvoDir)).resolves.toEqual(["test-state.json"]);
  });

  it("supports concurrent atomic writes created in the same millisecond", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-08T01:10:00.000Z"));
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    const statePath = join(workDir, ".evolvo", "test-state.json");

    await expect(Promise.all([
      writeAtomicJsonState(statePath, { value: 1 }),
      writeAtomicJsonState(statePath, { value: 2 }),
    ])).resolves.toHaveLength(2);

    const persisted = JSON.parse(await readFile(statePath, "utf8")) as { value: number };
    expect([1, 2]).toContain(persisted.value);
    await expect(readdir(join(workDir, ".evolvo"))).resolves.toEqual(["test-state.json"]);
  });

  it("preserves malformed JSON, rewrites the file with defaults, and warns", async () => {
    vi.useFakeTimers();
    const recoveryAtMs = new Date("2026-03-07T22:00:00.000Z").getTime();
    vi.setSystemTime(recoveryAtMs);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    const evolvoDir = join(workDir, ".evolvo");
    const statePath = join(evolvoDir, "test-state.json");
    const corruptPath = join(evolvoDir, `test-state.corrupt-${recoveryAtMs}.json`);
    await mkdir(evolvoDir, { recursive: true });
    await writeFile(statePath, "{\"value\":", "utf8");

    const state = await readRecoverableJsonState({
      statePath,
      createDefaultState: () => ({ value: 0 }),
      normalizeState: (raw) => ({ state: raw as { value: number }, recoveredInvalid: false }),
      warningLabel: "test state store",
    });

    expect(state).toEqual({ value: 0 });
    expect(await readFile(corruptPath, "utf8")).toBe("{\"value\":");
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({ value: 0 });
    expect(warnSpy).toHaveBeenCalledWith(
      `Recovered malformed test state store at ${statePath}; preserved corrupt file at ${corruptPath}.`,
    );
  });

  it("preserves parseable but invalid JSON, rewrites the normalized state, and warns", async () => {
    vi.useFakeTimers();
    const recoveryAtMs = new Date("2026-03-08T00:20:00.000Z").getTime();
    vi.setSystemTime(recoveryAtMs);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    const evolvoDir = join(workDir, ".evolvo");
    const statePath = join(evolvoDir, "test-state.json");
    const corruptPath = join(evolvoDir, `test-state.corrupt-${recoveryAtMs}.json`);
    await mkdir(evolvoDir, { recursive: true });
    await writeFile(statePath, JSON.stringify({ value: -5 }), "utf8");

    const state = await readRecoverableJsonState({
      statePath,
      createDefaultState: () => ({ value: 0 }),
      normalizeState: (raw) => {
        if (typeof raw !== "object" || raw === null || typeof (raw as { value?: unknown }).value !== "number" || (raw as { value: number }).value < 0) {
          return {
            state: { value: 0 },
            recoveredInvalid: true,
          };
        }

        return {
          state: raw as { value: number },
          recoveredInvalid: false,
        };
      },
      warningLabel: "test state store",
    });

    expect(state).toEqual({ value: 0 });
    expect(await readFile(corruptPath, "utf8")).toBe(JSON.stringify({ value: -5 }));
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({ value: 0 });
    expect(warnSpy).toHaveBeenCalledWith(
      `Recovered invalid test state store at ${statePath}; preserved corrupt file at ${corruptPath}.`,
    );
  });
});
