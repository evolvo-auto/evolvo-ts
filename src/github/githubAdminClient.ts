import type { GitHubConfig } from "./githubConfig.js";
import { GitHubApiError, GitHubClient } from "./githubClient.js";

type GitHubOwnerResponse = {
  login?: unknown;
  type?: unknown;
};

type GitHubLabelResponse = {
  name?: unknown;
  color?: unknown;
  description?: unknown;
};

type GitHubRepositoryResponse = {
  id?: unknown;
  name?: unknown;
  html_url?: unknown;
  default_branch?: unknown;
  description?: unknown;
  owner?: {
    login?: unknown;
  };
};

export type GitHubAdminRepository = {
  id: number | null;
  owner: string;
  repo: string;
  url: string;
  defaultBranch: string | null;
  description: string | null;
};

export class GitHubAdminClient {
  public constructor(
    private readonly client: GitHubClient,
    private readonly config: GitHubConfig,
  ) {}

  public async ensureLabel(options: {
    owner: string;
    repo: string;
    name: string;
    color?: string;
    description?: string;
  }): Promise<void> {
    const labelPath = this.buildLabelPath(options.owner, options.repo, options.name);

    try {
      await this.client.getApi<GitHubLabelResponse>(labelPath);
      return;
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 404) {
        throw error;
      }
    }

    try {
      await this.client.postApi<GitHubLabelResponse>(
        `/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}/labels`,
        {
          name: options.name,
          color: options.color ?? "0e8a16",
          description: options.description?.trim() || undefined,
        },
      );
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 422) {
        throw error;
      }

      await this.client.getApi<GitHubLabelResponse>(labelPath);
    }
  }

  public async ensureRepository(options: {
    owner: string;
    repo: string;
    description?: string;
  }): Promise<GitHubAdminRepository> {
    try {
      return await this.getRepository(options.owner, options.repo);
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 404) {
        throw error;
      }
    }

    const ownerType = await this.getOwnerType(options.owner);
    if (ownerType === "Organization") {
      await this.client.postApi<GitHubRepositoryResponse>(
        `/orgs/${encodeURIComponent(options.owner)}/repos`,
        {
          name: options.repo,
          description: options.description?.trim() || undefined,
          has_issues: true,
        },
      );
    } else if (ownerType === "User") {
      await this.client.postApi<GitHubRepositoryResponse>("/user/repos", {
        name: options.repo,
        description: options.description?.trim() || undefined,
        has_issues: true,
      });
    } else {
      throw new Error(`Unsupported GitHub owner type for ${options.owner}.`);
    }

    const repository = await this.getRepository(options.owner, options.repo);
    if (repository.owner !== options.owner) {
      throw new Error(
        `GitHub created repository ${repository.owner}/${repository.repo} instead of requested owner ${options.owner}.`,
      );
    }

    return repository;
  }

  public async getRepository(owner: string, repo: string): Promise<GitHubAdminRepository> {
    const response = await this.client.getApi<GitHubRepositoryResponse>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    );
    const repositoryOwner = this.normalizeNonEmptyString(response.owner?.login);
    const repositoryName = this.normalizeNonEmptyString(response.name);
    const repositoryUrl = this.normalizeNonEmptyString(response.html_url);
    if (!repositoryOwner || !repositoryName || !repositoryUrl) {
      throw new Error(
        `GitHub repository metadata for ${owner}/${repo} was missing owner, name, or html_url.`,
      );
    }

    return {
      id: this.normalizeInteger(response.id),
      owner: repositoryOwner,
      repo: repositoryName,
      url: repositoryUrl,
      defaultBranch: this.normalizeNonEmptyString(response.default_branch),
      description: this.normalizeNullableString(response.description),
    };
  }

  private async getOwnerType(owner: string): Promise<"Organization" | "User"> {
    const response = await this.client.getApi<GitHubOwnerResponse>(`/users/${encodeURIComponent(owner)}`);
    const ownerType = this.normalizeNonEmptyString(response.type);
    const ownerLogin = this.normalizeNonEmptyString(response.login);
    if (!ownerType || !ownerLogin) {
      throw new Error(`GitHub owner metadata for ${owner} was incomplete.`);
    }

    if (ownerType !== "Organization" && ownerType !== "User") {
      throw new Error(`Unsupported GitHub owner type for ${owner}: ${ownerType}`);
    }

    if (ownerType === "User" && ownerLogin !== this.config.owner) {
      throw new Error(
        `GitHub owner ${ownerLogin} is a user account, but the configured tracker owner is ${this.config.owner}.`,
      );
    }

    return ownerType;
  }

  private buildLabelPath(owner: string, repo: string, label: string): string {
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/labels/${encodeURIComponent(label)}`;
  }

  private normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  private normalizeNullableString(value: unknown): string | null {
    return this.normalizeNonEmptyString(value);
  }

  private normalizeInteger(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return null;
    }

    return value;
  }
}
