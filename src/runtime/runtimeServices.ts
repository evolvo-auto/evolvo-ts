import { GitHubAdminClient } from "../github/githubAdminClient.js";
import { GitHubClient } from "../github/githubClient.js";
import { getGitHubConfig, type GitHubConfig } from "../github/githubConfig.js";
import { GitHubProjectsV2Client } from "../github/githubProjectsV2.js";
import { GitHubPullRequestClient } from "../github/githubPullRequests.js";
import { TaskIssueManager } from "../issues/taskIssueManager.js";
import { buildDefaultProjectContext, type DefaultProjectContext } from "../projects/projectRegistry.js";
import { ProjectRepositoryIssueInspector } from "../projects/projectRepositoryIssues.js";

export type RuntimeServices = {
  githubConfig: GitHubConfig;
  githubClient: GitHubClient;
  issueManager: TaskIssueManager;
  adminClient: GitHubAdminClient;
  projectsClient: GitHubProjectsV2Client;
  pullRequestClient: GitHubPullRequestClient;
  projectRepositoryIssueInspector: ProjectRepositoryIssueInspector;
  defaultProjectContext: DefaultProjectContext;
};

export function createRuntimeServices(options: {
  githubOwner: string;
  githubRepo: string;
  workDir: string;
}): RuntimeServices {
  const githubConfig = getGitHubConfig();
  const githubClient = new GitHubClient(githubConfig);

  return {
    githubConfig,
    githubClient,
    issueManager: new TaskIssueManager(githubClient),
    adminClient: new GitHubAdminClient(githubClient, githubConfig),
    projectsClient: new GitHubProjectsV2Client(githubClient),
    pullRequestClient: new GitHubPullRequestClient(githubClient),
    projectRepositoryIssueInspector: new ProjectRepositoryIssueInspector(githubClient),
    defaultProjectContext: buildDefaultProjectContext({
      owner: options.githubOwner,
      repo: options.githubRepo,
      workDir: options.workDir,
    }),
  };
}
