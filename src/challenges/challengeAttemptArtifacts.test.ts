import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { persistChallengeAttemptArtifact } from "./challengeAttemptArtifacts.js";

async function createTempWorkDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "challenge-attempt-artifacts-"));
}

describe("challengeAttemptArtifacts", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
    tempDirs.length = 0;
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
          validationCommands: [{ command: "pnpm test", exitCode: 0, durationMs: 210 }],
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
      validationCommands: [{ command: "pnpm test", exitCode: 0, durationMs: 210 }],
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
});
