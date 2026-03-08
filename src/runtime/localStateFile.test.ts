import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readRecoverableJsonState } from "./localStateFile.js";

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
