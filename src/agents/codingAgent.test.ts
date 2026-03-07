import { describe, expect, it } from "vitest";
import {
  CODING_AGENT_THREAD_OPTIONS,
  buildCodingAgentThreadOptions,
  buildCodingPrompt,
} from "./codingAgent.js";

describe("buildCodingPrompt", () => {
  it("includes the task after the host instructions", () => {
    const prompt = buildCodingPrompt("Create src/utils/add.ts");

    expect(prompt).toContain("Task:\nCreate src/utils/add.ts");
  });

  it("includes the issue branch and pull request review workflow", () => {
    const prompt = buildCodingPrompt("Issue #2: Branching capabilities");

    expect(prompt).toContain("branch from main before making changes");
    expect(prompt).toContain("open a pull request linked to the issue");
    expect(prompt).toContain("continue the reject/fix/re-review cycle until the review outcome is accept");
    expect(prompt).toContain("merge the pull request into main");
    expect(prompt).toContain("the outer host runtime is responsible for post-merge restart orchestration");
    expect(prompt).toContain("do not run checkout, pull, install, build, or restart commands after the merge");
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
    expect(prompt).toContain("explicitly confirm whether the external PR was merged");
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

  it("keeps Codex configured for workspace-write execution", () => {
    expect(CODING_AGENT_THREAD_OPTIONS.sandboxMode).toBe("workspace-write");
    expect(CODING_AGENT_THREAD_OPTIONS.approvalPolicy).toBe("never");
  });

  it("builds thread options for a resolved project working directory", () => {
    const options = buildCodingAgentThreadOptions("/tmp/evolvo/projects/habit-cli");

    expect(options).toEqual({
      ...CODING_AGENT_THREAD_OPTIONS,
      workingDirectory: "/tmp/evolvo/projects/habit-cli",
    });
  });
});
