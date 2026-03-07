import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildLifecycleStateComment,
  readCanonicalLifecycleState,
  transitionCanonicalLifecycleState,
} from "./lifecycleState.js";

async function createTempWorkDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "lifecycle-state-"));
}

describe("lifecycleState", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("starts with empty default state when no file exists", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    const state = await readCanonicalLifecycleState(workDir);

    expect(state).toEqual({
      version: 1,
      issues: {},
    });
  });

  it("persists valid lifecycle transitions and history", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    const selected = await transitionCanonicalLifecycleState(workDir, {
      issueNumber: 44,
      kind: "issue",
      nextState: "selected",
      reason: "chosen in cycle",
      runCycle: 1,
      atMs: 1000,
    });
    const executing = await transitionCanonicalLifecycleState(workDir, {
      issueNumber: 44,
      kind: "issue",
      nextState: "executing",
      reason: "agent started",
      runCycle: 1,
      atMs: 1100,
    });

    expect(selected.ok).toBe(true);
    expect(selected.previousState).toBeNull();
    expect(executing.ok).toBe(true);
    expect(executing.previousState).toBe("selected");
    expect(executing.entry).toEqual(
      expect.objectContaining({
        issueNumber: 44,
        kind: "issue",
        state: "executing",
        transitionCount: 2,
      }),
    );
    expect(executing.entry?.history).toEqual([
      {
        from: null,
        to: "selected",
        at: new Date(1000).toISOString(),
        reason: "chosen in cycle",
        runCycle: 1,
      },
      {
        from: "selected",
        to: "executing",
        at: new Date(1100).toISOString(),
        reason: "agent started",
        runCycle: 1,
      },
    ]);

    const raw = JSON.parse(await readFile(join(workDir, ".evolvo", "runtime-lifecycle-state.json"), "utf8")) as {
      issues: Record<string, { state: string }>;
    };
    expect(raw.issues["44"]?.state).toBe("executing");
  });

  it("rejects invalid transitions without mutating persisted state", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    await transitionCanonicalLifecycleState(workDir, {
      issueNumber: 9,
      kind: "challenge",
      nextState: "selected",
      atMs: 1000,
    });

    const invalid = await transitionCanonicalLifecycleState(workDir, {
      issueNumber: 9,
      kind: "challenge",
      nextState: "merged",
      atMs: 2000,
    });

    expect(invalid).toEqual(
      expect.objectContaining({
        ok: false,
        previousState: "selected",
        message: "Invalid lifecycle transition: selected -> merged.",
      }),
    );

    const state = await readCanonicalLifecycleState(workDir);
    expect(state.issues["9"]?.state).toBe("selected");
    expect(state.issues["9"]?.transitionCount).toBe(1);
  });

  it("supports amended and completed transitions for review and terminal success paths", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    await transitionCanonicalLifecycleState(workDir, {
      issueNumber: 77,
      kind: "challenge",
      nextState: "selected",
      atMs: 1000,
    });
    await transitionCanonicalLifecycleState(workDir, {
      issueNumber: 77,
      kind: "challenge",
      nextState: "executing",
      atMs: 1100,
    });
    await transitionCanonicalLifecycleState(workDir, {
      issueNumber: 77,
      kind: "challenge",
      nextState: "under_review",
      atMs: 1200,
    });

    const amended = await transitionCanonicalLifecycleState(workDir, {
      issueNumber: 77,
      kind: "challenge",
      nextState: "amended",
      atMs: 1300,
    });
    const backToExecuting = await transitionCanonicalLifecycleState(workDir, {
      issueNumber: 77,
      kind: "challenge",
      nextState: "executing",
      atMs: 1400,
    });
    await transitionCanonicalLifecycleState(workDir, {
      issueNumber: 77,
      kind: "challenge",
      nextState: "under_review",
      atMs: 1500,
    });
    await transitionCanonicalLifecycleState(workDir, {
      issueNumber: 77,
      kind: "challenge",
      nextState: "accepted",
      atMs: 1600,
    });
    const completed = await transitionCanonicalLifecycleState(workDir, {
      issueNumber: 77,
      kind: "challenge",
      nextState: "completed",
      atMs: 1700,
    });

    expect(amended.ok).toBe(true);
    expect(backToExecuting.ok).toBe(true);
    expect(completed.ok).toBe(true);
    expect(completed.previousState).toBe("accepted");

    const state = await readCanonicalLifecycleState(workDir);
    expect(state.issues["77"]?.state).toBe("completed");
  });

  it("normalizes malformed persisted state", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    await mkdir(join(workDir, ".evolvo"), { recursive: true });
    await writeFile(
      join(workDir, ".evolvo", "runtime-lifecycle-state.json"),
      JSON.stringify({
        version: 0,
        issues: {
          abc: { state: "unknown" },
          12: {
            issueNumber: 12,
            kind: "challenge",
            state: "blocked",
            updatedAt: "2020-01-01T00:00:00.000Z",
            transitionCount: 2,
            history: [{ from: null, to: "blocked", at: "2020-01-01T00:00:00.000Z", reason: "x", runCycle: 1 }],
          },
        },
      }),
      "utf8",
    );

    const state = await readCanonicalLifecycleState(workDir);
    expect(Object.keys(state.issues)).toEqual(["12"]);
    expect(state.issues["12"]?.state).toBe("blocked");
    expect(state.version).toBe(1);
  });

  it("formats canonical lifecycle comments with canonical and derived sections", () => {
    const comment = buildLifecycleStateComment({
      issueNumber: 90,
      currentState: "executing",
      previousState: "selected",
      kind: "challenge",
      reason: "runtime started agent run",
      derived: {
        issueState: "open",
        labels: ["challenge", "in progress"],
        isChallenge: true,
        reviewOutcome: null,
        pullRequestCreated: null,
        mergedPullRequest: null,
      },
    });

    expect(comment).toContain("## Canonical Lifecycle State");
    expect(comment).toContain("Canonical state: `executing`");
    expect(comment).toContain("### Derived Runtime Signals");
    expect(comment).toContain("Presentation Note");
    expect(comment).toContain(".evolvo/runtime-lifecycle-state.json");
  });
});
