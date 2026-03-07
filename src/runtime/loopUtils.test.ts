import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubApiError } from "../github/githubClient.js";
import { getRunLoopRetryDelayMs, isTransientGitHubError, selectIssueForWork, waitForRunLoopRetry } from "./loopUtils.js";

describe("loopUtils retry handling", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses exponential retry delays with an upper bound", () => {
    expect(getRunLoopRetryDelayMs(1)).toBe(50);
    expect(getRunLoopRetryDelayMs(2)).toBe(100);
    expect(getRunLoopRetryDelayMs(3)).toBe(200);
    expect(getRunLoopRetryDelayMs(4)).toBe(400);
    expect(getRunLoopRetryDelayMs(5)).toBe(800);
    expect(getRunLoopRetryDelayMs(6)).toBe(1000);
    expect(getRunLoopRetryDelayMs(9)).toBe(1000);
  });

  it("falls back to base delay when retry attempt input is invalid", () => {
    expect(getRunLoopRetryDelayMs(0)).toBe(50);
    expect(getRunLoopRetryDelayMs(-3)).toBe(50);
    expect(getRunLoopRetryDelayMs(Number.NaN)).toBe(50);
    expect(getRunLoopRetryDelayMs(Number.POSITIVE_INFINITY)).toBe(50);
  });

  it("classifies transient GitHub API status errors correctly", () => {
    expect(isTransientGitHubError(new GitHubApiError("rate", 429, null))).toBe(true);
    expect(isTransientGitHubError(new GitHubApiError("server", 500, null))).toBe(true);
    expect(isTransientGitHubError(new GitHubApiError("bad gateway", 502, null))).toBe(true);
    expect(isTransientGitHubError(new GitHubApiError("unavailable", 503, null))).toBe(true);
    expect(isTransientGitHubError(new GitHubApiError("gateway timeout", 504, null))).toBe(true);
    expect(
      isTransientGitHubError(
        new GitHubApiError("GitHub API request failed (403): API rate limit exceeded for user", 403, {
          message: "API rate limit exceeded for user.",
        }),
      ),
    ).toBe(true);
    expect(isTransientGitHubError(new GitHubApiError("forbidden", 403, { message: "Resource not accessible" }))).toBe(false);
  });

  it("classifies transient non-GitHubApiError failures correctly", () => {
    expect(isTransientGitHubError(new TypeError("fetch failed"))).toBe(true);
    expect(isTransientGitHubError(new Error("GitHub API request timed out after 5000ms"))).toBe(true);
    expect(isTransientGitHubError(new Error("unexpected local failure"))).toBe(false);
  });

  it("waits for the requested retry delay", async () => {
    vi.useFakeTimers();
    const retryPromise = waitForRunLoopRetry(250);

    await vi.advanceTimersByTimeAsync(249);
    let resolved = false;
    void retryPromise.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await retryPromise;
    expect(resolved).toBe(true);
  });

  it("skips generically blocked issues when selecting work", () => {
    const selected = selectIssueForWork([
      {
        number: 1,
        title: "Blocked project issue",
        description: "blocked",
        state: "open",
        labels: ["blocked"],
      },
      {
        number: 2,
        title: "Ready issue",
        description: "ready",
        state: "open",
        labels: [],
      },
    ]);

    expect(selected?.number).toBe(2);
  });
});
