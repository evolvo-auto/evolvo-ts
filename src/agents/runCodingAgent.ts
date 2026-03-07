import { Codex, Thread, type ThreadItem } from "@openai/codex-sdk";
import {
  CODING_AGENT_THREAD_OPTIONS,
  buildCodingPrompt,
} from "./codingAgent.js";

const codex = new Codex();
let activeThread: Thread | null = null;
const GITHUB_REPOSITORY_URL_PATTERN = /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\.git)?(?:\/)?/gi;
const GITHUB_PULL_REQUEST_URL_PATTERN = /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/\d+/gi;
const INSPECTION_COMMAND_NAMES = new Set(["rg", "grep", "cat", "sed", "ls", "find", "fd", "tree"]);
const INSPECTION_GIT_SUBCOMMAND_NAMES = new Set(["status", "diff", "show"]);
const VALIDATION_COMMAND_NAMES = new Set(["vitest", "jest", "tsc", "pytest"]);
const PACKAGE_MANAGER_COMMAND_NAMES = new Set(["pnpm", "npm", "yarn", "bun"]);
const VALIDATION_SCRIPT_NAMES = new Set(["validate", "test", "typecheck", "lint", "build"]);

export type CodingAgentRunResult = {
  mergedPullRequest: boolean;
  summary: CodingAgentRunSummary;
};

type CommandExecutionLogDetails = {
  startedAtMs?: number;
};

export type CommandExecutionSummary = {
  command: string;
  commandName: string;
  exitCode: number | null;
  durationMs: number | null;
};

export type CodingAgentRunSummary = {
  inspectedAreas: string[];
  editedFiles: string[];
  validationCommands: CommandExecutionSummary[];
  failedValidationCommands: CommandExecutionSummary[];
  reviewOutcome: "accepted" | "amended";
  pullRequestCreated: boolean;
  externalRepositories: string[];
  externalPullRequests: string[];
  mergedExternalPullRequest: boolean;
  finalResponse: string;
};

type ParsedCommand = {
  commandName: string;
  args: string[];
};

type CommandContract = {
  parsedCommand: ParsedCommand;
  isPullRequestCreate: boolean;
  isPullRequestMerge: boolean;
  isInspection: boolean;
  isValidation: boolean;
};

type RuntimeFacts = {
  fileChangeSeen: boolean;
  mergedPullRequest: boolean;
  mergedExternalPullRequest: boolean;
  pullRequestCreated: boolean;
};

function getThread(): Thread {
  if (!activeThread) {
    activeThread = codex.startThread(CODING_AGENT_THREAD_OPTIONS);
  }

  return activeThread;
}

function isFileEditRequest(prompt: string): boolean {
  return /\b(create|add|write|update|edit|modify|delete|remove)\b/i.test(prompt) &&
    /\b(file|files|src\/|\.ts|\.tsx|\.js|\.jsx|\.json|\.md)\b/i.test(prompt);
}

function formatFileChanges(item: Extract<ThreadItem, { type: "file_change" }>): string {
  return item.changes.map((change) => `${change.kind} ${change.path}`).join(", ");
}

function getCommandName(command: string): string {
  const [commandName] = splitCommandTokens(command);
  return commandName || "unknown";
}

function splitCommandTokens(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

function stripLeadingEnvironmentAssignments(tokens: string[]): string[] {
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

  return tokens.slice(cursor);
}

function parseCommand(command: string): ParsedCommand {
  const shellTokens = stripLeadingEnvironmentAssignments(splitCommandTokens(command));
  const [commandName = "unknown", ...args] = shellTokens;
  return {
    commandName: commandName.toLowerCase(),
    args,
  };
}

function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) {
    return "unknown";
  }

  return `${Math.round(durationMs)}ms`;
}

function getCommandDurationMs(itemId: string, commandStartTimes: Map<string, number>): number | null {
  const startedAtMs = commandStartTimes.get(itemId);
  if (startedAtMs === undefined) {
    return null;
  }

  const durationMs = Date.now() - startedAtMs;
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return null;
  }

  return durationMs;
}

function extractGhRepoFlagUrls(args: string[]): string[] {
  const repositories = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--repo") {
      continue;
    }

    const rawValue = args[index + 1];
    if (!rawValue) {
      continue;
    }

    const value = rawValue.replace(/^["']|["']$/g, "").trim();
    if (!value) {
      continue;
    }

    if (value.startsWith("https://github.com/")) {
      repositories.add(normalizeRepositoryUrl(value));
      continue;
    }

    const [owner, repo] = value.replace(/\/+$/, "").split("/", 2);
    if (owner && repo) {
      repositories.add(normalizeRepositoryUrl(`https://github.com/${owner}/${repo}`));
    }
  }

  return [...repositories];
}

