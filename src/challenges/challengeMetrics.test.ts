import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatChallengeMetricsReport,
  readChallengeMetrics,
  recordChallengeAttemptMetrics,
} from "./challengeMetrics.js";

async function createTempWorkDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "challenge-metrics-"));
}

describe("challengeMetrics", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("returns default metrics when no metrics file exists", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    await expect(readChallengeMetrics(workDir)).resolves.toEqual({
      total: 0,
      success: 0,
      failure: 0,
      attemptsToSuccess: {
        total: 0,
        samples: 0,
        average: 0,
      },
      categoryCounts: {},
      pendingAttemptsByChallenge: {},
    });
  });

  it("records failed attempts with deterministic category and pending-attempt tracking", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    const metrics = await recordChallengeAttemptMetrics(workDir, {
      challengeIssueNumber: 101,
      success: false,
      failureCategory: "validation_failure",
    });

    expect(metrics).toEqual({
      total: 1,
      success: 0,
      failure: 1,
      attemptsToSuccess: {
        total: 0,
        samples: 0,
        average: 0,
      },
      categoryCounts: {
        validation_failure: 1,
      },
      pendingAttemptsByChallenge: {
        101: 1,
      },
    });
  });

  it("tracks attempts-to-success across retries and clears pending attempts on success", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    await recordChallengeAttemptMetrics(workDir, {
      challengeIssueNumber: 22,
      success: false,
      failureCategory: "workflow_failure",
    });
    const metrics = await recordChallengeAttemptMetrics(workDir, {
      challengeIssueNumber: 22,
      success: true,
    });

    expect(metrics).toEqual({
      total: 2,
      success: 1,
      failure: 1,
      attemptsToSuccess: {
        total: 2,
        samples: 1,
        average: 2,
      },
      categoryCounts: {
        workflow_failure: 1,
      },
      pendingAttemptsByChallenge: {},
    });
  });

  it("stores metrics file with deterministic key ordering", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    await recordChallengeAttemptMetrics(workDir, {
      challengeIssueNumber: 44,
      success: false,
      failureCategory: "zeta",
    });
    await recordChallengeAttemptMetrics(workDir, {
      challengeIssueNumber: 33,
      success: false,
      failureCategory: "alpha",
    });

    const raw = await readFile(join(workDir, ".evolvo", "challenge-metrics.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      categoryCounts: Record<string, number>;
      pendingAttemptsByChallenge: Record<string, number>;
    };

    expect(Object.keys(parsed.categoryCounts)).toEqual(["alpha", "zeta"]);
    expect(Object.keys(parsed.pendingAttemptsByChallenge)).toEqual(["33", "44"]);
  });

  it("formats report output from stored metrics accurately", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    await recordChallengeAttemptMetrics(workDir, {
      challengeIssueNumber: 8,
      success: false,
      failureCategory: "execution_error",
    });
    const metrics = await recordChallengeAttemptMetrics(workDir, {
      challengeIssueNumber: 8,
      success: true,
    });

    expect(formatChallengeMetricsReport(metrics)).toBe([
      "## Challenge Metrics",
      "- total attempts: 2",
      "- successful attempts: 1",
      "- failed attempts: 1",
      "- success rate: 50.00%",
      "- attempts-to-success avg: 2.00 (samples=1)",
      "- failure categories: execution_error:1",
      "- active pending challenge attempts: 0",
    ].join("\n"));
  });

  it("normalizes empty failure categories to unknown", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    const metrics = await recordChallengeAttemptMetrics(workDir, {
      challengeIssueNumber: 77,
      success: false,
      failureCategory: " ",
    });

    expect(metrics.categoryCounts).toEqual({ unknown: 1 });
  });

  it("recovers malformed metrics JSON by preserving the corrupt file and resetting defaults", async () => {
    vi.useFakeTimers();
    const recoveryAtMs = new Date("2026-03-07T22:20:00.000Z").getTime();
    vi.setSystemTime(recoveryAtMs);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    const evolvoDir = join(workDir, ".evolvo");
    const statePath = join(evolvoDir, "challenge-metrics.json");
    const corruptPath = join(evolvoDir, `challenge-metrics.corrupt-${recoveryAtMs}.json`);
    await mkdir(evolvoDir, { recursive: true });
    await writeFile(statePath, "{\"total\":", "utf8");

    const metrics = await readChallengeMetrics(workDir);

    expect(metrics).toEqual({
      total: 0,
      success: 0,
      failure: 0,
      attemptsToSuccess: {
        total: 0,
        samples: 0,
        average: 0,
      },
      categoryCounts: {},
      pendingAttemptsByChallenge: {},
    });
    expect(await readFile(corruptPath, "utf8")).toBe("{\"total\":");
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({
      total: 0,
      success: 0,
      failure: 0,
      attemptsToSuccess: {
        total: 0,
        samples: 0,
        average: 0,
      },
      categoryCounts: {},
      pendingAttemptsByChallenge: {},
    });
    expect(warnSpy).toHaveBeenCalledWith(
      `Recovered malformed challenge metrics store at ${statePath}; preserved corrupt file at ${corruptPath}.`,
    );
  });
});
