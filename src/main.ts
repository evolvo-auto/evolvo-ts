
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { WORK_DIR } from "./constants/workDir.js";
import { runCodingAgent } from "./agents/runCodingAgent.js";
import { runPostMergeSelfRestart } from "./runtime/selfRestart.js";
import { runIssueCommand } from "./issues/runIssueCommand.js";
import { getGitHubConfig } from "./github/githubConfig.js";
import { GitHubApiError, GitHubClient } from "./github/githubClient.js";
import { TaskIssueManager, type IssueSummary } from "./issues/taskIssueManager.js";
import { generateStartupIssueTemplates } from "./issues/startupIssueBootstrap.js";

export const DEFAULT_PROMPT = "No open issues available. Create an issue first.";
const MAX_ISSUE_CYCLES = 25;
const OUTDATED_LABELS = new Set(["outdated", "obsolete", "wontfix", "invalid", "duplicate"]);
const MIN_REPLENISH_ISSUES = 3;
const MAX_OPEN_ISSUES = 5;

function hasLabel(issue: IssueSummary, label: string): boolean {
  return issue.labels.some((currentLabel) => currentLabel.toLowerCase() === label.toLowerCase());
}

function selectIssueForWork(issues: IssueSummary[]): IssueSummary | null {
  const notCompleted = issues.filter((issue) => !hasLabel(issue, "completed"));
  if (notCompleted.length === 0) {
    return null;
  }

  const candidates = notCompleted;
  const inProgress = candidates.find((issue) => hasLabel(issue, "in progress"));

  return inProgress ?? candidates[0] ?? null;
}

function isOutdatedIssue(issue: IssueSummary): boolean {
  return issue.labels.some((label) => OUTDATED_LABELS.has(label.toLowerCase()));
}

function buildPromptFromIssue(issue: IssueSummary): string {
  const description = issue.description.trim() || "No description provided.";
  return `Issue #${issue.number}: ${issue.title}\n\n${description}`;
}

function formatIssueForLog(issue: IssueSummary): string {
  return `#${issue.number} ${issue.title}`;
}

function logCreatedIssues(issues: IssueSummary[]): void {
  const issueList = issues.map((issue) => formatIssueForLog(issue)).join(", ");
  console.log(`Created ${issues.length} self-improvement issue(s): ${issueList}.`);
}

async function bootstrapStartupIssues(issueManager: TaskIssueManager): Promise<IssueSummary[]> {
  try {
    const templates = await generateStartupIssueTemplates(WORK_DIR, { targetCount: MIN_REPLENISH_ISSUES });
    const replenishment = await issueManager.replenishSelfImprovementIssues({
      minimumIssueCount: MIN_REPLENISH_ISSUES,
      maximumOpenIssues: MAX_OPEN_ISSUES,
      templates,
    });

    return replenishment.created;
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Startup repository analysis failed: ${error.message}`);
    } else {
      console.error("Startup repository analysis failed with an unknown error.");
    }

    const replenishment = await issueManager.replenishSelfImprovementIssues({
      minimumIssueCount: MIN_REPLENISH_ISSUES,
      maximumOpenIssues: MAX_OPEN_ISSUES,
    });

    return replenishment.created;
  }
}

function logGitHubFallback(error: unknown): void {
  if (error instanceof GitHubApiError && error.status === 401) {
    console.error(
      "GitHub authentication failed. Check GITHUB_TOKEN and make sure it is a valid token for the configured repository.",
    );
    return;
  }

  if (error instanceof Error) {
    console.error(`GitHub issue sync unavailable: ${error.message}`);
    return;
  }

  console.error("GitHub issue sync unavailable due to an unknown error.");
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const issueCommandHandled = await runIssueCommand(args);
  if (issueCommandHandled) {
    return;
  }

  const { GITHUB_OWNER, GITHUB_REPO } = await import("./environment.js");
  const issueManager = new TaskIssueManager(new GitHubClient(getGitHubConfig()));

  console.log(`Hello from ${GITHUB_OWNER}/${GITHUB_REPO}!`);
  console.log(`Working directory: ${WORK_DIR}`);

  for (let cycle = 1; cycle <= MAX_ISSUE_CYCLES; cycle += 1) {
    try {
      const openIssues = await issueManager.listOpenIssues();
      const actionableIssues: IssueSummary[] = [];

      for (const issue of openIssues) {
        if (!isOutdatedIssue(issue)) {
          actionableIssues.push(issue);
          continue;
        }

        const result = await issueManager.closeIssue(issue.number);
        if (result.ok) {
          console.log(`Closed outdated issue ${formatIssueForLog(issue)}.`);
        } else {
          console.error(`Could not close outdated issue #${issue.number}: ${result.message}`);
        }
      }

      const selectedIssue = selectIssueForWork(actionableIssues);

      if (!selectedIssue) {
        const isStartupBootstrap = cycle === 1 && openIssues.length === 0;
        const createdIssues = isStartupBootstrap
          ? await bootstrapStartupIssues(issueManager)
          : (
              await issueManager.replenishSelfImprovementIssues({
                minimumIssueCount: MIN_REPLENISH_ISSUES,
                maximumOpenIssues: MAX_OPEN_ISSUES,
              })
            ).created;

        if (createdIssues.length > 0) {
          if (isStartupBootstrap) {
            console.log("No open issues found on startup. Bootstrapped issue queue from repository analysis.");
          }
          logCreatedIssues(createdIssues);
          continue;
        }

        if (cycle === 1) {
          console.log(DEFAULT_PROMPT);
        } else {
          console.log("No actionable open issues remaining and no new issues were created. Issue loop stopped.");
        }
        return;
      }

      if (!hasLabel(selectedIssue, "in progress")) {
        const result = await issueManager.markInProgress(selectedIssue.number);
        if (!result.ok) {
          console.error(`Could not mark issue #${selectedIssue.number} as in progress: ${result.message}`);
        }
      }

      const prompt = buildPromptFromIssue(selectedIssue);
      console.log(`Prompt: ${prompt}`);

      const runResult = await runCodingAgent(prompt).catch((error) => {
        console.error("Error running the coding agent:", error);
        return null;
      });

      if (runResult?.mergedPullRequest) {
        console.log("Merged pull request detected. Running post-merge restart workflow.");
        try {
          await runPostMergeSelfRestart(WORK_DIR);
          console.log("Post-merge restart workflow completed. Exiting current runtime.");
        } catch (error) {
          if (error instanceof Error) {
            console.error(error.message);
          } else {
            console.error("Post-merge restart failed with an unknown error.");
          }
        }

        return;
      }
    } catch (error) {
      logGitHubFallback(error);
      if (cycle === 1) {
        console.log(DEFAULT_PROMPT);
      }
      return;
    }
  }

  console.error(`Reached the maximum number of issue cycles (${MAX_ISSUE_CYCLES}).`);
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