function isValidationPackageManagerCommand(commandName: string, args: string[]): boolean {
  if (!PACKAGE_MANAGER_COMMAND_NAMES.has(commandName) || args.length === 0) {
    return false;
  }

  const filteredArgs = args.filter((arg) => !arg.startsWith("-"));
  if (filteredArgs.length === 0) {
    return false;
  }

  if (commandName === "npm") {
    const [subcommand, scriptName] = filteredArgs;
    if (subcommand === "run" && scriptName) {
      return VALIDATION_SCRIPT_NAMES.has(scriptName);
    }

    return VALIDATION_SCRIPT_NAMES.has(subcommand);
  }

  if (commandName === "yarn") {
    const [subcommand, scriptName] = filteredArgs;
    if (subcommand === "run" && scriptName) {
      return VALIDATION_SCRIPT_NAMES.has(scriptName);
    }

    return VALIDATION_SCRIPT_NAMES.has(subcommand);
  }

  if (commandName === "bun") {
    const [subcommand, scriptName] = filteredArgs;
    if (subcommand === "run" && scriptName) {
      return VALIDATION_SCRIPT_NAMES.has(scriptName);
    }

    return VALIDATION_SCRIPT_NAMES.has(subcommand);
  }

  const [subcommand] = filteredArgs;
  return VALIDATION_SCRIPT_NAMES.has(subcommand);
}

function isValidationCommand(parsedCommand: ParsedCommand): boolean {
  const { commandName, args } = parsedCommand;
  if (VALIDATION_COMMAND_NAMES.has(commandName)) {
    return true;
  }

  if (commandName === "go" && args[0] === "test") {
    return true;
  }

  if (commandName === "cargo" && args[0] === "test") {
    return true;
  }

  return isValidationPackageManagerCommand(commandName, args);
}

function isInspectionCommand(parsedCommand: ParsedCommand): boolean {
  if (INSPECTION_COMMAND_NAMES.has(parsedCommand.commandName)) {
    return true;
  }

  return parsedCommand.commandName === "git" && INSPECTION_GIT_SUBCOMMAND_NAMES.has(parsedCommand.args[0] ?? "");
}

function getCommandContract(command: string): CommandContract {
  const parsedCommand = parseCommand(command);
  const ghArgs = parsedCommand.commandName === "gh" ? parsedCommand.args.filter((arg) => !arg.startsWith("-")) : [];
  const prIndex = ghArgs.indexOf("pr");
  const isGhPrCommand = prIndex >= 0;
  const ghPrAction = isGhPrCommand ? ghArgs[prIndex + 1] : "";
  const isPullRequestCreate = isGhPrCommand && ghPrAction === "create";
  const isPullRequestMerge = isGhPrCommand && ghPrAction === "merge";

  return {
    parsedCommand,
    isPullRequestCreate,
    isPullRequestMerge,
    isInspection: isInspectionCommand(parsedCommand),
    isValidation: isValidationCommand(parsedCommand),
  };
}

