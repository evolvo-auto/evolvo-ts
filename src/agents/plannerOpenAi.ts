import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const OPENAI_RESPONSES_API_URL = "https://api.openai.com/v1/responses";
export const PLANNER_OPENAI_MODEL = "gpt-5.3-codex";
const PLANNER_MAX_TOOL_ROUNDS = 8;
const PLANNER_REPOSITORY_LIST_LIMIT = 200;
const PLANNER_REPOSITORY_READ_LINE_LIMIT = 400;
const PLANNER_REPOSITORY_SEARCH_LIMIT = 50;
const PLANNER_IGNORED_DIRECTORY_NAMES = new Set([".git", "node_modules", "dist"]);

const PLANNER_SYSTEM_INSTRUCTIONS = [
  "You are Evolvo's repository planner.",
  "Inspect the repository with the available tools before proposing issues.",
  "Start by inspecting repository structure or searching for likely hotspots, then read the specific files you rely on.",
  "Ground every issue in current repository evidence and the open/closed issue history supplied in the user prompt.",
  "Prefer reliability, runtime safety, validation quality, planning quality, observability, and operational robustness.",
  "Keep each issue bounded, actionable, and specific to Evolvo's real codebase.",
  "Do not propose duplicate, lightly reworded, generic, or follow-up-titled issues.",
  "Return only JSON that matches the provided schema.",
].join("\n");

const PLANNER_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
        },
        required: ["title", "description"],
        additionalProperties: false,
      },
    },
  },
  required: ["issues"],
  additionalProperties: false,
} as const;

const PLANNER_REPOSITORY_TOOLS = [
  {
    type: "function",
    name: "list_repository_entries",
    description: "List files and directories under a repository path so you can orient yourself before reading code.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: ["string", "null"],
          description: "Relative repository path to inspect. Use null or '.' for the repository root.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: PLANNER_REPOSITORY_LIST_LIMIT,
          description: "Maximum number of entries to return.",
        },
      },
      required: ["path", "limit"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "read_repository_file",
    description: "Read a bounded range of lines from a repository file.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative repository file path to read.",
        },
        startLine: {
          type: "integer",
          minimum: 1,
          description: "1-based line number to start reading from.",
        },
        lineCount: {
          type: "integer",
          minimum: 1,
          maximum: PLANNER_REPOSITORY_READ_LINE_LIMIT,
          description: "Maximum number of lines to read.",
        },
      },
      required: ["path", "startLine", "lineCount"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "search_repository",
    description: "Search repository files for symbols, strings, or architectural patterns.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The ripgrep-compatible pattern or exact symbol/string to search for.",
        },
        path: {
          type: ["string", "null"],
          description: "Optional relative repository path to limit the search. Use null or '.' for the whole repository.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: PLANNER_REPOSITORY_SEARCH_LIMIT,
          description: "Maximum number of matching lines to return.",
        },
      },
      required: ["query", "path", "limit"],
      additionalProperties: false,
    },
    strict: true,
  },
] as const;

type PlannerResponseInputItem =
  | {
      role: "user";
      content: string;
    }
  | PlannerResponseOutputItem
  | {
      type: "function_call_output";
      call_id: string;
      output: string;
    };

type PlannerResponseOutputItem =
  | PlannerResponseMessageItem
  | PlannerResponseFunctionCallItem
  | PlannerResponseReasoningItem
  | PlannerResponseUnknownItem;

type PlannerResponseMessageItem = {
  type: "message";
  role?: string;
  content?: Array<
    | {
        type: "output_text";
        text?: string;
      }
    | {
        type: "refusal";
        refusal?: string;
      }
    | Record<string, unknown>
  >;
};

type PlannerResponseFunctionCallItem = {
  type: "function_call";
  call_id?: string;
  name?: string;
  arguments?: string;
};

type PlannerResponseReasoningItem = {
  type: "reasoning";
};

type PlannerResponseUnknownItem = {
  type?: string;
  [key: string]: unknown;
};

