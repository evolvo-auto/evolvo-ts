import { describe, expect, it } from "vitest";
import type { IssueSummary } from "./taskIssueManager.js";
import {
  hasIssueLabel,
  isChallengeInProgressIssue,
  isChallengeIssue,
  isChallengeRetryReadyIssue,
  parseChallengeIssueMetadata,
} from "./challengeIssue.js";

function createIssue(overrides: Partial<IssueSummary> = {}): IssueSummary {
  return {
    number: 1,
    title: "Issue",
    description: "Description",
    state: "open",
    labels: [],
    ...overrides,
  };
}

describe("challengeIssue", () => {
  it("matches labels case-insensitively", () => {
    const issue = createIssue({ labels: ["Challenge:Ready-To-Retry"] });
    expect(hasIssueLabel(issue, "challenge:ready-to-retry")).toBe(true);
  });

  it("parses challenge metadata block from issue description", () => {
    const metadata = parseChallengeIssueMetadata([
      "Some text",
      "<!-- evolvo:challenge",
      "id: challenge-44",
      "source_issue: #44",
      "retry_policy: gated",
      "-->",
      "More text",
    ].join("\n"));

    expect(metadata).toEqual({
      id: "challenge-44",
      source_issue: "#44",
      retry_policy: "gated",
    });
  });

  it("recognizes challenge issues by metadata when challenge label is missing", () => {
    const issue = createIssue({
      labels: ["bug"],
      description: [
        "<!-- evolvo:challenge",
        "id: challenge-44",
        "-->",
      ].join("\n"),
    });

    expect(isChallengeIssue(issue)).toBe(true);
  });

  it("recognizes retry-ready and in-progress challenge predicates", () => {
    const issue = createIssue({
      labels: ["challenge:ready-to-retry", "in progress"],
      description: "<!-- evolvo:challenge -->",
    });

    expect(isChallengeRetryReadyIssue(issue)).toBe(true);
    expect(isChallengeInProgressIssue(issue)).toBe(true);
  });

  it("returns false for non-challenge issues", () => {
    const issue = createIssue({ labels: ["enhancement"] });
    expect(isChallengeIssue(issue)).toBe(false);
    expect(isChallengeRetryReadyIssue(issue)).toBe(false);
    expect(isChallengeInProgressIssue(issue)).toBe(false);
  });
});
