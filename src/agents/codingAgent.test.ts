import { describe, expect, it } from "vitest";
import {
  CODING_AGENT_THREAD_OPTIONS,
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
    expect(prompt).toContain("run `pnpm i`");
    expect(prompt).toContain("run `pnpm build`");
    expect(prompt).toContain("run `pnpm start`");
  });

  it("requires a continuous issue loop after each completion", () => {
    const prompt = buildCodingPrompt("Issue #8: Upgrade your issue loop");

    expect(prompt).toContain("After completing an issue:");
    expect(prompt).toContain("close outdated issues");
    expect(prompt).toContain("maximum of 5 open issues");
  });

  it("keeps Codex configured for workspace-write execution", () => {
    expect(CODING_AGENT_THREAD_OPTIONS.sandboxMode).toBe("workspace-write");
    expect(CODING_AGENT_THREAD_OPTIONS.approvalPolicy).toBe("never");
  });
});
