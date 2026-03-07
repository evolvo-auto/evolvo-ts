import type { CodingAgentRunResult, CommandExecutionSummary } from "../agents/runCodingAgent.js";
import { persistChallengeAttemptArtifact } from "../challenges/challengeAttemptArtifacts.js";
import { isChallengeIssue } from "../issues/challengeIssue.js";
import type { TaskIssueManager, IssueSummary } from "../issues/taskIssueManager.js";

export type ChallengeAttemptEvidence = {
  artifactPath: string;
  attempt: number;
  outcome: "success" | "failure";
  reviewOutcome: string | null;
  runtimeErrorMessage: string | null;
};

function formatDuration(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) {
    return "unknown";
  }

  return `${Math.round(durationMs)}ms`;
}

function formatDurationMsValue(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) {
    return "unknown";
  }

  return String(Math.round(durationMs));
}

function getCommandName(command: string): string {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  let cursor = 0;

  if (tokens[cursor] === "env") {
    cursor += 1;
    while (tokens[cursor]?.startsWith("-")) {
      cursor += 1;
    }
  }

  while (tokens[cursor]?.includes("=")) {
    cursor += 1;
  }

  const commandName = tokens[cursor];
  return commandName ? commandName.toLowerCase() : "unknown";
}

function formatValidationCommand(command: CommandExecutionSummary): string {
  const commandName = typeof command.commandName === "string" && command.commandName.trim().length > 0
    ? command.commandName.trim()
    : getCommandName(command.command);
  const exitCode = command.exitCode === null ? "unknown" : String(command.exitCode);
  const duration = formatDuration(command.durationMs);
  const durationMsValue = formatDurationMsValue(command.durationMs);
  const outcome = command.exitCode === null ? "unknown" : command.exitCode === 0 ? "passed" : "failed";
  return `- \`${command.command}\` (name=${commandName}, command_name=${commandName}, status=${exitCode}, elapsed=${duration}, exit_code=${exitCode}, duration_ms=${durationMsValue}, outcome=${outcome})`;
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

export function buildIssueStartComment(issue: IssueSummary): string {
  return [
    "## Task Start",
    `- Started work on issue #${issue.number}: ${issue.title}.`,
    "- Initial assessment: inspect related files, apply a focused implementation, then validate and review.",
    "- Planned lifecycle logging: inspection, implementation decisions, validation steps/results, review outcome, PR/merge status, completion summary.",
  ].join("\n");
}

function buildChallengeEvidenceCommentLines(evidence: ChallengeAttemptEvidence | null): string[] {
  if (!evidence) {
    return [
      "",
      "### Challenge Attempt Artifact",
      "- Artifact path: (capture failed)",
      "- Attempt: unknown",
    ];
  }

  return [
    "",
    "### Challenge Attempt Artifact",
    `- Artifact path: \`${evidence.artifactPath}\``,
    `- Attempt: ${evidence.attempt}`,
    `- Outcome: ${evidence.outcome}`,
    `- Review outcome: ${evidence.reviewOutcome ?? "unknown"}`,
    `- Runtime error message: ${evidence.runtimeErrorMessage ?? "none"}`,
  ];
}

export async function persistChallengeAttemptEvidence(
  workDir: string,
  issue: IssueSummary,
  runError: unknown,
  runResult: CodingAgentRunResult | null,
): Promise<ChallengeAttemptEvidence | null> {
  if (!isChallengeIssue(issue)) {
    return null;
  }

  try {
    const persisted = await persistChallengeAttemptArtifact(workDir, {
      challengeIssueNumber: issue.number,
      runResult,
      runError,
    });
    const reviewOutcome = persisted.artifact.executionSummary &&
      typeof persisted.artifact.executionSummary.reviewOutcome === "string"
      ? persisted.artifact.executionSummary.reviewOutcome
      : null;
    const outcome = persisted.artifact.outcome === "success" ? "success" : "failure";
    const attempt = Number.isFinite(persisted.artifact.attempt) ? Math.max(1, Math.floor(persisted.artifact.attempt)) : 1;
    return {
      artifactPath: persisted.relativePath,
      attempt,
      outcome,
      reviewOutcome,
      runtimeErrorMessage: persisted.artifact.runtimeError?.message ?? null,
    };
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Could not persist challenge attempt artifact for issue #${issue.number}: ${error.message}`);
      return null;
    }

    console.error(`Could not persist challenge attempt artifact for issue #${issue.number}: unknown error.`);
    return null;
  }
}

export function buildIssueExecutionComment(
  issue: IssueSummary,
  result: CodingAgentRunResult,
  challengeEvidence: ChallengeAttemptEvidence | null,
): string {
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
  const challengeEvidenceLines = isChallengeIssue(issue) ? buildChallengeEvidenceCommentLines(challengeEvidence) : [];

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
    ...challengeEvidenceLines,
    "",
    "### Completion Summary",
    `- Issue #${issue.number} execution cycle finished with outcome: ${result.summary.reviewOutcome}.`,
    `- Agent final summary: ${formatFinalResponseExcerpt(result.summary.finalResponse)}`,
  ].join("\n");
}

export function buildIssueFailureComment(
  issue: IssueSummary,
  error: unknown,
  challengeEvidence: ChallengeAttemptEvidence | null,
): string {
  const message = error instanceof Error ? error.message : "Unknown runtime error.";
  const challengeEvidenceLines = isChallengeIssue(issue) ? buildChallengeEvidenceCommentLines(challengeEvidence) : [];
  return [
    "## Task Execution Problem",
    `- Issue #${issue.number} hit an execution error: ${message}`,
    "- Action: run interrupted; follow-up retry/amendment is required.",
    ...challengeEvidenceLines,
  ].join("\n");
}

export function buildMergeOutcomeComment(issue: IssueSummary): string {
  return [
    "## Merge Outcome",
    `- Pull request for issue #${issue.number} was merged into main.`,
    "- Runtime will exit so the host can perform post-merge restart orchestration.",
  ].join("\n");
}

export async function addIssueLifecycleComment(
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