type PlannerApiResponse = {
  status?: string;
  error?: {
    message?: string;
  } | null;
  incomplete_details?: {
    reason?: string;
  } | null;
  output?: PlannerResponseOutputItem[];
};

type PlannerRepositoryToolResult = {
  ok: boolean;
  [key: string]: unknown;
};

type RunPlannerOpenAiInput = {
  apiKey: string;
  prompt: string;
  workDir: string;
};

export type RunPlannerOpenAiResult = {
  finalResponse: string;
};

export async function runPlannerOpenAi(input: RunPlannerOpenAiInput): Promise<RunPlannerOpenAiResult> {
  const conversation: PlannerResponseInputItem[] = [{ role: "user", content: input.prompt }];
  let toolCallCount = 0;

  for (let round = 0; round < PLANNER_MAX_TOOL_ROUNDS; round += 1) {
    const response = await createPlannerResponse({
      apiKey: input.apiKey,
      input: conversation,
      requireInitialToolCall: round === 0,
    });
    const output = Array.isArray(response.output) ? response.output : [];
    conversation.push(...output);

    const functionCalls = output.filter(isPlannerResponseFunctionCall);
    if (functionCalls.length === 0) {
      const finalResponse = extractPlannerFinalResponse(response);
      if (toolCallCount === 0) {
        throw new Error("Planner completed without inspecting the repository.");
      }

      return { finalResponse };
    }

    toolCallCount += functionCalls.length;
    for (const functionCall of functionCalls) {
      conversation.push({
        type: "function_call_output",
        call_id: requireNonEmptyString(functionCall.call_id, "Planner function call did not include a call_id."),
        output: JSON.stringify(
          await runPlannerRepositoryTool(
            requireNonEmptyString(functionCall.name, "Planner function call did not include a tool name."),
            parsePlannerToolArguments(functionCall.arguments),
            input.workDir,
          ),
        ),
      });
    }
  }

  throw new Error(`Planner exceeded the maximum tool-call rounds (${PLANNER_MAX_TOOL_ROUNDS}).`);
}

export async function runPlannerRepositoryTool(
  name: string,
  rawArguments: unknown,
  workDir: string,
): Promise<PlannerRepositoryToolResult> {
  try {
    switch (name) {
      case "list_repository_entries":
        return await listRepositoryEntries(rawArguments, workDir);
      case "read_repository_file":
        return await readRepositoryFile(rawArguments, workDir);
      case "search_repository":
        return await searchRepository(rawArguments, workDir);
      default:
        return {
          ok: false,
          error: `Unknown planner tool: ${name}`,
        };
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      tool: name,
    };
  }
}