function extractCommandTargets(command: string): string[] {
  const targets = new Set<string>();
  for (const rawToken of command.split(/\s+/)) {
    const token = rawToken.trim();
    if (!token || token.startsWith("-")) {
      continue;
    }

    if (
      token.startsWith("src/") ||
      token.startsWith("./") ||
      token.startsWith("../") ||
      /\.(ts|tsx|js|jsx|json|md|yml|yaml|sh)$/i.test(token)
    ) {
      targets.add(token.replace(/[",':;]+$/g, ""));
    }
  }

  return [...targets];
}

function summarizeReviewOutcome(validationCommands: CommandExecutionSummary[]): "accepted" | "amended" {
  return validationCommands.some((command) => command.exitCode !== 0) ? "amended" : "accepted";
}

function normalizeRepositoryUrl(url: string): string {
  const cleanUrl = url.trim().replace(/\/+$/, "");
  return cleanUrl.endsWith(".git") ? cleanUrl.slice(0, -4) : cleanUrl;
}

function extractGitHubRepositoryUrls(text: string): string[] {
  const urls = new Set<string>();
  const matches = text.matchAll(GITHUB_REPOSITORY_URL_PATTERN);

  for (const match of matches) {
    urls.add(normalizeRepositoryUrl(match[0]));
  }

  return [...urls];
}

function extractGitHubPullRequestUrls(text: string): string[] {
  const urls = new Set<string>();
  const matches = text.matchAll(GITHUB_PULL_REQUEST_URL_PATTERN);

  for (const match of matches) {
    urls.add(match[0].replace(/\/+$/, ""));
  }

  return [...urls];
}

function getConfiguredRepositoryUrl(): string | null {
  const owner = process.env.GITHUB_OWNER?.trim();
  const repo = process.env.GITHUB_REPO?.trim();
  if (!owner || !repo) {
    return null;
  }

  return `https://github.com/${owner}/${repo}`;
}

function isExternalRepositoryUrl(url: string, configuredRepositoryUrl: string | null): boolean {
  if (!configuredRepositoryUrl) {
    return true;
  }

  return normalizeRepositoryUrl(url).toLowerCase() !== normalizeRepositoryUrl(configuredRepositoryUrl).toLowerCase();
}

function logCompletedItem(item: ThreadItem, details?: CommandExecutionLogDetails): void {
  if (item.type === "file_change") {
    console.log(`[file_change] ${formatFileChanges(item)}\n`);
    return;
  }

  if (item.type === "command_execution") {
    const output = item.aggregated_output.trim();
    const commandName = getCommandName(item.command);
    const exitCode = item.exit_code ?? "unknown";
    const duration = details?.startedAtMs !== undefined
      ? formatDuration(Date.now() - details.startedAtMs)
      : "unknown";

    console.log(
      `[command completed] command="${item.command}" name=${commandName} exit=${exitCode} duration=${duration}`,
    );

    if (output) {
      console.log(`${output}\n`);
    } else {
      console.log("");
    }

    return;
  }

  if (item.type === "agent_message") {
    console.log(`[assistant]\n${item.text}\n`);
  }
}

function logStartedItem(item: ThreadItem): void {
  if (item.type === "command_execution") {
    console.log(`[command] ${item.command}`);
    return;
  }

  if (item.type === "mcp_tool_call") {
    console.log(`[tool] mcp - ${item.server}.${item.tool}`);
    return;
  }

  if (item.type === "web_search") {
    console.log(`[tool] web_search - query: ${item.query}`);
  }
}

export async function runCodingAgent(prompt: string): Promise<CodingAgentRunResult> {
  console.log("=== Run starting ===");
  console.log(`[user] ${prompt}\n`);

  const thread = getThread();
  const { events } = await thread.runStreamed(buildCodingPrompt(prompt));

  const startedItems = new Set<string>();
  const completedItems = new Set<string>();
  const commandStartTimes = new Map<string, number>();
  const inspectedAreas = new Set<string>();
  const editedFiles = new Set<string>();
  const externalRepositories = new Set<string>();
  const externalPullRequests = new Set<string>();
  const validationCommands: CommandExecutionSummary[] = [];
  const failedValidationCommands: CommandExecutionSummary[] = [];
  const facts: RuntimeFacts = {
    fileChangeSeen: false,
    mergedPullRequest: false,
    mergedExternalPullRequest: false,
    pullRequestCreated: false,
  };
  let finalResponse = "";
  const configuredRepositoryUrl = getConfiguredRepositoryUrl();

  function captureExternalReferences(text: string): void {
    for (const repositoryUrl of extractGitHubRepositoryUrls(text)) {
      if (isExternalRepositoryUrl(repositoryUrl, configuredRepositoryUrl)) {
        externalRepositories.add(repositoryUrl);
      }
    }

    for (const pullRequestUrl of extractGitHubPullRequestUrls(text)) {
      const pullRequestRepositoryUrl = pullRequestUrl.replace(/\/pull\/\d+$/, "");
      if (isExternalRepositoryUrl(pullRequestRepositoryUrl, configuredRepositoryUrl)) {
        externalPullRequests.add(pullRequestUrl);
        externalRepositories.add(pullRequestRepositoryUrl);
      }
    }
  }

  for await (const event of events) {
    if (event.type === "item.started") {
      if (startedItems.has(event.item.id)) {
        continue;
      }

      startedItems.add(event.item.id);
      if (event.item.type === "command_execution") {
        commandStartTimes.set(event.item.id, Date.now());
      }
      logStartedItem(event.item);
      continue;
    }

    if (event.type === "item.updated") {
      if (event.item.type === "agent_message") {
        finalResponse = event.item.text;
        captureExternalReferences(event.item.text);
      }
      continue;
    }

    if (event.type === "item.completed") {
      if (completedItems.has(event.item.id)) {
        continue;
      }

      completedItems.add(event.item.id);

      if (event.item.type === "file_change" && event.item.status === "completed") {
        facts.fileChangeSeen = true;
      }

      if (event.item.type === "agent_message") {
        finalResponse = event.item.text;
        captureExternalReferences(event.item.text);
      }

      if (event.item.type === "command_execution") {
        const contract = getCommandContract(event.item.command);
        captureExternalReferences(event.item.command);
        captureExternalReferences(event.item.aggregated_output);

        for (const repositoryUrl of extractGhRepoFlagUrls(contract.parsedCommand.args)) {
          if (isExternalRepositoryUrl(repositoryUrl, configuredRepositoryUrl)) {
            externalRepositories.add(repositoryUrl);
          }
        }

        if (event.item.exit_code === 0 && contract.isPullRequestCreate) {
          facts.pullRequestCreated = true;
        }

        if (event.item.exit_code === 0 && contract.isPullRequestMerge) {
          facts.mergedPullRequest = true;
          const mergeText = `${event.item.command}\n${event.item.aggregated_output}`;
          const mergedPullRequestUrls = extractGitHubPullRequestUrls(mergeText);
          const mergedExternal = mergedPullRequestUrls.some((pullRequestUrl) => {
            const pullRequestRepositoryUrl = pullRequestUrl.replace(/\/pull\/\d+$/, "");
            return isExternalRepositoryUrl(pullRequestRepositoryUrl, configuredRepositoryUrl);
          });

          const mergedRepositoryUrls = [
            ...extractGhRepoFlagUrls(contract.parsedCommand.args),
            ...extractGitHubRepositoryUrls(mergeText),
          ];
          const mergedExternalRepository = mergedRepositoryUrls.some((repositoryUrl) =>
            isExternalRepositoryUrl(repositoryUrl, configuredRepositoryUrl)
          );

          if (mergedExternal || mergedExternalRepository) {
            facts.mergedExternalPullRequest = true;
          }
        }

        if (contract.isInspection) {
          for (const target of extractCommandTargets(event.item.command)) {
            inspectedAreas.add(target);
          }
        }

        if (contract.isValidation) {
          const commandSummary: CommandExecutionSummary = {
            command: event.item.command,
            commandName: getCommandName(event.item.command),
            exitCode: event.item.exit_code ?? null,
            durationMs: getCommandDurationMs(event.item.id, commandStartTimes),
          };
          validationCommands.push(commandSummary);
          if (commandSummary.exitCode !== 0) {
            failedValidationCommands.push(commandSummary);
          }
        }
      }

      const details = event.item.type === "command_execution"
        ? { startedAtMs: commandStartTimes.get(event.item.id) }
        : undefined;
      if (event.item.type === "command_execution") {
        commandStartTimes.delete(event.item.id);
      }

      if (event.item.type === "file_change" && event.item.status === "completed") {
        for (const change of event.item.changes) {
          editedFiles.add(change.path);
        }
      }

      logCompletedItem(event.item, details);
      continue;
    }

    if (event.type === "turn.failed") {
      throw new Error(event.error.message);
    }

    if (event.type === "error") {
      throw new Error(event.message);
    }
  }

  console.log("=== Run complete ===\n");
  console.log("Final answer:\n");
  console.log(finalResponse);

  if (facts.fileChangeSeen) {
    console.log("\n[file_change] One or more repository edits were executed.");
    return {
      mergedPullRequest: facts.mergedPullRequest,
      summary: {
        inspectedAreas: [...inspectedAreas],
        editedFiles: [...editedFiles],
        validationCommands,
        failedValidationCommands,
        reviewOutcome: summarizeReviewOutcome(validationCommands),
        pullRequestCreated: facts.pullRequestCreated,
        externalRepositories: [...externalRepositories],
        externalPullRequests: [...externalPullRequests],
        mergedExternalPullRequest: facts.mergedExternalPullRequest,
        finalResponse,
      },
    };
  }

  console.log("\n[file_change] No repository edits were detected.");

  if (isFileEditRequest(prompt)) {
    throw new Error("The Codex run did not make repository edits for a file-edit request.");
  }

  return {
    mergedPullRequest: facts.mergedPullRequest,
    summary: {
      inspectedAreas: [...inspectedAreas],
      editedFiles: [...editedFiles],
      validationCommands,
      failedValidationCommands,
      reviewOutcome: summarizeReviewOutcome(validationCommands),
      pullRequestCreated: facts.pullRequestCreated,
      externalRepositories: [...externalRepositories],
      externalPullRequests: [...externalPullRequests],
      mergedExternalPullRequest: facts.mergedExternalPullRequest,
      finalResponse,
    },
  };
}
