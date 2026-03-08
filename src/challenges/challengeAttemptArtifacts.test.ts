import { promises as nodeFs } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { persistChallengeAttemptArtifact } from "./challengeAttemptArtifacts.js";

async function createTempWorkDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "challenge-attempt-artifacts-"));
}

describe("challengeAttemptArtifacts", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
    tempDirs.length = 0;
    vi.restoreAllMocks();
  });

  it("writes a deterministic failure artifact with runtime error fields", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    const persisted = await persistChallengeAttemptArtifact(workDir, {
      challengeIssueNumber: 45,
      runResult: null,
      runError: new Error("execution exploded"),
      nowMs: 1_700_000_000_000,
    });

    expect(persisted.relativePath).toBe(".evolvo/challenge-attempts/45/0001.json");
    expect(persisted.artifact).toEqual({
      schemaVersion: 1,
      challengeIssueNumber: 45,
      attempt: 1,
      attemptedAtMs: 1_700_000_000_000,
      attemptedAtIso: "2023-11-14T22:13:20.000Z",
      outcome: "failure",
      executionSummary: {
        reviewOutcome: null,
        pullRequestCreated: false,
        mergedPullRequest: false,
        inspectedAreas: [],
        editedFiles: [],
        validationCommands: [],
        failedValidationCommands: [],
        finalResponseExcerpt: null,
      },
      runtimeError: {
        name: "Error",
        message: "execution exploded",
        stackPreview: expect.any(String),
      },
    });
  });

  it("writes a success artifact with execution summary fields and null runtime error", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    const persisted = await persistChallengeAttemptArtifact(workDir, {
      challengeIssueNumber: 45,
      runResult: {
        mergedPullRequest: true,
        summary: {
          inspectedAreas: ["src/main.ts"],
          editedFiles: ["src/challenges/challengeAttemptArtifacts.ts"],
          validationCommands: [{ command: "pnpm test", commandName: "pnpm", exitCode: 0, durationMs: 210 }],
          failedValidationCommands: [],
          reviewOutcome: "accepted",
          pullRequestCreated: true,
          externalRepositories: [],
          externalPullRequests: [],
          mergedExternalPullRequest: false,
          finalResponse: "Implemented and validated.",
        },
      },
      runError: null,
      nowMs: 1_700_000_000_001,
    });

    expect(persisted.relativePath).toBe(".evolvo/challenge-attempts/45/0001.json");
    expect(persisted.artifact.outcome).toBe("success");
    expect(persisted.artifact.runtimeError).toBeNull();
    expect(persisted.artifact.executionSummary).toEqual({
      reviewOutcome: "accepted",
      pullRequestCreated: true,
      mergedPullRequest: true,
      inspectedAreas: ["src/main.ts"],
      editedFiles: ["src/challenges/challengeAttemptArtifacts.ts"],
      validationCommands: [{ command: "pnpm test", commandName: "pnpm", exitCode: 0, durationMs: 210 }],
      failedValidationCommands: [],
      finalResponseExcerpt: "Implemented and validated.",
    });
  });

  it("increments attempt numbering per challenge and preserves schema on disk", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    await persistChallengeAttemptArtifact(workDir, {
      challengeIssueNumber: 91,
      runResult: null,
      runError: new Error("first"),
      nowMs: 100,
    });
    const second = await persistChallengeAttemptArtifact(workDir, {
      challengeIssueNumber: 91,
      runResult: null,
      runError: new Error("second"),
      nowMs: 101,
    });

    expect(second.relativePath).toBe(".evolvo/challenge-attempts/91/0002.json");

    const raw = await readFile(join(workDir, second.relativePath), "utf8");
    const parsed = JSON.parse(raw) as {
      schemaVersion: number;
      challengeIssueNumber: number;
      attempt: number;
      outcome: string;
      runtimeError: { name: string; message: string; stackPreview: string | null } | null;
    };

    expect(parsed).toEqual(expect.objectContaining({
      schemaVersion: 1,
      challengeIssueNumber: 91,
      attempt: 2,
      outcome: "failure",
    }));
    expect(parsed.runtimeError).toEqual(expect.objectContaining({ message: "second" }));
  });

  it("keeps concurrent attempt artifacts unique when writes overlap", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    const originalWriteFile = nodeFs.writeFile.bind(nodeFs);
    vi.spyOn(nodeFs, "writeFile").mockImplementation(async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return originalWriteFile(...args);
    });

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) => persistChallengeAttemptArtifact(workDir, {
        challengeIssueNumber: 144,
        runResult: null,
        runError: new Error(`failure-${index + 1}`),
        nowMs: 1_700_000_000_100 + index,
      })),
    );

    expect(results.map((result) => result.artifact.attempt).sort((left, right) => left - right)).toEqual([
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
    ]);
    expect(new Set(results.map((result) => result.relativePath)).size).toBe(8);

    const attemptDirectory = join(workDir, ".evolvo", "challenge-attempts", "144");
    const persistedFiles = (await readdir(attemptDirectory)).sort();
    expect(persistedFiles).toEqual([
      "0001.json",
      "0002.json",
      "0003.json",
      "0004.json",
      "0005.json",
      "0006.json",
      "0007.json",
      "0008.json",
    ]);

    const persistedMessages = await Promise.all(
      persistedFiles.map(async (fileName) => {
        const raw = await readFile(join(attemptDirectory, fileName), "utf8");
        return (JSON.parse(raw) as {
          attempt: number;
          runtimeError: { message: string } | null;
        });
      }),
    );

    expect(persistedMessages.map((artifact) => artifact.attempt).sort((left, right) => left - right)).toEqual([
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
    ]);
    expect(
      new Set(persistedMessages.map((artifact) => artifact.runtimeError?.message ?? "missing")).size,
    ).toBe(8);
  });
});
