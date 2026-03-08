import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CodingAgentRunResult } from "../agents/runCodingAgent.js";
import type { IssueSummary, TaskIssueManager } from "../issues/taskIssueManager.js";
import { createDefaultProjectWorkflow } from "../projects/projectWorkflow.js";
import {
  addIssueLifecycleComment,
  buildMergeOutcomeComment,
  buildIssueExecutionComment,
  buildIssueFailureComment,
  buildIssueStartComment,
  persistChallengeAttemptEvidence,
} from "./issueLifecyclePresentation.js";

const { persistChallengeAttemptArtifactMock } = vi.hoisted(() => ({
  persistChallengeAttemptArtifactMock: vi.fn(),
}));

vi.mock("../challenges/challengeAttemptArtifacts.js", () => ({
  persistChallengeAttemptArtifact: persistChallengeAttemptArtifactMock,
}));

function createIssue(overrides: Partial<IssueSummary> = {}): IssueSummary {
  return {
    number: 12,
    title: "Lifecycle issue",
    description: "Issue description",
    state: "open",
    labels: [],
    ...overrides,
  };
}

function createRunResult(overrides: Partial<CodingAgentRunResult> = {}): CodingAgentRunResult {
  return {
    mergedPullRequest: false,
    summary: {
      inspectedAreas: ["src/runtime/issueLifecyclePresentation.ts"],
      editedFiles: ["src/runtime/issueLifecyclePresentation.test.ts"],
      validationCommands: [
        {
          command: "env CI=1 pnpm test",
          commandName: "",
          exitCode: 0,
          durationMs: 155,
        },
      ],
      failedValidationCommands: [],
      reviewOutcome: "accepted",
      pullRequestCreated: true,
      externalRepositories: ["https://github.com/example/repo"],
      externalPullRequests: ["https://github.com/example/repo/pull/1"],
      mergedExternalPullRequest: true,
      finalResponse: "done",
    },
    ...overrides,
  };
}

