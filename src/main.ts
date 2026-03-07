
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { WORK_DIR } from "./constants/workDir.js";
import { runCodingAgent } from "./agents/runCodingAgent.js";
import { runIssueCommand } from "./issues/runIssueCommand.js";
import { getGitHubConfig } from "./github/githubConfig.js";
import { GitHubClient } from "./github/githubClient.js";
import { TaskIssueManager, type IssueSummary } from "./issues/taskIssueManager.js";

export const DEFAULT_PROMPT = "No open issues available. Create an issue first.";

function hasLabel(issue: IssueSummary, label: string): boolean {
  return issue.labels.some((currentLabel) => currentLabel.toLowerCase() === label.toLowerCase());
}

function selectIssueForWork(issues: IssueSummary[]): IssueSummary | null {
  if (issues.length === 0) {
    return null;
  }

  const notCompleted = issues.filter((issue) => !hasLabel(issue, "completed"));
  const candidates = notCompleted.length > 0 ? notCompleted : issues;
  const inProgress = candidates.find((issue) => hasLabel(issue, "in progress"));

  return inProgress ?? candidates[0] ?? null;
}

function buildPromptFromIssue(issue: IssueSummary): string {
  const description = issue.description.trim() || "No description provided.";
  return `Issue #${issue.number}: ${issue.title}\n\n${description}`;
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const issueCommandHandled = await runIssueCommand(args);
  if (issueCommandHandled) {
    return;
  }

  const { GITHUB_OWNER, GITHUB_REPO } = await import("./environment.js");
  const issueManager = new TaskIssueManager(new GitHubClient(getGitHubConfig()));
  const openIssues = await issueManager.listOpenIssues();
  const selectedIssue = selectIssueForWork(openIssues);

  if (!selectedIssue) {
    console.log(`Hello from ${GITHUB_OWNER}/${GITHUB_REPO}!`);
    console.log(`Working directory: ${WORK_DIR}`);
    console.log(DEFAULT_PROMPT);
    return;
  }

  if (!hasLabel(selectedIssue, "in progress")) {
    const result = await issueManager.markInProgress(selectedIssue.number);
    if (!result.ok) {
      console.error(`Could not mark issue #${selectedIssue.number} as in progress: ${result.message}`);
    }
  }

  const prompt = buildPromptFromIssue(selectedIssue);

  console.log(`Hello from ${GITHUB_OWNER}/${GITHUB_REPO}!`);
  console.log(`Working directory: ${WORK_DIR}`);
  console.log(`Prompt: ${prompt}`);

  await runCodingAgent(prompt).catch((error) => {
    console.error("Error running the coding agent:", error);
  });
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  main().catch((error) => {
    console.error("Error in main execution:", error);
  }).finally(() => {
    console.log("Execution finished.");
  });
}
