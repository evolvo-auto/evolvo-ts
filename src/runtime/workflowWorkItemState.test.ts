import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getWorkflowWorkItemRecord,
  listWorkflowWorkItemRecords,
  upsertWorkflowWorkItemRecord,
} from "./workflowWorkItemState.js";

const tempDirectories: string[] = [];

async function createWorkDir(): Promise<string> {
  const workDir = await mkdtemp(join(tmpdir(), "evolvo-workflow-work-items-"));
  tempDirectories.push(workDir);
  return workDir;
}

describe("workflowWorkItemState", () => {
  afterEach(async () => {
    await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("stores and retrieves workflow work-item metadata", async () => {
    const workDir = await createWorkDir();

    await upsertWorkflowWorkItemRecord(workDir, {
      queueKey: "evolvo-web#14",
      projectSlug: "evolvo-web",
      issueNumber: 14,
      branchName: "feat/stages",
      pullRequestUrl: "https://github.com/Evolvo-org/evolvo-web/pull/22",
      validationCommands: [
        {
          command: "pnpm build",
          commandName: "pnpm",
          exitCode: 0,
          durationMs: 1200,
        },
      ],
      failedValidationCommands: [],
      implementationSummary: "Implemented the scheduler.",
      reviewOutcome: null,
      reviewSummary: null,
      updatedAt: "2026-03-08T18:00:00.000Z",
    });

    const record = await getWorkflowWorkItemRecord(workDir, "evolvo-web#14");
    expect(record).toEqual(
      expect.objectContaining({
        queueKey: "evolvo-web#14",
        pullRequestUrl: "https://github.com/Evolvo-org/evolvo-web/pull/22",
      }),
    );
    expect(await listWorkflowWorkItemRecords(workDir)).toHaveLength(1);
  });
});
