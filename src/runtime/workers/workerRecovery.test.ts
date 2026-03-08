import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activateProjectInState } from "../../projects/activeProjectsState.js";
import { buildDefaultProjectRecord, writeProjectRegistry } from "../../projects/projectRegistry.js";
import { acquireCodingLease, readProjectActivityState, setProjectCurrentWorkItem } from "../../projects/projectActivityState.js";
import { registerWorkflowWorker } from "./workerHeartbeat.js";
import { reconcileStaleDevProjectLeases, recoverExpiredWorkflowWorkerClaims } from "./workerRecovery.js";

async function createTempWorkDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "worker-recovery-"));
}

describe("workerRecovery", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("moves expired in-flight claims back to their ready stage and clears dev lease state", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    const project = buildDefaultProjectRecord({
      owner: "Evolvo-org",
      repo: "evolvo-ts",
      workDir,
      defaultBranch: "main",
    });
    project.slug = "evolvo-web";
    project.executionRepo.repo = "evolvo-web";
    project.executionRepo.url = "https://github.com/Evolvo-org/evolvo-web";
    project.trackerRepo.repo = "evolvo-ts";
    project.trackerRepo.url = "https://github.com/Evolvo-org/evolvo-ts";
    project.kind = "managed";
    project.displayName = "Evolvo Web";
    project.issueLabel = "project:evolvo-web";
    await writeProjectRegistry(workDir, {
      version: 1,
      projects: [
        buildDefaultProjectRecord({
          owner: "Evolvo-org",
          repo: "evolvo-ts",
          workDir,
          defaultBranch: "main",
        }),
        project,
      ],
    });
    await activateProjectInState({
      workDir,
      slug: "evolvo-web",
      requestedBy: "operator",
      source: "start-project-command",
      updatedAt: "2026-03-08T10:00:00.000Z",
    });
    await acquireCodingLease({
      workDir,
      slug: "evolvo-web",
      issueNumber: 41,
      holder: "dev-agent",
      at: "2026-03-08T10:00:00.000Z",
    });
    await setProjectCurrentWorkItem({
      workDir,
      slug: "evolvo-web",
      workItem: {
        issueNumber: 41,
        issueUrl: "https://github.com/Evolvo-org/evolvo-web/issues/41",
        stage: "In Dev",
        branchName: null,
        pullRequestUrl: null,
      },
      at: "2026-03-08T10:00:00.000Z",
    });
    await registerWorkflowWorker({
      workDir,
      role: "dev",
      projectSlug: "evolvo-web",
      pid: 1234,
      startedAt: "2026-03-08T10:00:00.000Z",
      heartbeatAt: "2026-03-08T10:00:00.000Z",
      currentClaim: {
        issueNumber: 41,
        pullRequestNumber: null,
        queueKey: "evolvo-web#41",
        stage: "In Dev",
        claimedAt: "2026-03-08T10:00:00.000Z",
      },
      restartCount: 0,
    });

    const boardItems = [{
      itemId: "item-41",
      issueNodeId: "issue-node-41",
      issueNumber: 41,
      title: "Issue 41",
      body: "Description 41",
      state: "OPEN" as const,
      url: "https://github.com/Evolvo-org/evolvo-web/issues/41",
      labels: [],
      repository: {
        owner: "Evolvo-org",
        repo: "evolvo-web",
        url: "https://github.com/Evolvo-org/evolvo-web",
        reference: "Evolvo-org/evolvo-web",
      },
      stage: "In Dev" as const,
      stageOptionId: "option-dev",
    }];
    const boardsClient = {
      listProjectIssueItems: vi.fn(async () => boardItems),
      moveProjectItemToStage: vi.fn().mockResolvedValue(undefined),
    };

    await expect(recoverExpiredWorkflowWorkerClaims({
      workDir,
      currentWorkers: [{
        workerId: "dev:evolvo-web",
        pid: 1234,
        role: "dev",
        projectSlug: "evolvo-web",
        startedAt: "2026-03-08T10:00:00.000Z",
        heartbeatAt: "2026-03-08T10:00:00.000Z",
        currentClaim: {
          issueNumber: 41,
          pullRequestNumber: null,
          queueKey: "evolvo-web#41",
          stage: "In Dev",
          claimedAt: "2026-03-08T10:00:00.000Z",
        },
        restartCount: 0,
      }],
      defaultProject: {
        owner: "Evolvo-org",
        repo: "evolvo-ts",
        workDir,
        defaultBranch: "main",
      },
      boardsClient,
      now: "2026-03-08T10:02:00.000Z",
      heartbeatTimeoutMs: 30_000,
    })).resolves.toBe(1);

    expect(boardsClient.moveProjectItemToStage).toHaveBeenCalledWith(project, "item-41", "Ready for Dev");
    const activityState = await readProjectActivityState(workDir);
    expect(activityState.projects[0]).toEqual(expect.objectContaining({
      currentCodingLease: null,
      currentWorkItem: null,
    }));
  });

  it("clears stale dev leases when no matching board item remains In Dev", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    await acquireCodingLease({
      workDir,
      slug: "evolvo-web",
      issueNumber: 77,
      holder: "dev-agent",
      at: "2026-03-08T10:00:00.000Z",
    });
    await setProjectCurrentWorkItem({
      workDir,
      slug: "evolvo-web",
      workItem: {
        issueNumber: 77,
        issueUrl: "https://github.com/Evolvo-org/evolvo-web/issues/77",
        stage: "In Dev",
        branchName: null,
        pullRequestUrl: null,
      },
      at: "2026-03-08T10:00:00.000Z",
    });

    await expect(reconcileStaleDevProjectLeases({
      workDir,
      inventory: {
        projects: [{
          project: {
            slug: "evolvo-web",
            displayName: "Evolvo Web",
            kind: "managed",
            issueLabel: "project:evolvo-web",
            trackerRepo: { owner: "Evolvo-org", repo: "evolvo-ts", url: "https://github.com/Evolvo-org/evolvo-ts" },
            executionRepo: { owner: "Evolvo-org", repo: "evolvo-web", url: "https://github.com/Evolvo-org/evolvo-web", defaultBranch: "main" },
            cwd: workDir,
            status: "active",
            sourceIssueNumber: null,
            createdAt: "2026-03-08T00:00:00.000Z",
            updatedAt: "2026-03-08T00:00:00.000Z",
            provisioning: { labelCreated: true, repoCreated: true, workspacePrepared: true, lastError: null },
            workflow: {
              boardOwner: "Evolvo-org",
              boardNumber: null,
              boardId: null,
              boardUrl: null,
              stageFieldId: null,
              stageOptionIds: {},
              boardProvisioned: true,
              lastError: null,
              lastSyncedAt: null,
            },
          },
          activity: {
            slug: "evolvo-web",
            activityState: "active",
            deferredStopMode: null,
            requestedBy: "operator",
            updatedAt: "2026-03-08T10:00:00.000Z",
            currentCodingLease: {
              leaseId: "evolvo-web:77:2026-03-08T10:00:00.000Z",
              holder: "dev-agent",
              acquiredAt: "2026-03-08T10:00:00.000Z",
              heartbeatAt: "2026-03-08T10:00:00.000Z",
              issueNumber: 77,
              branchName: null,
              pullRequestUrl: null,
            },
            currentWorkItem: {
              issueNumber: 77,
              issueUrl: "https://github.com/Evolvo-org/evolvo-web/issues/77",
              stage: "In Dev",
              branchName: null,
              pullRequestUrl: null,
            },
            lastStageTransition: null,
            schedulingEligibility: { eligible: false, reason: "coding lease already active", lastScheduledAt: null },
            lastFailure: null,
          },
          items: [],
          countsByStage: {
            Inbox: 0,
            Planning: 0,
            "Ready for Dev": 0,
            "In Dev": 0,
            "Ready for Review": 0,
            "In Review": 0,
            "Ready for Release": 0,
            Releasing: 0,
            Blocked: 0,
            Done: 0,
          },
        }],
        activityState: { version: 1, projects: [] },
      },
    })).resolves.toBe(1);

    const activityState = await readProjectActivityState(workDir);
    expect(activityState.projects[0]).toEqual(expect.objectContaining({
      currentCodingLease: null,
      currentWorkItem: null,
    }));
  });
});