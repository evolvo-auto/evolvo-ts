import { describe, expect, it } from "vitest";
import {
  CODING_AGENT_THREAD_OPTIONS,
  DEFAULT_CODING_AGENT_MODEL,
  ESCALATED_CODING_AGENT_MODEL,
  buildCodingAgentThreadOptions,
  buildCodingPrompt,
} from "./codingAgent.js";

describe("buildCodingPrompt", () => {
  it("includes the task after the host instructions", () => {
    const prompt = buildCodingPrompt("Create src/utils/add.ts");

    expect(prompt).toContain("Task:\nCreate src/utils/add.ts");
  });

  it("stops the dev agent at pull request handoff", () => {
    const prompt = buildCodingPrompt("Issue #2: Branching capabilities");

    expect(prompt).toContain("branch from main before making changes");
    expect(prompt).toContain("continue on that branch without asking for confirmation");
    expect(prompt).toContain("do not ask whether you should create a branch");
    expect(prompt).toContain("open a pull request linked to the issue");
    expect(prompt).toContain("you are the Dev agent");
    expect(prompt).toContain("only the Planner moves work from Inbox into Planning");
    expect(prompt).toContain("only the Planner moves work from Planning into Ready for Dev");
    expect(prompt).toContain("you may move work only from Ready for Dev to In Dev, then to Ready for Review");
    expect(prompt).toContain("do not review the pull request yourself");
    expect(prompt).toContain("do not merge the pull request yourself");
    expect(prompt).toContain("the host runtime will hand off review to a separate Review agent");
  });

  it("requires a continuous issue loop after each completion", () => {
    const prompt = buildCodingPrompt("Issue #8: Upgrade your issue loop");

    expect(prompt).toContain("After completing an issue:");
    expect(prompt).toContain("close outdated issues");
    expect(prompt).toContain("maximum of 5 open issues");
  });

  it("includes explicit external repository mode rules", () => {
    const prompt = buildCodingPrompt("Issue #40: Work on an external repository");

    expect(prompt).toContain("When a task explicitly requires external repository work");
    expect(prompt).toContain("keep strict separation between Evolvo's repository and the target repository");
    expect(prompt).toContain("record the external repository URL and external PR URL");
    expect(prompt).toContain("stop once the target pull request exists and is ready for review");
  });

  it("includes explicit runtime stability and high-risk surface guardrails", () => {
    const prompt = buildCodingPrompt("Issue #95: Improve master prompt discipline");

    expect(prompt).toContain("Protecting core runtime stability takes priority");
    expect(prompt).toContain("main issue loop orchestration");
    expect(prompt).toContain("restart and readiness flow");
    expect(prompt).toContain("GitHub write-side mutation paths");
  });

  it("distinguishes canonical, derived, and presentation state", () => {
    const prompt = buildCodingPrompt("Issue #90: Lifecycle state discipline");

    expect(prompt).toContain("canonical state: authoritative, persisted, used for control flow");
    expect(prompt).toContain("derived state: computed from canonical state and structured signals");
    expect(prompt).toContain("presentation state: comments, logs, labels, narrative output for humans");
    expect(prompt).toContain("Comments, labels, and logs are useful observability, but they are not automatically canonical truth.");
  });

  it("requires evidence-driven issue quality and structured facts over heuristics", () => {
    const prompt = buildCodingPrompt("Issue quality discipline");

    expect(prompt).toContain("prioritize issues backed by concrete evidence");
    expect(prompt).toContain("Avoid low-value issue generation based only on superficial repository shape.");
    expect(prompt).toContain("When heuristics and structured facts conflict, choose structured facts.");
  });

  it("guards against Playwright-first verification for Next.js work", () => {
    const prompt = buildCodingPrompt("Issue #130: Verify a Next.js application change");

    expect(prompt).toContain("do not use Playwright or other browser-driven end-to-end verification");
    expect(prompt).toContain("Default verification for Next.js work should be:");
    expect(prompt).toContain("lint");
    expect(prompt).toContain("build");
    expect(prompt).toContain("start");
    expect(prompt).toContain("test if the repository provides applicable tests");
    expect(prompt).toContain("Do not introduce Playwright-based verification just because it is available.");
  });

  it("keeps Codex configured for workspace-write execution", () => {
    expect(DEFAULT_CODING_AGENT_MODEL).toBe("gpt-5.3-codex");
    expect(ESCALATED_CODING_AGENT_MODEL).toBe("gpt-5.4");
    expect(CODING_AGENT_THREAD_OPTIONS.model).toBe(DEFAULT_CODING_AGENT_MODEL);
    expect(CODING_AGENT_THREAD_OPTIONS.sandboxMode).toBe("workspace-write");
    expect(CODING_AGENT_THREAD_OPTIONS.skipGitRepoCheck).toBe(true);
    expect(CODING_AGENT_THREAD_OPTIONS.approvalPolicy).toBe("never");
  });

  it("builds thread options for a resolved project working directory", () => {
    const options = buildCodingAgentThreadOptions("/home/paddy/habit-cli");

    expect(options).toEqual({
      ...CODING_AGENT_THREAD_OPTIONS,
      workingDirectory: "/home/paddy/habit-cli",
    });
  });

  it("builds thread options for an explicit escalation model", () => {
    const options = buildCodingAgentThreadOptions("/home/paddy/habit-cli", ESCALATED_CODING_AGENT_MODEL);

    expect(options).toEqual({
      ...CODING_AGENT_THREAD_OPTIONS,
      model: ESCALATED_CODING_AGENT_MODEL,
      workingDirectory: "/home/paddy/habit-cli",
    });
  });
});
