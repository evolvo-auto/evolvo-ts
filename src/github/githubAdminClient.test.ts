import { describe, expect, it, vi } from "vitest";
import { GitHubAdminClient } from "./githubAdminClient.js";
import { GitHubApiError } from "./githubClient.js";

function createClientMock() {
  return {
    getApi: vi.fn(),
    postApi: vi.fn(),
  };
}

describe("GitHubAdminClient", () => {
  it("does not recreate an existing tracker label", async () => {
    const client = createClientMock();
    client.getApi.mockResolvedValue({ name: "project:habit-cli" });
    const adminClient = new GitHubAdminClient(client as never, {
      token: "token",
      owner: "evolvo-auto",
      repo: "evolvo-ts",
      apiBaseUrl: "https://api.github.com",
    });

    await adminClient.ensureLabel({
      owner: "evolvo-auto",
      repo: "evolvo-ts",
      name: "project:habit-cli",
    });

    expect(client.getApi).toHaveBeenCalledWith("/repos/evolvo-auto/evolvo-ts/labels/project%3Ahabit-cli");
    expect(client.postApi).not.toHaveBeenCalled();
  });

  it("creates a tracker label when it does not exist", async () => {
    const client = createClientMock();
    client.getApi.mockRejectedValueOnce(new GitHubApiError("missing", 404, null));
    client.postApi.mockResolvedValue({ name: "project:habit-cli" });
    const adminClient = new GitHubAdminClient(client as never, {
      token: "token",
      owner: "evolvo-auto",
      repo: "evolvo-ts",
      apiBaseUrl: "https://api.github.com",
    });

    await adminClient.ensureLabel({
      owner: "evolvo-auto",
      repo: "evolvo-ts",
      name: "project:habit-cli",
      description: "Issues for Habit CLI",
    });

    expect(client.postApi).toHaveBeenCalledWith(
      "/repos/evolvo-auto/evolvo-ts/labels",
      expect.objectContaining({
        name: "project:habit-cli",
        description: "Issues for Habit CLI",
      }),
    );
  });

  it("tolerates concurrent tracker label creation by re-reading the label", async () => {
    const client = createClientMock();
    client.getApi
      .mockRejectedValueOnce(new GitHubApiError("missing", 404, null))
      .mockResolvedValueOnce({ name: "project:habit-cli" });
    client.postApi.mockRejectedValueOnce(new GitHubApiError("already exists", 422, null));
    const adminClient = new GitHubAdminClient(client as never, {
      token: "token",
      owner: "evolvo-auto",
      repo: "evolvo-ts",
      apiBaseUrl: "https://api.github.com",
    });

    await adminClient.ensureLabel({
      owner: "evolvo-auto",
      repo: "evolvo-ts",
      name: "project:habit-cli",
    });

    expect(client.getApi).toHaveBeenCalledTimes(2);
    expect(client.postApi).toHaveBeenCalledTimes(1);
  });

  it("verifies and returns an existing managed repository", async () => {
    const client = createClientMock();
    client.getApi.mockResolvedValueOnce({
      id: 1001,
      name: "habit-cli",
      html_url: "https://github.com/evolvo-auto/habit-cli",
      default_branch: "main",
      description: "Habit CLI <deployable>",
      owner: {
        login: "evolvo-auto",
      },
    });
    const adminClient = new GitHubAdminClient(client as never, {
      token: "token",
      owner: "evolvo-auto",
      repo: "evolvo-ts",
      apiBaseUrl: "https://api.github.com",
    });

    await expect(
      adminClient.ensureRepository({
        owner: "evolvo-auto",
        repo: "habit-cli",
      }),
    ).resolves.toEqual({
      id: 1001,
      owner: "evolvo-auto",
      repo: "habit-cli",
      url: "https://github.com/evolvo-auto/habit-cli",
      defaultBranch: "main",
      description: "Habit CLI <deployable>",
    });
    expect(client.postApi).not.toHaveBeenCalled();
  });

  it("creates and verifies an organization repository when it does not exist", async () => {
    const client = createClientMock();
    client.getApi
      .mockRejectedValueOnce(new GitHubApiError("missing", 404, null))
      .mockResolvedValueOnce({ login: "evolvo-auto", type: "Organization" })
      .mockResolvedValueOnce({
        name: "habit-cli",
        html_url: "https://github.com/evolvo-auto/habit-cli",
        default_branch: "main",
        owner: {
          login: "evolvo-auto",
        },
      });
    client.postApi.mockResolvedValueOnce({});
    const adminClient = new GitHubAdminClient(client as never, {
      token: "token",
      owner: "evolvo-auto",
      repo: "evolvo-ts",
      apiBaseUrl: "https://api.github.com",
    });

    const result = await adminClient.ensureRepository({
      owner: "evolvo-auto",
      repo: "habit-cli",
      description: "Managed project",
    });

    expect(client.getApi).toHaveBeenNthCalledWith(2, "/users/evolvo-auto");
    expect(client.postApi).toHaveBeenCalledWith(
      "/orgs/evolvo-auto/repos",
      expect.objectContaining({
        name: "habit-cli",
        description: "Managed project",
        has_issues: true,
      }),
    );
    expect(result).toEqual({
      id: null,
      owner: "evolvo-auto",
      repo: "habit-cli",
      url: "https://github.com/evolvo-auto/habit-cli",
      defaultBranch: "main",
      description: null,
    });
  });
});