async function createPlannerResponse(options: {
  apiKey: string;
  input: PlannerResponseInputItem[];
  requireInitialToolCall: boolean;
}): Promise<PlannerApiResponse> {
  const response = await fetch(OPENAI_RESPONSES_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: PLANNER_OPENAI_MODEL,
      instructions: PLANNER_SYSTEM_INSTRUCTIONS,
      input: options.input,
      tools: PLANNER_REPOSITORY_TOOLS,
      tool_choice: options.requireInitialToolCall ? "required" : "auto",
      parallel_tool_calls: false,
      reasoning: { effort: "medium" },
      text: {
        format: {
          type: "json_schema",
          name: "planner_issue_batch",
          strict: true,
          schema: PLANNER_RESPONSE_SCHEMA,
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(await buildPlannerApiErrorMessage(response));
  }

  const parsed = (await response.json()) as PlannerApiResponse;
  if (parsed.error?.message) {
    throw new Error(`Planner API request failed: ${parsed.error.message}`);
  }
  if (parsed.status === "failed") {
    throw new Error("Planner API request failed without an error message.");
  }
  if (parsed.status === "incomplete") {
    const reason = parsed.incomplete_details?.reason?.trim();
    throw new Error(
      reason ? `Planner API response was incomplete: ${reason}` : "Planner API response was incomplete.",
    );
  }

  return parsed;
}

async function buildPlannerApiErrorMessage(response: Response): Promise<string> {
  const fallbackMessage = `Planner API request failed with status ${response.status}.`;
  let rawBody = "";

  try {
    rawBody = await response.text();
  } catch {
    return fallbackMessage;
  }

  if (!rawBody.trim()) {
    return fallbackMessage;
  }

  try {
    const parsed = JSON.parse(rawBody) as {
      error?: {
        message?: string;
      };
    };
    const message = parsed.error?.message?.trim();
    if (message) {
      return `Planner API request failed (${response.status}): ${message}`;
    }
  } catch {
    // Fall back to raw text handling below.
  }

  return fallbackMessage;
}

function parsePlannerToolArguments(rawArguments: string | undefined): unknown {
  if (typeof rawArguments !== "string" || rawArguments.trim().length === 0) {
    throw new Error("Planner function call did not include arguments.");
  }

  return JSON.parse(rawArguments) as unknown;
}

function extractPlannerFinalResponse(response: PlannerApiResponse): string {
  const output = Array.isArray(response.output) ? response.output : [];
  const refusal = findPlannerRefusal(output);
  if (refusal !== null) {
    throw new Error(`Planner response was refused: ${refusal}`);
  }

  const texts: string[] = [];
  for (const item of output) {
    if (item.type !== "message" || !Array.isArray(item.content)) {
      continue;
    }

    for (const contentItem of item.content) {
      if (contentItem.type === "output_text" && typeof contentItem.text === "string" && contentItem.text.trim().length > 0) {
        texts.push(contentItem.text);
      }
    }
  }

  const finalResponse = texts.join("\n").trim();
  if (!finalResponse) {
    throw new Error("Planner API response did not include assistant output text.");
  }

  return finalResponse;
}

function findPlannerRefusal(output: PlannerResponseOutputItem[]): string | null {
  for (const item of output) {
    if (item.type !== "message" || !Array.isArray(item.content)) {
      continue;
    }

    for (const contentItem of item.content) {
      if (contentItem.type === "refusal" && typeof contentItem.refusal === "string" && contentItem.refusal.trim().length > 0) {
        return contentItem.refusal.trim();
      }
    }
  }

  return null;
}

function isPlannerResponseFunctionCall(item: PlannerResponseOutputItem): item is PlannerResponseFunctionCallItem {
  return item.type === "function_call";
}

async function listRepositoryEntries(rawArguments: unknown, workDir: string): Promise<PlannerRepositoryToolResult> {
  const args = expectObject(rawArguments, "Planner list_repository_entries arguments must be an object.");
  const path = getNullableStringArgument(args, "path");
  const limit = getPositiveIntegerArgument(args, "limit", 1, PLANNER_REPOSITORY_LIST_LIMIT);
  const absolutePath = resolveRepositoryPath(workDir, path);
  const stat = await fs.stat(absolutePath);

  if (!stat.isDirectory()) {
    throw new Error(`Repository path is not a directory: ${path ?? "."}`);
  }

  const directoryEntries = (await fs.readdir(absolutePath, { withFileTypes: true }))
    .filter((entry) => !PLANNER_IGNORED_DIRECTORY_NAMES.has(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  const limitedEntries = directoryEntries.slice(0, limit);

  return {
    ok: true,
    path: toRepositoryRelativePath(workDir, absolutePath),
    entries: limitedEntries.map((entry) => {
      const entryAbsolutePath = resolve(absolutePath, entry.name);
      return {
        path: toRepositoryRelativePath(workDir, entryAbsolutePath),
        type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
      };
    }),
    truncated: directoryEntries.length > limit,
  };
}

async function readRepositoryFile(rawArguments: unknown, workDir: string): Promise<PlannerRepositoryToolResult> {
  const args = expectObject(rawArguments, "Planner read_repository_file arguments must be an object.");
  const path = getRequiredStringArgument(args, "path");
  const startLine = getPositiveIntegerArgument(args, "startLine", 1, Number.MAX_SAFE_INTEGER);
  const lineCount = getPositiveIntegerArgument(args, "lineCount", 1, PLANNER_REPOSITORY_READ_LINE_LIMIT);
  const absolutePath = resolveRepositoryPath(workDir, path);
  const stat = await fs.stat(absolutePath);

  if (!stat.isFile()) {
    throw new Error(`Repository path is not a file: ${path}`);
  }

  const fileContent = await fs.readFile(absolutePath, "utf8");
  const lines = splitFileContentIntoLines(fileContent);
  const startIndex = Math.max(0, startLine - 1);
  const selectedLines = lines.slice(startIndex, startIndex + lineCount);

  return {
    ok: true,
    path: toRepositoryRelativePath(workDir, absolutePath),
    startLine,
    endLine: startIndex + selectedLines.length,
    totalLines: lines.length,
    truncated: startIndex + selectedLines.length < lines.length,
    content: selectedLines.map((line, index) => `${startIndex + index + 1}: ${line}`).join("\n"),
  };
}

async function searchRepository(rawArguments: unknown, workDir: string): Promise<PlannerRepositoryToolResult> {
  const args = expectObject(rawArguments, "Planner search_repository arguments must be an object.");
  const query = getRequiredStringArgument(args, "query");
  const path = getNullableStringArgument(args, "path");
  const limit = getPositiveIntegerArgument(args, "limit", 1, PLANNER_REPOSITORY_SEARCH_LIMIT);
  const absolutePath = resolveRepositoryPath(workDir, path);

  return searchRepositoryWithRipgrep({ workDir, absolutePath, query, limit }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return searchRepositoryWithoutRipgrep({ workDir, absolutePath, query, limit });
    }

    throw error;
  });
}

async function searchRepositoryWithRipgrep(options: {
  workDir: string;
  absolutePath: string;
  query: string;
  limit: number;
}): Promise<PlannerRepositoryToolResult> {
  const relativePath = toRepositoryRelativePath(options.workDir, options.absolutePath);
  const args = [
    "-n",
    "--color",
    "never",
    "--hidden",
    "--glob",
    "!.git/**",
    "--glob",
    "!node_modules/**",
    "--glob",
    "!dist/**",
    "--regexp",
    options.query,
    relativePath,
  ];

  try {
    const { stdout } = await execFileAsync("rg", args, {
      cwd: options.workDir,
      maxBuffer: 1024 * 1024,
    });
    const lines = splitSearchOutput(stdout, options.limit);
    return {
      ok: true,
      path: relativePath,
      query: options.query,
      results: lines,
      truncated: countSearchLines(stdout) > options.limit,
    };
  } catch (error) {
    const execError = error as Error & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    if (execError.code === 1) {
      return {
        ok: true,
        path: relativePath,
        query: options.query,
        results: [],
        truncated: false,
      };
    }
    if (typeof execError.code === "number" && execError.code > 1) {
      const stderr = typeof execError.stderr === "string" ? execError.stderr.trim() : "";
      throw new Error(stderr || `ripgrep search failed with exit code ${execError.code}.`);
    }

    throw error;
  }
}

async function searchRepositoryWithoutRipgrep(options: {
  workDir: string;
  absolutePath: string;
  query: string;
  limit: number;
}): Promise<PlannerRepositoryToolResult> {
  const relativePath = toRepositoryRelativePath(options.workDir, options.absolutePath);
  const results: string[] = [];
  const matcher = buildFallbackSearchMatcher(options.query);

  await walkSearchPath(options.workDir, options.absolutePath, async (filePath) => {
    if (results.length >= options.limit) {
      return true;
    }

    try {
      const content = await fs.readFile(filePath, "utf8");
      const lines = splitFileContentIntoLines(content);
      for (let index = 0; index < lines.length; index += 1) {
        if (matchesSearchLine(lines[index], matcher)) {
          results.push(`${toRepositoryRelativePath(options.workDir, filePath)}:${index + 1}:${lines[index]}`);
          if (results.length >= options.limit) {
            return true;
          }
        }
      }
    } catch {
      return false;
    }

    return false;
  });

  return {
    ok: true,
    path: relativePath,
    query: options.query,
    results,
    truncated: false,
    fallback: "javascript-search",
  };
}

async function walkSearchPath(
  workDir: string,
  absolutePath: string,
  visitFile: (filePath: string) => Promise<boolean>,
): Promise<boolean> {
  const stat = await fs.stat(absolutePath);
  if (stat.isFile()) {
    return visitFile(absolutePath);
  }
  if (!stat.isDirectory()) {
    return false;
  }

  const directoryEntries = (await fs.readdir(absolutePath, { withFileTypes: true }))
    .filter((entry) => !PLANNER_IGNORED_DIRECTORY_NAMES.has(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of directoryEntries) {
    const entryAbsolutePath = resolve(absolutePath, entry.name);
    const entryRelativePath = toRepositoryRelativePath(workDir, entryAbsolutePath);
    if (PLANNER_IGNORED_DIRECTORY_NAMES.has(entry.name) || PLANNER_IGNORED_DIRECTORY_NAMES.has(entryRelativePath)) {
      continue;
    }

    if (entry.isDirectory()) {
      if (await walkSearchPath(workDir, entryAbsolutePath, visitFile)) {
        return true;
      }
      continue;
    }

    if (entry.isFile() && (await visitFile(entryAbsolutePath))) {
      return true;
    }
  }

  return false;
}

function splitSearchOutput(stdout: string, limit: number): string[] {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(0, limit);
}

function countSearchLines(stdout: string): number {
  return stdout.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

function splitFileContentIntoLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines;
}

function buildFallbackSearchMatcher(query: string): RegExp | string {
  try {
    return new RegExp(query);
  } catch {
    return query;
  }
}

function matchesSearchLine(line: string, matcher: RegExp | string): boolean {
  if (matcher instanceof RegExp) {
    matcher.lastIndex = 0;
    return matcher.test(line);
  }

  return line.includes(matcher);
}

function resolveRepositoryPath(workDir: string, toolPath: string | null): string {
  const requestedPath = normalizeRequestedRepositoryPath(toolPath);
  const absolutePath = resolve(workDir, requestedPath);
  const relativePath = relative(workDir, absolutePath);
  if (relativePath.startsWith("..") || resolve(workDir, relativePath) !== absolutePath) {
    throw new Error(`Planner tool path must stay within the repository: ${requestedPath}`);
  }

  return absolutePath;
}

function toRepositoryRelativePath(workDir: string, absolutePath: string): string {
  const relativePath = relative(workDir, absolutePath);
  return relativePath.length === 0 ? "." : relativePath.split("\\").join("/");
}

function normalizeRequestedRepositoryPath(toolPath: string | null): string {
  if (toolPath === null) {
    return ".";
  }

  const normalized = toolPath.trim();
  return normalized.length === 0 ? "." : normalized;
}

function expectObject(value: unknown, errorMessage: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(errorMessage);
  }

  return value as Record<string, unknown>;
}

function getRequiredStringArgument(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Planner tool argument "${name}" must be a non-empty string.`);
  }

  return value.trim();
}

function getNullableStringArgument(args: Record<string, unknown>, name: string): string | null {
  const value = args[name];
  if (value === null || typeof value === "undefined") {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Planner tool argument "${name}" must be a string or null.`);
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? "." : trimmed;
}

function getPositiveIntegerArgument(
  args: Record<string, unknown>,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const value = args[name];
  if (!Number.isInteger(value)) {
    throw new Error(`Planner tool argument "${name}" must be an integer.`);
  }

  const numericValue = value as number;
  if (numericValue < minimum || numericValue > maximum) {
    throw new Error(`Planner tool argument "${name}" must be between ${minimum} and ${maximum}.`);
  }

  return numericValue;
}

function requireNonEmptyString(value: string | undefined, errorMessage: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(errorMessage);
  }

  return value;
}
