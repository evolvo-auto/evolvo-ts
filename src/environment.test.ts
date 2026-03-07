import { afterEach, describe, expect, it, vi } from "vitest";

async function importEnvironment() {
  vi.resetModules();
  return import("./environment.js");
}

describe("environment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("exports the required environment variables", async () => {
    vi.stubEnv("CONTEXT7_API_KEY", "  ctx  ");
    vi.stubEnv("OPENAI_API_KEY", "\topenai\t");
    vi.stubEnv("GITHUB_TOKEN", " github-token ");
    vi.stubEnv("GITHUB_OWNER", "  owner");
    vi.stubEnv("GITHUB_REPO", "repo  ");

    const environment = await importEnvironment();

    expect(environment.CONTEXT7_API_KEY).toBe("ctx");
    expect(environment.OPENAI_API_KEY).toBe("openai");
    expect(environment.GITHUB_TOKEN).toBe("github-token");
    expect(environment.GITHUB_OWNER).toBe("owner");
    expect(environment.GITHUB_REPO).toBe("repo");
  });

  it("throws when a required environment variable is missing", async () => {
    vi.stubEnv("CONTEXT7_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "openai");
    vi.stubEnv("GITHUB_TOKEN", "github-token");
    vi.stubEnv("GITHUB_OWNER", "owner");
    vi.stubEnv("GITHUB_REPO", "repo");

    await expect(importEnvironment()).rejects.toThrow(
      "CONTEXT7_API_KEY is not set in the environment variables.",
    );
  });

  it("throws when a required environment variable is whitespace-only", async () => {
    vi.stubEnv("CONTEXT7_API_KEY", "   ");
    vi.stubEnv("OPENAI_API_KEY", "openai");
    vi.stubEnv("GITHUB_TOKEN", "github-token");
    vi.stubEnv("GITHUB_OWNER", "owner");
    vi.stubEnv("GITHUB_REPO", "repo");

    await expect(importEnvironment()).rejects.toThrow(
      "CONTEXT7_API_KEY is not set in the environment variables.",
    );
  });
});
