import { describe, expect, it, vi } from "vitest";
import {
  COMPLETED_LABEL,
  IN_PROGRESS_LABEL,
  TaskIssueManager,
} from "./taskIssueManager.js";
import { GitHubApiError } from "../github/githubClient.js";

type MockIssue = {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: Array<{ name: string }>;
  pull_request?: unknown;
};

function createIssue(overrides: Partial<MockIssue> = {}): MockIssue {
  return {
    number: 1,
    title: "Issue",
    body: "Description",
    state: "open",
    labels: [],
    ...overrides,
  };
}

function createClientMock() {
  return {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
  };
}

describe("TaskIssueManager", () => {
  it("creates an issue", async () => {
    const client = createClientMock();
    client.post.mockResolvedValue(createIssue({ number: 22, title: "New", body: "Details" }));
    const manager = new TaskIssueManager(client as never);

    const result = await manager.createIssue(" New ", " Details ");

    expect(result).toEqual({
      ok: true,
      message: "Created issue #22.",
      issue: {
        number: 22,
        title: "New",
        description: "Details",
        state: "open",
        labels: [],
      },
    });
    expect(client.post).toHaveBeenCalledWith("", { title: "New", body: "Details" });
  });

  it("rejects creating an issue with an empty title", async () => {
    const manager = new TaskIssueManager(createClientMock() as never);

    const result = await manager.createIssue("   ", "Details");

    expect(result).toEqual({ ok: false, message: "Issue title is required." });
  });

  it("lists only open issues and excludes PRs", async () => {
    const client = createClientMock();
    client.get.mockResolvedValue([
      createIssue({ number: 1 }),
      createIssue({ number: 2, pull_request: { url: "pr" } }),
    ]);
    const manager = new TaskIssueManager(client as never);

    const result = await manager.listOpenIssues();

    expect(result).toHaveLength(1);
    expect(result[0]?.number).toBe(1);
  });

  it("aggregates open issues across pages and excludes pull requests from all pages", async () => {
    const client = createClientMock();
    const firstPage = Array.from({ length: 100 }, (_, index) => createIssue({ number: index + 1 }));
    firstPage[3] = createIssue({ number: 4, pull_request: { url: "pr-1" } });

    client.get
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([
        createIssue({ number: 101 }),
        createIssue({ number: 102, pull_request: { url: "pr-2" } }),
      ]);

    const manager = new TaskIssueManager(client as never);

    const result = await manager.listOpenIssues();

    expect(client.get).toHaveBeenNthCalledWith(1, "?state=open&per_page=100&page=1");
    expect(client.get).toHaveBeenNthCalledWith(2, "?state=open&per_page=100&page=2");
    expect(result.map((issue) => issue.number)).toEqual([
      ...Array.from({ length: 3 }, (_, index) => index + 1),
      ...Array.from({ length: 96 }, (_, index) => index + 5),
      101,
    ]);
  });

  it("lists recent closed issues and excludes pull requests", async () => {
    const client = createClientMock();
    client.get.mockResolvedValue([
      createIssue({ number: 11, state: "closed" }),
      createIssue({ number: 12, state: "closed", pull_request: { url: "pr" } }),
    ]);
    const manager = new TaskIssueManager(client as never);

    const result = await manager.listRecentClosedIssues();

    expect(client.get).toHaveBeenCalledWith("?state=closed&sort=updated&direction=desc&per_page=100&page=1");
    expect(result).toEqual([
      {
        number: 11,
        title: "Issue",
        description: "Description",
        state: "closed",
        labels: [],
      },
    ]);
  });

  it("paginates recent closed issues until the requested non-PR limit is satisfied", async () => {
    const client = createClientMock();
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      createIssue({ number: index + 1, state: "closed" }),
    );
    firstPage[0] = createIssue({ number: 1, state: "closed", pull_request: { url: "pr-1" } });
    client.get
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([
        createIssue({ number: 101, state: "closed", pull_request: { url: "pr-2" } }),
        createIssue({ number: 102, state: "closed" }),
      ]);
    const manager = new TaskIssueManager(client as never);

    const result = await manager.listRecentClosedIssues(100);

    expect(client.get).toHaveBeenNthCalledWith(1, "?state=closed&sort=updated&direction=desc&per_page=100&page=1");
    expect(client.get).toHaveBeenNthCalledWith(2, "?state=closed&sort=updated&direction=desc&per_page=100&page=2");
    expect(result).toHaveLength(100);
    expect(result[0]?.number).toBe(2);
    expect(result[99]?.number).toBe(102);
  });

  it("creates planned issues without generating follow-up titles", async () => {
    const client = createClientMock();
    client.get
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        createIssue({ number: 4, state: "closed", title: "Candidate A" }),
      ]);
    client.post.mockResolvedValueOnce(createIssue({ number: 31, title: "Candidate B" }));
    const manager = new TaskIssueManager(client as never);

    const result = await manager.createPlannedIssues({
      minimumIssueCount: 3,
      maximumOpenIssues: 4,
      issues: [
        { title: "Candidate A", description: "A" },
        { title: "Candidate B", description: "B" },
      ],
    });

    expect(result.created).toHaveLength(1);
    expect(result.created[0]?.title).toBe("Candidate B");
    expect(client.post).toHaveBeenCalledTimes(1);
    expect(client.post).toHaveBeenCalledWith("", expect.objectContaining({ title: "Candidate B" }));
  });

  it("skips planned titles that collide with recent follow-up history after normalization", async () => {
    const client = createClientMock();
    client.get
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        createIssue({
          number: 4,
          state: "closed",
          title: "Startup bootstrap reliability hardening (follow-up 2)",
        }),
      ]);
    client.post.mockResolvedValueOnce(createIssue({ number: 31, title: "Distinct candidate" }));
    const manager = new TaskIssueManager(client as never);

    const result = await manager.createPlannedIssues({
      minimumIssueCount: 2,
      maximumOpenIssues: 4,
      issues: [
        { title: "Startup bootstrap reliability hardening", description: "Should be blocked by history." },
        { title: "Distinct candidate", description: "Should still be created." },
      ],
    });

    expect(result.created).toHaveLength(1);
    expect(result.created[0]?.title).toBe("Distinct candidate");
    expect(client.post).toHaveBeenCalledTimes(1);
    expect(client.post).toHaveBeenCalledWith("", expect.objectContaining({ title: "Distinct candidate" }));
  });

  it("skips planned duplicates found beyond the first recent-closed page", async () => {
    const client = createClientMock();
    const firstClosedPage = Array.from({ length: 100 }, (_, index) =>
      createIssue({
        number: index + 1,
        state: "closed",
        title: `Closed issue ${index + 1}`,
      }),
    );
    client.get
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(firstClosedPage)
      .mockResolvedValueOnce([
        createIssue({ number: 101, state: "closed", title: "Late duplicate candidate" }),
      ]);
    client.post.mockResolvedValueOnce(createIssue({ number: 201, title: "Fresh candidate" }));
    const manager = new TaskIssueManager(client as never);

    const result = await manager.createPlannedIssues({
      minimumIssueCount: 2,
      maximumOpenIssues: 4,
      issues: [
        { title: "Late duplicate candidate", description: "Should be skipped from page two history." },
        { title: "Fresh candidate", description: "Should still be created." },
      ],
    });

    expect(client.get).toHaveBeenNthCalledWith(2, "?state=closed&sort=updated&direction=desc&per_page=100&page=1");
    expect(client.get).toHaveBeenNthCalledWith(3, "?state=closed&sort=updated&direction=desc&per_page=100&page=2");
    expect(result.created).toHaveLength(1);
    expect(result.created[0]?.title).toBe("Fresh candidate");
    expect(client.post).toHaveBeenCalledTimes(1);
    expect(client.post).toHaveBeenCalledWith("", expect.objectContaining({ title: "Fresh candidate" }));
  });

  it("deduplicates planned titles that only differ by a follow-up suffix", async () => {
    const client = createClientMock();
    client.get
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    client.post.mockResolvedValueOnce(
      createIssue({ number: 31, title: "Startup bootstrap reliability hardening" }),
    );
    const manager = new TaskIssueManager(client as never);

    const result = await manager.createPlannedIssues({
      minimumIssueCount: 2,
      maximumOpenIssues: 4,
      issues: [
        { title: "Startup bootstrap reliability hardening", description: "Keep the base title." },
        {
          title: "Startup bootstrap reliability hardening (follow-up 1)",
          description: "This should be treated as the same planned title.",
        },
      ],
    });

    expect(result.created).toHaveLength(1);
    expect(result.created[0]?.title).toBe("Startup bootstrap reliability hardening");
    expect(client.post).toHaveBeenCalledTimes(1);
    expect(client.post).toHaveBeenCalledWith(
      "",
      expect.objectContaining({ title: "Startup bootstrap reliability hardening" }),
    );
  });

  it("creates planned issues only up to the queue deficit when blocked open issues already exist", async () => {
    const client = createClientMock();
    client.get
      .mockResolvedValueOnce([
        createIssue({ number: 1, title: "Blocked issue", labels: [{ name: "blocked" }] }),
        createIssue({ number: 2, title: "Another open issue", labels: [{ name: "in progress" }] }),
      ])
      .mockResolvedValueOnce([]);
    client.post.mockResolvedValueOnce(createIssue({ number: 31, title: "Candidate A" }));
    const manager = new TaskIssueManager(client as never);

    const result = await manager.createPlannedIssues({
      minimumIssueCount: 3,
      maximumOpenIssues: 5,
      issues: [
        { title: "Candidate A", description: "Should fill the single missing queue slot." },
        { title: "Candidate B", description: "Should not be created once the deficit is filled." },
      ],
    });

    expect(result.created).toHaveLength(1);
    expect(result.created[0]?.title).toBe("Candidate A");
    expect(client.post).toHaveBeenCalledTimes(1);
    expect(client.post).toHaveBeenCalledWith("", expect.objectContaining({ title: "Candidate A" }));
  });

  it("replenishes empty queue with provided repository-derived candidates", async () => {
    const client = createClientMock();
    client.get
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    client.post
      .mockResolvedValueOnce(createIssue({ number: 21, title: "Candidate A" }))
      .mockResolvedValueOnce(createIssue({ number: 22, title: "Candidate B" }))
      .mockResolvedValueOnce(createIssue({ number: 23, title: "Candidate C" }));
    const manager = new TaskIssueManager(client as never);

    const result = await manager.replenishSelfImprovementIssues({
      minimumIssueCount: 3,
      maximumOpenIssues: 5,
      templates: [
        { title: "Candidate A", description: "A" },
        { title: "Candidate B", description: "B" },
        { title: "Candidate C", description: "C" },
      ],
    });

    expect(result.created).toHaveLength(3);
    expect(result.created.map((issue) => issue.number)).toEqual([21, 22, 23]);
    expect(client.get).toHaveBeenNthCalledWith(1, "?state=open&per_page=100&page=1");
    expect(client.get).toHaveBeenNthCalledWith(2, "?state=closed&sort=updated&direction=desc&per_page=100&page=1");
  });

  it("prioritizes evidence-backed candidates from recurring workflow failures", async () => {
    const client = createClientMock();
    client.get
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        createIssue({
          number: 77,
          state: "closed",
          title: "Challenge workflow friction follow-up",
          body: "Challenge-Failure-Category: workflow_failure\nPull request merge and retry flow failed repeatedly.",
        }),
      ]);
    client.post.mockResolvedValueOnce(
      createIssue({ number: 31, title: "Workflow reliability candidate" }),
    );
    const manager = new TaskIssueManager(client as never);

    const result = await manager.replenishSelfImprovementIssues({
      minimumIssueCount: 1,
      maximumOpenIssues: 5,
      templates: [
        { title: "Validation candidate", description: "Validation and typecheck coverage hardening." },
        { title: "Workflow reliability candidate", description: "Workflow retry and merge reliability." },
      ],
    });

    expect(result.created).toHaveLength(1);
    expect(result.created[0]?.title).toBe("Workflow reliability candidate");
    expect(client.post).toHaveBeenCalledWith(
      "",
      expect.objectContaining({ title: "Workflow reliability candidate" }),
    );
  });

  it("avoids duplicates against recent issue history and limits creations by open slots", async () => {
    const client = createClientMock();
    client.get
      .mockResolvedValueOnce([
        createIssue({ number: 1, title: "Existing open issue" }),
        createIssue({ number: 2, title: "Another open issue" }),
        createIssue({ number: 3, title: "Third open issue" }),
      ])
      .mockResolvedValueOnce([
        createIssue({ number: 4, state: "closed", title: "Candidate A" }),
      ]);
    client.post.mockResolvedValue(createIssue({ number: 31, title: "Candidate A (follow-up 1)" }));
    const manager = new TaskIssueManager(client as never);

    const result = await manager.replenishSelfImprovementIssues({
      minimumIssueCount: 3,
      maximumOpenIssues: 4,
      templates: [
        { title: "Candidate A", description: "A" },
        { title: "Candidate B", description: "B" },
      ],
    });

    expect(result.created).toHaveLength(1);
    expect(result.created[0]?.number).toBe(31);
    expect(result.created[0]?.title).toBe("Candidate A (follow-up 1)");
    expect(client.post).toHaveBeenCalledTimes(1);
    expect(client.post).toHaveBeenCalledWith(
      "",
      expect.objectContaining({ title: "Candidate A (follow-up 1)" }),
    );
  });

  it("ignores closed pull request titles when replenishing issue history", async () => {
    const client = createClientMock();
    client.get
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        createIssue({
          number: 4,
          state: "closed",
          title: "Candidate A",
          pull_request: { url: "https://github.com/evolvo-auto/evolvo-ts/pull/4" },
        }),
      ]);
    client.post.mockResolvedValueOnce(createIssue({ number: 31, title: "Candidate A" }));
    const manager = new TaskIssueManager(client as never);

    const result = await manager.replenishSelfImprovementIssues({
      minimumIssueCount: 1,
      maximumOpenIssues: 5,
      templates: [
        { title: "Candidate A", description: "Should not be blocked by a closed PR title." },
        { title: "Candidate B", description: "Should stay unused because Candidate A is still valid." },
      ],
    });

    expect(result.created).toHaveLength(1);
    expect(result.created[0]?.title).toBe("Candidate A");
    expect(client.post).toHaveBeenCalledTimes(1);
    expect(client.post).toHaveBeenCalledWith("", expect.objectContaining({ title: "Candidate A" }));
  });

  it("supports startup-provided templates and creates follow-up titles when needed", async () => {
    const client = createClientMock();
    client.get
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([createIssue({ number: 9, state: "closed", title: "Improve startup bootstrap logging" })]);
    client.post
      .mockResolvedValueOnce(createIssue({ number: 41, title: "Improve startup bootstrap logging (follow-up 1)" }))
      .mockResolvedValueOnce(createIssue({ number: 42, title: "Add startup queue health metric emission" }))
      .mockResolvedValueOnce(createIssue({ number: 43, title: "Harden startup fallback diagnostics" }));
    const manager = new TaskIssueManager(client as never);

    const result = await manager.replenishSelfImprovementIssues({
      minimumIssueCount: 3,
      maximumOpenIssues: 5,
      templates: [
        { title: "Improve startup bootstrap logging", description: "Improve logs." },
        { title: "Add startup queue health metric emission", description: "Emit metrics." },
        { title: "Harden startup fallback diagnostics", description: "Improve diagnostics." },
      ],
    });

    expect(result.created).toHaveLength(3);
    expect(result.created.map((issue) => issue.title)).toEqual([
      "Improve startup bootstrap logging (follow-up 1)",
      "Add startup queue health metric emission",
      "Harden startup fallback diagnostics",
    ]);
    expect(client.post).toHaveBeenCalledTimes(3);
  });

  it("returns no new issues when no repository-derived candidates are provided", async () => {
    const client = createClientMock();
    const manager = new TaskIssueManager(client as never);

    const result = await manager.replenishSelfImprovementIssues({
      minimumIssueCount: 3,
      maximumOpenIssues: 5,
      templates: [],
    });

    expect(result).toEqual({ created: [] });
    expect(client.get).not.toHaveBeenCalled();
    expect(client.post).not.toHaveBeenCalled();
  });

  it("exits safely with no creations when duplicate history exhausts bounded attempts", async () => {
    const client = createClientMock();
    const duplicateClosedHistory = [
      createIssue({ number: 1, state: "closed", title: "Template A" }),
      ...Array.from({ length: 20 }, (_, index) =>
        createIssue({
          number: index + 2,
          state: "closed",
          title: `Template A (follow-up ${index + 1})`,
        }),
      ),
    ];

    client.get.mockResolvedValueOnce([]).mockResolvedValueOnce(duplicateClosedHistory);

    const manager = new TaskIssueManager(client as never);
    const result = await manager.replenishSelfImprovementIssues({
      minimumIssueCount: 5,
      maximumOpenIssues: 5,
      templates: [{ title: "Template A", description: "Heavy duplicate history." }],
    });

    expect(result).toEqual({ created: [] });
    expect(client.post).not.toHaveBeenCalled();
  });

  it("remains deterministic and returns valid follow-up issues when duplicates are common", async () => {
    const client = createClientMock();
    const duplicateClosedHistory = [
      createIssue({ number: 1, state: "closed", title: "Template A" }),
      ...Array.from({ length: 8 }, (_, index) =>
        createIssue({
          number: index + 2,
          state: "closed",
          title: `Template A (follow-up ${index + 1})`,
        }),
      ),
      createIssue({ number: 99, state: "closed", title: "Template B" }),
    ];

    client.get.mockResolvedValueOnce([]).mockResolvedValueOnce(duplicateClosedHistory);
    client.post
      .mockResolvedValueOnce(createIssue({ number: 401, title: "Template A (follow-up 9)" }))
      .mockResolvedValueOnce(createIssue({ number: 402, title: "Template B (follow-up 1)" }));

    const manager = new TaskIssueManager(client as never);
    const result = await manager.replenishSelfImprovementIssues({
      minimumIssueCount: 2,
      maximumOpenIssues: 5,
      templates: [
        { title: "Template A", description: "A desc" },
        { title: "Template B", description: "B desc" },
      ],
    });

    expect(result.created.map((issue) => issue.title)).toEqual([
      "Template A (follow-up 9)",
      "Template B (follow-up 1)",
    ]);
    expect(client.post).toHaveBeenCalledTimes(2);
    expect(client.post).toHaveBeenNthCalledWith(
      1,
      "",
      expect.objectContaining({ title: "Template A (follow-up 9)" }),
    );
    expect(client.post).toHaveBeenNthCalledWith(
      2,
      "",
      expect.objectContaining({ title: "Template B (follow-up 1)" }),
    );
  });

  it("marks an issue in progress", async () => {
    const client = createClientMock();
    client.get.mockResolvedValue(createIssue({ labels: [{ name: "bug" }] }));
    client.patch.mockResolvedValue(createIssue({ labels: [{ name: "bug" }, { name: IN_PROGRESS_LABEL }] }));
    const manager = new TaskIssueManager(client as never);

    const result = await manager.markInProgress(1);

    expect(result.ok).toBe(true);
    expect(result.message).toBe("Issue #1 marked as in progress.");
    expect(client.patch).toHaveBeenCalledWith("/1", {
      labels: ["bug", IN_PROGRESS_LABEL],
    });
  });

  it("prevents starting work on an issue already in progress", async () => {
    const client = createClientMock();
    client.get.mockResolvedValue(createIssue({ labels: [{ name: IN_PROGRESS_LABEL }] }));
    const manager = new TaskIssueManager(client as never);

    const result = await manager.markInProgress(1);

    expect(result).toEqual({
      ok: false,
      message: "Issue #1 is already in progress.",
    });
  });

  it("prevents starting work on a closed issue", async () => {
    const client = createClientMock();
    client.get.mockResolvedValue(createIssue({ state: "closed" }));
    const manager = new TaskIssueManager(client as never);

    const result = await manager.markInProgress(1);

    expect(result).toEqual({
      ok: false,
      message: "Issue #1 is closed and cannot be started.",
    });
  });

  it("adds a progress comment", async () => {
    const client = createClientMock();
    client.get.mockResolvedValue(createIssue());
    client.post.mockResolvedValue({});
    const manager = new TaskIssueManager(client as never);

    const result = await manager.addProgressComment(1, " update ");

    expect(result.ok).toBe(true);
    expect(client.post).toHaveBeenCalledWith("/1/comments", { body: "update" });
  });

  it("rejects an empty progress comment", async () => {
    const manager = new TaskIssueManager(createClientMock() as never);

    const result = await manager.addProgressComment(1, "  ");

    expect(result).toEqual({
      ok: false,
      message: "Progress comment cannot be empty.",
    });
  });

  it("marks an issue as completed and removes in-progress label", async () => {
    const client = createClientMock();
    client.get.mockResolvedValue(createIssue({ labels: [{ name: IN_PROGRESS_LABEL }, { name: "bug" }] }));
    client.post.mockResolvedValue({});
    client.patch.mockResolvedValue(createIssue({ labels: [{ name: "bug" }, { name: COMPLETED_LABEL }] }));
    const manager = new TaskIssueManager(client as never);

    const result = await manager.markCompleted(1, " final summary ");

    expect(result.ok).toBe(true);
    expect(client.post).toHaveBeenCalledWith("/1/comments", { body: "final summary" });
    expect(client.patch).toHaveBeenCalledWith("/1", {
      labels: ["bug", COMPLETED_LABEL],
    });
  });

  it("prevents marking an already completed issue as completed again", async () => {
    const client = createClientMock();
    client.get.mockResolvedValue(createIssue({ labels: [{ name: COMPLETED_LABEL }] }));
    const manager = new TaskIssueManager(client as never);

    const result = await manager.markCompleted(1, "summary");

    expect(result).toEqual({
      ok: false,
      message: "Issue #1 is already marked as completed.",
    });
  });

  it("rejects an empty completion summary", async () => {
    const manager = new TaskIssueManager(createClientMock() as never);

    const result = await manager.markCompleted(1, " ");

    expect(result).toEqual({ ok: false, message: "Completion summary cannot be empty." });
  });

  it("closes an open issue", async () => {
    const client = createClientMock();
    client.get.mockResolvedValue(createIssue());
    client.patch.mockResolvedValue(createIssue({ state: "closed" }));
    const manager = new TaskIssueManager(client as never);

    const result = await manager.closeIssue(1);

    expect(result).toEqual({
      ok: true,
      message: "Issue #1 closed successfully.",
      issue: {
        number: 1,
        title: "Issue",
        description: "Description",
        state: "closed",
        labels: [],
      },
    });
  });

  it("does not close an already closed issue", async () => {
    const client = createClientMock();
    client.get.mockResolvedValue(createIssue({ state: "closed" }));
    const manager = new TaskIssueManager(client as never);

    const result = await manager.closeIssue(1);

    expect(result).toEqual({
      ok: false,
      message: "Issue #1 is already closed.",
    });
  });

  it("updates labels by adding and removing managed challenge labels", async () => {
    const client = createClientMock();
    client.get.mockResolvedValue(
      createIssue({
        labels: [{ name: "challenge" }, { name: "in progress" }, { name: "challenge:ready-to-retry" }],
      }),
    );
    client.patch.mockResolvedValue(
      createIssue({
        labels: [{ name: "challenge" }, { name: "challenge:failed" }],
      }),
    );
    const manager = new TaskIssueManager(client as never);

    const result = await manager.updateLabels(1, {
      add: ["challenge:failed"],
      remove: ["in progress", "challenge:ready-to-retry"],
    });

    expect(result.ok).toBe(true);
    expect(client.patch).toHaveBeenCalledWith("/1", {
      labels: ["challenge", "challenge:failed"],
    });
  });

  it("returns without patch when labels are already up to date", async () => {
    const client = createClientMock();
    client.get.mockResolvedValue(createIssue({ labels: [{ name: "challenge" }, { name: "challenge:failed" }] }));
    const manager = new TaskIssueManager(client as never);

    const result = await manager.updateLabels(1, {
      add: ["challenge:failed"],
      remove: [],
    });

    expect(result).toEqual({
      ok: true,
      message: "Issue #1 labels already up to date.",
      issue: {
        number: 1,
        title: "Issue",
        description: "Description",
        state: "open",
        labels: ["challenge", "challenge:failed"],
      },
    });
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("prevents relabeling a closed issue", async () => {
    const client = createClientMock();
    client.get.mockResolvedValue(createIssue({ state: "closed" }));
    const manager = new TaskIssueManager(client as never);

    const result = await manager.updateLabels(1, {
      add: ["challenge:failed"],
    });

    expect(result).toEqual({
      ok: false,
      message: "Issue #1 is closed and cannot be relabeled.",
    });
  });

  it("returns not found if GitHub returns 404", async () => {
    const client = createClientMock();
    client.get.mockRejectedValue(new GitHubApiError("not found", 404, null));
    const manager = new TaskIssueManager(client as never);

    const result = await manager.markInProgress(1);

    expect(result).toEqual({
      ok: false,
      message: "Issue #1 was not found.",
    });
  });

  it("treats pull requests as non-issues", async () => {
    const client = createClientMock();
    client.get.mockResolvedValue(createIssue({ pull_request: { url: "pr" } }));
    const manager = new TaskIssueManager(client as never);

    const result = await manager.markInProgress(1);

    expect(result).toEqual({
      ok: false,
      message: "Issue #1 was not found.",
    });
  });

  it("rethrows non-404 API errors", async () => {
    const client = createClientMock();
    client.get.mockRejectedValue(new GitHubApiError("nope", 500, null));
    const manager = new TaskIssueManager(client as never);

    await expect(manager.markInProgress(1)).rejects.toEqual(
      expect.objectContaining({ status: 500 }),
    );
  });
});