describe("issueLifecyclePresentation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    persistChallengeAttemptArtifactMock.mockReset();
  });

  it("builds task start comment with issue context", () => {
    const issue = createIssue({ number: 88, title: "Add tests" });

    const comment = buildIssueStartComment(issue, {
      project: {
        slug: "habit-cli",
        displayName: "Habit CLI",
        kind: "managed",
        issueLabel: "project:habit-cli",
        trackerRepo: {
          owner: "evolvo-auto",
          repo: "evolvo-ts",
          url: "https://github.com/evolvo-auto/evolvo-ts",
        },
        executionRepo: {
          owner: "evolvo-auto",
          repo: "habit-cli",
          url: "https://github.com/evolvo-auto/habit-cli",
          defaultBranch: "main",
        },
        cwd: "/home/paddy/habit-cli",
        status: "active",
        sourceIssueNumber: 318,
        createdAt: "2026-03-07T12:00:00.000Z",
        updatedAt: "2026-03-07T12:00:00.000Z",
        provisioning: {
          labelCreated: true,
          repoCreated: true,
          workspacePrepared: true,
          lastError: null,
        },
        workflow: createDefaultProjectWorkflow("evolvo-auto"),
      },
      trackerRepository: "evolvo-auto/evolvo-ts",
      executionRepository: "evolvo-auto/habit-cli",
    });

    expect(comment).toContain("## Task Start");
    expect(comment).toContain("issue #88: Add tests");
    expect(comment).toContain("Planned lifecycle logging");
    expect(comment).toContain("Project: Habit CLI (`habit-cli`).");
    expect(comment).toContain("Execution repository: `evolvo-auto/habit-cli`.");
  });

  it("builds execution comment with validation and external evidence details", () => {
    const issue = createIssue();
    const runResult = createRunResult();

    const comment = buildIssueExecutionComment(issue, runResult, null, null, {
      project: {
        slug: "evolvo",
        displayName: "Evolvo",
        kind: "default",
        issueLabel: "project:evolvo",
        trackerRepo: {
          owner: "evolvo-auto",
          repo: "evolvo-ts",
          url: "https://github.com/evolvo-auto/evolvo-ts",
        },
        executionRepo: {
          owner: "evolvo-auto",
          repo: "evolvo-ts",
          url: "https://github.com/evolvo-auto/evolvo-ts",
          defaultBranch: "main",
        },
        cwd: "/tmp/evolvo",
        status: "active",
        sourceIssueNumber: null,
        createdAt: "2026-03-07T12:00:00.000Z",
        updatedAt: "2026-03-07T12:00:00.000Z",
        provisioning: {
          labelCreated: false,
          repoCreated: true,
          workspacePrepared: true,
          lastError: null,
        },
        workflow: createDefaultProjectWorkflow("evolvo-auto"),
      },
      trackerRepository: "evolvo-auto/evolvo-ts",
      executionRepository: "evolvo-auto/evolvo-ts",
    });

    expect(comment).toContain("## Task Execution Log");
    expect(comment).toContain("Project: Evolvo (`evolvo`).");
    expect(comment).toContain("name=pnpm");
    expect(comment).toContain("status=0");
    expect(comment).toContain("elapsed=155ms");
    expect(comment).toContain("outcome=passed");
    expect(comment).toContain("External pull request merged: yes.");
    expect(comment).toContain("Issue #12 execution cycle finished with outcome: accepted.");
  });

  it("builds execution comment with unknown validation metadata for null status fields", () => {
    const issue = createIssue();
    const runResult = createRunResult({
      summary: {
        ...createRunResult().summary,
        validationCommands: [{ command: "pnpm test", commandName: "", exitCode: null, durationMs: null }],
        failedValidationCommands: [{ command: "pnpm test", commandName: "", exitCode: null, durationMs: null }],
      },
    });

    const comment = buildIssueExecutionComment(issue, runResult, null);

    expect(comment).toContain("status=unknown");
    expect(comment).toContain("duration_ms=unknown");
    expect(comment).toContain("outcome=unknown");
    expect(comment).toContain("Validation had 1 failing command(s)");
  });

  it("includes challenge evidence section for challenge issue execution", () => {
    const challengeIssue = createIssue({ labels: ["challenge"] });
    const runResult = createRunResult();

    const comment = buildIssueExecutionComment(challengeIssue, runResult, {
      artifactPath: ".evolvo/challenge-attempts/12/0001.json",
      attempt: 1,
      outcome: "success",
      reviewOutcome: "accepted",
      runtimeErrorMessage: null,
    });

    expect(comment).toContain("### Challenge Attempt Artifact");
    expect(comment).toContain("Artifact path: `.evolvo/challenge-attempts/12/0001.json`");
    expect(comment).toContain("Runtime error message: none");
  });

  it("uses the resolved default branch in merge-related lifecycle comments", () => {
    const issue = createIssue({ number: 21 });
    const runResult = createRunResult();
    runResult.summary.pullRequestCreated = true;
    runResult.mergedPullRequest = true;

    const executionComment = buildIssueExecutionComment(issue, runResult, null, "release");
    const mergeComment = buildMergeOutcomeComment(issue, "release");

    expect(executionComment).toContain("PR merged into `release`: yes.");
    expect(mergeComment).toContain("Pull request for issue #21 was merged into `release`.");
  });

  it("builds failure comment with fallback unknown runtime message", () => {
    const issue = createIssue();

    const comment = buildIssueFailureComment(issue, { bad: true }, null);

    expect(comment).toContain("## Task Execution Problem");
    expect(comment).toContain("Unknown runtime error.");
    expect(comment).toContain("follow-up retry/amendment is required");
  });

  it("persists challenge attempt evidence for challenge issues", async () => {
    persistChallengeAttemptArtifactMock.mockResolvedValueOnce({
      relativePath: ".evolvo/challenge-attempts/12/0002.json",
      artifact: {
        attempt: 2,
        outcome: "failure",
        runtimeError: { message: "boom" },
        executionSummary: { reviewOutcome: "amended" },
      },
    });

    const evidence = await persistChallengeAttemptEvidence(
      "/tmp/evolvo",
      createIssue({ labels: ["challenge"] }),
      new Error("boom"),
      null,
    );

    expect(persistChallengeAttemptArtifactMock).toHaveBeenCalledTimes(1);
    expect(evidence).toEqual({
      artifactPath: ".evolvo/challenge-attempts/12/0002.json",
      attempt: 2,
      outcome: "failure",
      reviewOutcome: "amended",
      runtimeErrorMessage: "boom",
    });
  });

  it("returns null evidence for non-challenge issues", async () => {
    const evidence = await persistChallengeAttemptEvidence("/tmp/evolvo", createIssue(), null, null);

    expect(evidence).toBeNull();
    expect(persistChallengeAttemptArtifactMock).not.toHaveBeenCalled();
  });

  it("returns null and logs when challenge evidence persistence fails", async () => {
    persistChallengeAttemptArtifactMock.mockRejectedValueOnce(new Error("write failed"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const evidence = await persistChallengeAttemptEvidence(
      "/tmp/evolvo",
      createIssue({ labels: ["challenge"], number: 99 }),
      new Error("boom"),
      null,
    );

    expect(evidence).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith("Could not persist challenge attempt artifact for issue #99: write failed");
  });

  it("adds lifecycle comment and logs when manager rejects comment", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const issueManager = {
      addProgressComment: vi.fn().mockResolvedValue({ ok: false, message: "rejected" }),
    } as unknown as TaskIssueManager;

    await addIssueLifecycleComment(issueManager, 42, "hello");

    expect(errorSpy).toHaveBeenCalledWith("Could not add lifecycle comment to issue #42: rejected");
  });

  it("logs lifecycle comment error when addProgressComment throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const issueManager = {
      addProgressComment: vi.fn().mockRejectedValue(new Error("network down")),
    } as unknown as TaskIssueManager;

    await addIssueLifecycleComment(issueManager, 77, "hello");

    expect(errorSpy).toHaveBeenCalledWith("Could not add lifecycle comment to issue #77: network down");
  });
});
