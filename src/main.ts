
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
import {
  formatChallengeMetricsReport,
  recordChallengeAttemptMetrics,
} from "./challenges/challengeMetrics.js";
import type { CodingAgentRunResult, CommandExecutionSummary } from "./agents/runCodingAgent.js";

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

function isChallengeIssue(issue: IssueSummary): boolean {
  return hasLabel(issue, "challenge");
}

function classifyChallengeFailure(
  runError: unknown,
  runResult: CodingAgentRunResult | null,
): string {
  if (runError) {
    return "execution_error";
  }

  if (!runResult) {
    return "unknown";
  }

  if (runResult.summary.failedValidationCommands.length > 0) {
    return "validation_failure";
  }

  if (runResult.summary.reviewOutcome === "amended") {
    return "review_rejection";
  }

  return "unknown";
}

async function updateChallengeMetrics(
  issue: IssueSummary,
  runError: unknown,
  runResult: CodingAgentRunResult | null,
): Promise<void> {
  if (!isChallengeIssue(issue)) {
    return;
  }

  const success = runError === null && runResult !== null && runResult.summary.reviewOutcome === "accepted";
  const failureCategory = success ? undefined : classifyChallengeFailure(runError, runResult);

  try {
    const metrics = await recordChallengeAttemptMetrics(WORK_DIR, {
      challengeIssueNumber: issue.number,
      success,
      failureCategory,
    });
    console.log(formatChallengeMetricsReport(metrics));
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Could not update challenge metrics for issue #${issue.number}: ${error.message}`);
      return;
    }

    console.error(`Could not update challenge metrics for issue #${issue.number}: unknown error.`);
  }
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) {
    return "unknown";
  }

  return `${Math.round(durationMs)}ms`;
}

function formatValidationCommand(command: CommandExecutionSummary): string {
  const exitCode = command.exitCode === null ? "unknown" : String(command.exitCode);
  return `- \`${command.command}\` (exit=${exitCode}, duration=${formatDuration(command.durationMs)})`;
}

function summarizeRetryNotes(result: CodingAgentRunResult): string {
  if (result.summary.failedValidationCommands.length === 0) {
    return "- No amendment/retry cycle was detected.";
  }

  return `- Validation had ${result.summary.failedValidationCommands.length} failing command(s), indicating amendment/retry activity.`;
}

function formatFinalResponseExcerpt(response: string): string {
  const normalized = response.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "No final assistant summary captured.";
  }

  const maxLength = 280;
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function buildIssueStartComment(issue: IssueSummary): string {
  return [
    "## Task Start",
    `- Started work on issue #${issue.number}: ${issue.title}.`,
    "- Initial assessment: inspect related files, apply a focused implementation, then validate and review.",
    "- Planned lifecycle logging: inspection, implementation decisions, validation steps/results, review outcome, PR/merge status, completion summary.",
  ].join("\n");
}

function buildIssueExecutionComment(issue: IssueSummary, result: CodingAgentRunResult): string {
  const inspectedAreas = result.summary.inspectedAreas.length > 0
    ? result.summary.inspectedAreas.map((area) => `- \`${area}\``)
    : ["- No explicit file/area inspection commands were captured."];
  const editedFiles = result.summary.editedFiles.length > 0
    ? result.summary.editedFiles.map((path) => `- \`${path}\``)
    : ["- No repository edits were captured in this run."];
  const validationLines = result.summary.validationCommands.length > 0
    ? result.summary.validationCommands.map(formatValidationCommand)
    : ["- No validation command was captured."];
  const prLines = [
    `- PR created: ${result.summary.pullRequestCreated ? "yes" : "no"}.`,
    `- PR merged into main: ${result.mergedPullRequest ? "yes" : "no"}.`,
  ];
  const externalRepositoryLines = result.summary.externalRepositories.length > 0
    ? result.summary.externalRepositories.map((url) => `- ${url}`)
    : ["- No external repository link captured."];
  const externalPullRequestLines = result.summary.externalPullRequests.length > 0
    ? result.summary.externalPullRequests.map((url) => `- ${url}`)
    : ["- No external pull request link captured."];
  const externalMergeLine = `- External pull request merged: ${result.summary.mergedExternalPullRequest ? "yes" : "no"}.`;

  return [
    "## Task Execution Log",
    "",
    "### Inspection",
    ...inspectedAreas,
    "",
    "### Implementation",
    ...editedFiles,
    "",
    "### Validation",
    ...validationLines,
    "",
    "### Review",
    `- Review outcome: ${result.summary.reviewOutcome}.`,
    summarizeRetryNotes(result),
    "",
    "### Pull Request",
    ...prLines,
    "",
    "### External Repository Evidence",
    "#### External Repository",
    ...externalRepositoryLines,
    "#### External Pull Request",
    ...externalPullRequestLines,
    externalMergeLine,
    "",
    "### Completion Summary",
    `- Issue #${issue.number} execution cycle finished with outcome: ${result.summary.reviewOutcome}.`,
    `- Agent final summary: ${formatFinalResponseExcerpt(result.summary.finalResponse)}`,
  ].join("\n");
}

function buildIssueFailureComment(issue: IssueSummary, error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown runtime error.";
  return [
    "## Task Execution Problem",
    `- Issue #${issue.number} hit an execution error: ${message}`,
    "- Action: run interrupted; follow-up retry/amendment is required.",
  ].join("\n");
}

function buildMergeOutcomeComment(issue: IssueSummary): string {
  return [
    "## Merge Outcome",
    `- Pull request for issue #${issue.number} was merged into main.`,
    "- Runtime will exit so the host can perform post-merge restart orchestration.",
  ].join("\n");
}

async function addIssueLifecycleComment(
  issueManager: TaskIssueManager,
  issueNumber: number,
  comment: string,
): Promise<void> {
  try {
    const result = await issueManager.addProgressComment(issueNumber, comment);
    if (!result.ok) {
      console.error(`Could not add lifecycle comment to issue #${issueNumber}: ${result.message}`);
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Could not add lifecycle comment to issue #${issueNumber}: ${error.message}`);
      return;
    }

    console.error(`Could not add lifecycle comment to issue #${issueNumber}: unknown error.`);
  }
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

      await addIssueLifecycleComment(issueManager, selectedIssue.number, buildIssueStartComment(selectedIssue));

      const prompt = buildPromptFromIssue(selectedIssue);
      console.log(`Prompt: ${prompt}`);

      let runError: unknown = null;
      const runResult = await runCodingAgent(prompt).catch((error) => {
        runError = error;
        console.error("Error running the coding agent:", error);
        return null;
      });

      if (runError) {
        await updateChallengeMetrics(selectedIssue, runError, runResult);
        await addIssueLifecycleComment(issueManager, selectedIssue.number, buildIssueFailureComment(selectedIssue, runError));
        continue;
      }

      if (runResult) {
        await updateChallengeMetrics(selectedIssue, runError, runResult);
        await addIssueLifecycleComment(issueManager, selectedIssue.number, buildIssueExecutionComment(selectedIssue, runResult));
      }

      if (runResult?.mergedPullRequest) {
        await addIssueLifecycleComment(issueManager, selectedIssue.number, buildMergeOutcomeComment(selectedIssue));
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
