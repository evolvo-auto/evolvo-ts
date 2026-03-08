import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readWorkflowAgentState, updateWorkflowAgentState } from "./workflowAgentState.js";

const tempDirectories: string[] = [];

async function createWorkDir(): Promise<string> {
  const workDir = await mkdtemp(join(tmpdir(), "evolvo-workflow-agent-state-"));
  tempDirectories.push(workDir);
  return workDir;
}

describe("workflowAgentState", () => {
  afterEach(async () => {
    await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("persists review and release cursors", async () => {
    const workDir = await createWorkDir();

    const initialState = await readWorkflowAgentState(workDir);
    expect(initialState.reviewCursorProjectSlug).toBeNull();

    await updateWorkflowAgentState(workDir, {
      reviewCursorProjectSlug: "evolvo-web",
      releaseCursorProjectSlug: "evolvo",
    });

    const nextState = await readWorkflowAgentState(workDir);
    expect(nextState).toEqual({
      version: 1,
      reviewCursorProjectSlug: "evolvo-web",
      releaseCursorProjectSlug: "evolvo",
    });
  });
});
