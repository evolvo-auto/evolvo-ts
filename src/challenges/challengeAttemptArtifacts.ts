import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { CodingAgentRunResult, CommandExecutionSummary } from "../agents/runCodingAgent.js";

const EVOLVO_DIRECTORY_NAME = ".evolvo";
const CHALLENGE_ATTEMPTS_DIRECTORY_NAME = "challenge-attempts";
const ARTIFACT_SCHEMA_VERSION = 1;
const MAX_FINAL_RESPONSE_EXCERPT_LENGTH = 280;

export type ChallengeAttemptArtifact = {
  schemaVersion: 1;
  challengeIssueNumber: number;
  attempt: number;
  attemptedAtMs: number;
  attemptedAtIso: string;
  outcome: "success" | "failure";
  executionSummary: {
    reviewOutcome: string | null;
    pullRequestCreated: boolean;
    mergedPullRequest: boolean;
    inspectedAreas: string[];
    editedFiles: string[];
    validationCommands: CommandExecutionSummary[];
    failedValidationCommands: CommandExecutionSummary[];
    finalResponseExcerpt: string | null;
  };
  runtimeError: {
    name: string;
    message: string;
    stackPreview: string | null;
  } | null;
};

export type PersistChallengeAttemptArtifactInput = {
  challengeIssueNumber: number;
  runResult: CodingAgentRunResult | null;
  runError: unknown;
  nowMs?: number;
};

export type PersistChallengeAttemptArtifactResult = {
  artifact: ChallengeAttemptArtifact;
  relativePath: string;
  absolutePath: string;
};

function toFiniteNonNegativeInteger(value: unknown): number {
  const numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return 0;
  }

  return Math.floor(numericValue);
}

function formatAttemptFileName(attempt: number): string {
  return `${String(attempt).padStart(4, "0")}.json`;
}

function normalizeCommand(command: CommandExecutionSummary): CommandExecutionSummary {
  const commandName = typeof command.commandName === "string" && command.commandName.trim().length > 0
    ? command.commandName
    : String(command.command).trim().split(/\s+/, 1)[0] || "unknown";
  return {
    command: String(command.command),
    commandName,
    exitCode: typeof command.exitCode === "number" ? Math.floor(command.exitCode) : null,
    durationMs: typeof command.durationMs === "number" && Number.isFinite(command.durationMs)
      ? Math.max(0, command.durationMs)
      : null,
  };
}

function summarizeRuntimeError(runError: unknown): ChallengeAttemptArtifact["runtimeError"] {
  if (runError === null || runError === undefined) {
    return null;
  }

  if (runError instanceof Error) {
    const stackPreview = typeof runError.stack === "string" && runError.stack.trim().length > 0
      ? runError.stack.split("\n").slice(0, 3).join("\n")
      : null;
    return {
      name: runError.name || "Error",
      message: runError.message || "Unknown error.",
      stackPreview,
    };
  }

  return {
    name: "NonErrorThrownValue",
    message: String(runError),
    stackPreview: null,
  };
}

function summarizeFinalResponse(response: string): string | null {
  const normalized = response.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }

  if (normalized.length <= MAX_FINAL_RESPONSE_EXCERPT_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_FINAL_RESPONSE_EXCERPT_LENGTH - 3)}...`;
}

function buildExecutionSummary(runResult: CodingAgentRunResult | null): ChallengeAttemptArtifact["executionSummary"] {
  if (!runResult) {
    return {
      reviewOutcome: null,
      pullRequestCreated: false,
      mergedPullRequest: false,
      inspectedAreas: [],
      editedFiles: [],
      validationCommands: [],
      failedValidationCommands: [],
      finalResponseExcerpt: null,
    };
  }

  return {
    reviewOutcome: runResult.summary.reviewOutcome,
    pullRequestCreated: runResult.summary.pullRequestCreated,
    mergedPullRequest: runResult.mergedPullRequest,
    inspectedAreas: [...runResult.summary.inspectedAreas],
    editedFiles: [...runResult.summary.editedFiles],
    validationCommands: runResult.summary.validationCommands.map(normalizeCommand),
    failedValidationCommands: runResult.summary.failedValidationCommands.map(normalizeCommand),
    finalResponseExcerpt: summarizeFinalResponse(runResult.summary.finalResponse),
  };
}

function getChallengeAttemptDirectory(workDir: string, challengeIssueNumber: number): string {
  return join(workDir, EVOLVO_DIRECTORY_NAME, CHALLENGE_ATTEMPTS_DIRECTORY_NAME, String(challengeIssueNumber));
}

function buildChallengeAttemptArtifact(options: {
  challengeIssueNumber: number;
  attempt: number;
  nowMs: number;
  runResult: CodingAgentRunResult | null;
  runError: unknown;
}): ChallengeAttemptArtifact {
  const success = options.runError === null &&
    options.runResult !== null &&
    options.runResult.summary.reviewOutcome === "accepted";

  return {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    challengeIssueNumber: options.challengeIssueNumber,
    attempt: options.attempt,
    attemptedAtMs: options.nowMs,
    attemptedAtIso: new Date(options.nowMs).toISOString(),
    outcome: success ? "success" : "failure",
    executionSummary: buildExecutionSummary(options.runResult),
    runtimeError: summarizeRuntimeError(options.runError),
  };
}

async function getNextAttemptNumber(attemptDirectoryPath: string): Promise<number> {
  const entries = await fs.readdir(attemptDirectoryPath, { withFileTypes: true });
  const attempts = entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const match = entry.name.match(/^(\d+)\.json$/);
      if (!match?.[1]) {
        return 0;
      }

      return toFiniteNonNegativeInteger(match[1]);
    })
    .filter((value) => value > 0);

  if (attempts.length === 0) {
    return 1;
  }

  return Math.max(...attempts) + 1;
}

export async function persistChallengeAttemptArtifact(
  workDir: string,
  input: PersistChallengeAttemptArtifactInput,
): Promise<PersistChallengeAttemptArtifactResult> {
  const challengeIssueNumber = Math.max(1, toFiniteNonNegativeInteger(input.challengeIssueNumber));
  const nowMs = toFiniteNonNegativeInteger(input.nowMs ?? Date.now());
  const attemptDirectoryPath = getChallengeAttemptDirectory(workDir, challengeIssueNumber);
  await fs.mkdir(attemptDirectoryPath, { recursive: true });
  let attempt = await getNextAttemptNumber(attemptDirectoryPath);

  while (true) {
    const artifactFileName = formatAttemptFileName(attempt);
    const relativePath = `${EVOLVO_DIRECTORY_NAME}/${CHALLENGE_ATTEMPTS_DIRECTORY_NAME}/${challengeIssueNumber}/${artifactFileName}`;
    const absolutePath = join(attemptDirectoryPath, artifactFileName);
    const artifact = buildChallengeAttemptArtifact({
      challengeIssueNumber,
      attempt,
      nowMs,
      runResult: input.runResult,
      runError: input.runError,
    });

    try {
      await fs.writeFile(absolutePath, `${JSON.stringify(artifact, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      return { artifact, relativePath, absolutePath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      attempt += 1;
    }
  }
}
