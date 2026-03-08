import {
  ApplicationCommandOptionType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type ChatInputCommandInteraction,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import {
  recordDiscordControlCommandReceipt,
  recordGracefulShutdownRequest,
  readDiscordControlCursorState,
  type GracefulShutdownMode,
  type GracefulShutdownRequest,
  writeDiscordControlCursor,
} from "./gracefulShutdown.js";
import type { IssueSummary } from "../issues/taskIssueManager.js";
import type { ProjectExecutionContext } from "../projects/projectExecutionContext.js";
import { normalizeProjectNameInput } from "../projects/projectNaming.js";

type DiscordControlConfig = {
  botToken: string;
  guildId: string;
  controlChannelId: string;
  operatorUserId: string;
  timeoutMs: number;
  pollIntervalMs: number;
  cycleExtension: number;
};

export type CycleLimitDecision = {
  decision: "continue" | "quit";
  additionalCycles: number;
  source: "discord";
};

export type StartProjectCommandRequest = {
  messageId: string;
  requestedAt: string;
  requestedBy: string;
  displayName: string;
  slug: string;
  repositoryName: string;
  issueLabel: string;
  workspacePath: string;
};

export type StopProjectCommandRequest = {
  messageId: string;
  requestedAt: string;
  requestedBy: string;
  mode: "now" | "when-project-complete";
};

export type StartProjectCommandResult =
  | {
    ok: true;
    action: "created";
    message: string;
    project: {
      displayName: string;
      slug: string;
      repositoryName: string;
      workspacePath: string;
      status: "provisioning";
    };
    trackerIssue: {
      number: number;
      url: string;
      alreadyOpen: boolean;
    };
  }
  | {
    ok: true;
    action: "resumed";
    message: string;
    project: {
      displayName: string;
      slug: string;
      repositoryName: string;
      repositoryUrl: string;
      workspacePath: string;
      status: "active" | "provisioning" | "failed";
    };
    trackerIssue?: {
      number: number;
      url: string;
      alreadyOpen: boolean;
    };
  }
  | {
    ok: false;
    message: string;
  };

export type StopProjectCommandResult =
  | {
    ok: true;
    action:
      | "stopped"
      | "stop-when-complete-scheduled"
      | "already-stop-when-complete-scheduled"
      | "already-stopped"
      | "no-active-project";
    message: string;
    project?: {
      displayName: string;
      slug: string;
    };
  }
  | {
    ok: false;
    message: string;
  };

export type DiscordControlHandlers = {
  onStartProject?: (request: StartProjectCommandRequest) => Promise<StartProjectCommandResult>;
  onStopProject?: (request: StopProjectCommandRequest) => Promise<StopProjectCommandResult>;
};

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 5 * 1000;
const DEFAULT_CYCLE_EXTENSION = 25;
const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const DISCORD_RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const DISCORD_REQUEST_TIMEOUT_MS = 10_000;
const DISCORD_REQUEST_MAX_RETRIES = 2;
const DISCORD_RETRY_BASE_DELAY_MS = 250;

type DiscordOperatorStep =
  | "verify-channel"
  | "read-history"
  | "send-boot-message"
  | "send-prompt"
  | "wait-for-reply"
  | "send-issue-start"
  | "read-control-commands"
  | "send-quit-ack"
  | "send-stop-project-ack"
  | "send-project-return-ack"
  | "send-start-project-ack"
  | "send-cycle-decision-ack"
  | "send-quit-message";

export type CycleLimitDecisionConfirmation =
  | {
    decision: "continue";
    currentLimit: number;
    additionalCycles: number;
    newLimit: number;
  }
  | {
    decision: "quit";
    currentLimit: number;
  };

type DiscordIssueStartNotification = {
  issue: Pick<IssueSummary, "number" | "title"> & {
    repository?: string | null;
    url?: string | null;
  };
  executionContext: {
    trackerRepository: ProjectExecutionContext["trackerRepository"] | null;
    executionRepository: ProjectExecutionContext["executionRepository"] | null;
    project: {
      displayName: ProjectExecutionContext["project"]["displayName"] | null;
      slug: ProjectExecutionContext["project"]["slug"] | null;
    } | null;
  };
  lifecycleState: string | null;
};

type DiscordControlMessage = {
  id: string;
  content: string;
  author?: { id?: string };
};

type DiscordSlashCommandName = "quit" | "startproject" | "stopproject";

type DiscordSlashCommandResult = {
  gracefulShutdownRequest: GracefulShutdownRequest | null;
  replyContent: string;
};

type DiscordSlashCommandStopResult = {
  replyContent: string;
};

const DISCORD_SLASH_COMMAND_NAMES = {
  quit: "quit",
  startProject: "startproject",
  stopProject: "stopproject",
} satisfies Record<string, DiscordSlashCommandName>;

function getRequiredTrimmedEnv(name: string, env: NodeJS.ProcessEnv): string | null {
  const value = env[name]?.trim();
  return value && value.length > 0 ? value : null;
}

function parsePositiveIntegerEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function isDiscordTransportDisabled(env: NodeJS.ProcessEnv): boolean {
  return env.EVOLVO_DISCORD_TRANSPORT?.trim().toLowerCase() === "disabled";
}

export function getDiscordControlConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DiscordControlConfig | null {
  if (isDiscordTransportDisabled(env)) {
    return null;
  }

  const botToken = getRequiredTrimmedEnv("DISCORD_BOT_TOKEN", env);
  const guildId = getRequiredTrimmedEnv("DISCORD_CONTROL_GUILD_ID", env);
  const controlChannelId = getRequiredTrimmedEnv("DISCORD_CONTROL_CHANNEL_ID", env);
  const operatorUserId = getRequiredTrimmedEnv("DISCORD_OPERATOR_USER_ID", env);
  if (!botToken || !guildId || !controlChannelId || !operatorUserId) {
    return null;
  }

  return {
    botToken,
    guildId,
    controlChannelId,
    operatorUserId,
    timeoutMs: parsePositiveIntegerEnv(env, "DISCORD_OPERATOR_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    pollIntervalMs: parsePositiveIntegerEnv(env, "DISCORD_OPERATOR_POLL_INTERVAL_MS", DEFAULT_POLL_INTERVAL_MS),
    cycleExtension: parsePositiveIntegerEnv(env, "DISCORD_CYCLE_EXTENSION", DEFAULT_CYCLE_EXTENSION),
  };
}

function parseOperatorDecision(content: string): "continue" | "quit" | null {
  const normalized = content.trim().toLowerCase();
  if (normalized === "continue") {
    return "continue";
  }
  if (normalized === "quit") {
    return "quit";
  }

  return null;
}

function parseGracefulShutdownCommand(
  content: string,
): { command: GracefulShutdownRequest["command"]; mode: GracefulShutdownMode } | null {
  const normalized = content.trim().toLowerCase().replace(/\s+/g, " ");
  if (normalized === "quit after tasks") {
    return {
      command: "quit after tasks",
      mode: "after-tasks",
    };
  }
  if (normalized === "quit after current task") {
    return {
      command: "quit after current task",
      mode: "after-current-task",
    };
  }

  return null;
}

function parseStartProjectName(content: string): string | null {
  const match = content.match(/^startproject(?:\s+(.+))?$/i);
  if (!match) {
    return null;
  }

  return match[1]?.trim() ?? "";
}

function parseStopProjectCommand(content: string): string | null {
  const match = content.match(/^stopproject(?:\s+(.+))?$/i);
  if (!match) {
    return null;
  }

  return match[1]?.trim() ?? "";
}

function parseStopProjectModeFromSuffix(
  suffix: string,
): { ok: true; mode: "now" | "when-project-complete" } | { ok: false; message: string } {
  if (suffix.length === 0) {
    return {
      ok: true,
      mode: "now",
    };
  }

  const normalized = suffix.replace(/\s+/g, "").toLowerCase();
  if (normalized === "whenprojectcomplete") {
    return {
      ok: true,
      mode: "when-project-complete",
    };
  }

  return {
    ok: false,
    message: "`stopProject` only accepts `whenProjectComplete` as an optional argument.",
  };
}

function buildAuthHeaders(config: DiscordControlConfig): Record<string, string> {
  return {
    Authorization: `Bot ${config.botToken}`,
    "Content-Type": "application/json",
  };
}

function normalizeInlineText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function buildIssueStartProjectLabel(notification: DiscordIssueStartNotification): string {
  const displayName = normalizeInlineText(notification.executionContext.project?.displayName);
  const slug = normalizeInlineText(notification.executionContext.project?.slug);
  if (displayName && slug) {
    return `${displayName} (\`${slug}\`)`;
  }

  if (displayName) {
    return displayName;
  }

  if (slug) {
    return `\`${slug}\``;
  }

  return "unavailable";
}

function buildIssueStartIssueUrl(notification: DiscordIssueStartNotification): string | null {
  const explicitIssueUrl = normalizeInlineText(notification.issue.url);
  if (explicitIssueUrl) {
    return explicitIssueUrl;
  }

  const issueRepository = normalizeInlineText(notification.issue.repository);
  if (issueRepository && /^[^/\s]+\/[^/\s]+$/.test(issueRepository)) {
    return `https://github.com/${issueRepository}/issues/${notification.issue.number}`;
  }

  const trackerRepository = normalizeInlineText(notification.executionContext.trackerRepository);
  if (!trackerRepository || !/^[^/\s]+\/[^/\s]+$/.test(trackerRepository)) {
    return null;
  }

  return `https://github.com/${trackerRepository}/issues/${notification.issue.number}`;
}

class DiscordApiError extends Error {
  public readonly status: number;
  public readonly responseBody: unknown;
  public readonly responseHeaders: Headers | null;

  public constructor(message: string, status: number, responseBody: unknown, responseHeaders?: Headers | null) {
    super(message);
    this.name = "DiscordApiError";
    this.status = status;
    this.responseBody = responseBody;
    this.responseHeaders = responseHeaders ?? null;
  }
}

async function fetchDiscordWithTimeout(
  config: DiscordControlConfig,
  path: string,
  options: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DISCORD_REQUEST_TIMEOUT_MS);

  try {
    return await fetch(`${DISCORD_API_BASE_URL}${path}`, {
      ...options,
      headers: {
        ...buildAuthHeaders(config),
        ...(options.headers ?? {}),
      },
      signal: controller.signal,
    });
  } catch (error) {
    if (isDiscordAbortError(error)) {
      throw new Error(`Discord API request timed out after ${DISCORD_REQUEST_TIMEOUT_MS}ms.`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readDiscordResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return null;
  }

  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function buildDiscordApiErrorMessage(responseBody: unknown, status: number): string {
  if (responseBody !== null && typeof responseBody === "object" && "message" in responseBody) {
    const message = (responseBody as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return `Discord API request failed (${status}): ${message}`;
    }
  }

  if (typeof responseBody === "string" && responseBody.trim()) {
    return `Discord API request failed (${status}): ${responseBody}`;
  }

  return `Discord API request failed with status ${status}.`;
}

function isDiscordRetryableError(error: unknown): boolean {
  if (error instanceof DiscordApiError) {
    return DISCORD_RETRYABLE_STATUS_CODES.has(error.status);
  }

  if (error instanceof Error) {
    if (error.message.startsWith("Discord API request timed out")) {
      return true;
    }

    return error instanceof TypeError;
  }

  return false;
}

function isDiscordAbortError(error: unknown): boolean {
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    return error.name === "AbortError";
  }

  if (error instanceof Error) {
    return error.name === "AbortError";
  }

  return false;
}

async function waitBeforeDiscordRetry(delayMs: number): Promise<void> {
  const normalizedDelayMs = Math.max(0, Math.floor(delayMs));
  await new Promise((resolve) => {
    setTimeout(resolve, normalizedDelayMs);
  });
}

function getDiscordRetryDelayMs(attempt: number, error: unknown): number {
  const attemptDelayMs = DISCORD_RETRY_BASE_DELAY_MS * attempt;
  if (!(error instanceof DiscordApiError)) {
    return attemptDelayMs;
  }

  const retryAfterDelayMs = parseDiscordRetryAfterDelayMs(error.responseHeaders);
  return Math.max(attemptDelayMs, retryAfterDelayMs);
}

function parseDiscordRetryAfterDelayMs(headers: Headers | null): number {
  const rawValue = headers?.get("retry-after")?.trim();
  if (!rawValue) {
    return 0;
  }

  const seconds = Number(rawValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }

  const parsedDateMs = Date.parse(rawValue);
  if (Number.isNaN(parsedDateMs)) {
    return 0;
  }

  return Math.max(0, parsedDateMs - Date.now());
}

async function fetchDiscordJson<T>(
  config: DiscordControlConfig,
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const totalAttempts = DISCORD_REQUEST_MAX_RETRIES + 1;

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    try {
      const response = await fetchDiscordWithTimeout(config, path, options);
      const responseBody = await readDiscordResponseBody(response);

      if (!response.ok) {
        throw new DiscordApiError(
          buildDiscordApiErrorMessage(responseBody, response.status),
          response.status,
          responseBody,
          response.headers,
        );
      }

      return responseBody as T;
    } catch (error) {
      const shouldRetry = attempt < totalAttempts && isDiscordRetryableError(error);
      if (!shouldRetry) {
        throw error;
      }

      await waitBeforeDiscordRetry(getDiscordRetryDelayMs(attempt, error));
    }
  }

  throw new Error("Unexpected Discord request flow.");
}

async function sendCycleLimitPrompt(
  config: DiscordControlConfig,
  currentLimit: number,
): Promise<{ id: string }> {
  const content = [
    `<@${config.operatorUserId}> Evolvo has reached its cycle limit (${currentLimit}).`,
    `Reply in this channel with \`continue\` to add ${config.cycleExtension} more cycles, or \`quit\` to stop.`,
  ].join("\n");

  return fetchDiscordJson<{ id: string }>(config, `/channels/${config.controlChannelId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content }),
  });
}

function buildStartupBootMessageContent(): string {
  const startedAt = new Date().toISOString();
  return [
    "🤖 Evolvo runtime booted.",
    "Operator control is online in plain-text mode, and the live bot session will register slash commands when it connects.",
    "Slash commands: `/quit`, `/startproject`, `/stopproject mode:now|when-project-complete`.",
    "Plain-text fallback: `quit after current task`, `quit after tasks`, `startProject <project-name>`, `stopProject`, `stopProject whenProjectComplete`.",
    "When Evolvo posts a cycle-limit prompt, reply with `continue` or `quit`.",
    `Started at: ${startedAt}`,
  ].join("\n");
}

async function sendStartupBootMessage(config: DiscordControlConfig): Promise<void> {
  await fetchDiscordJson<{ id: string }>(config, `/channels/${config.controlChannelId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content: buildStartupBootMessageContent() }),
  });
}

async function sendIssueStartNotification(
  config: DiscordControlConfig,
  notification: DiscordIssueStartNotification,
): Promise<void> {
  const issueUrl = buildIssueStartIssueUrl(notification);
  const issueTitle = normalizeInlineText(notification.issue.title) ?? "unavailable";
  const lifecycleState = normalizeInlineText(notification.lifecycleState) ?? "unknown";
  const issueRepository = normalizeInlineText(notification.issue.repository) ?? "unknown";
  const trackerRepository = normalizeInlineText(notification.executionContext.trackerRepository) ?? "unknown";
  const executionProject = buildIssueStartProjectLabel(notification);
  const executionRepository = normalizeInlineText(notification.executionContext.executionRepository) ?? "unknown";
  const projectSlug = normalizeInlineText(notification.executionContext.project?.slug) ?? "none";
  console.log(
    `[discord-issue-start] project=${projectSlug} issueRepository=${issueRepository} trackerRepository=${trackerRepository} executionRepository=${executionRepository} issueUrl=${issueUrl ?? "unavailable"}`,
  );
  await fetchDiscordJson<{ id: string }>(config, `/channels/${config.controlChannelId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content: `<@${config.operatorUserId}>`,
      embeds: [
        {
          title: `Started Issue #${notification.issue.number}`,
          description: issueTitle,
          ...(issueUrl ? { url: issueUrl } : {}),
          fields: [
            {
              name: "State",
              value: lifecycleState,
              inline: true,
            },
            {
              name: "Tracker Repository",
              value: trackerRepository,
              inline: true,
            },
            {
              name: "Execution Project",
              value: executionProject,
              inline: true,
            },
            {
              name: "Execution Repository",
              value: executionRepository,
              inline: true,
            },
          ],
        },
      ],
      components: issueUrl
        ? [
            {
              type: 1,
              components: [
                {
                  type: 2,
                  style: 5,
                  label: "Open GitHub Issue",
                  url: issueUrl,
                },
              ],
            },
          ]
        : [],
    }),
  });
}

function buildGracefulShutdownBehaviorLine(request: GracefulShutdownRequest): string {
  return request.mode === "after-tasks"
    ? "Evolvo will finish the current actionable queue, will not plan or create new work, and will stop once the queue is drained."
    : "Evolvo will finish the current task and then stop before starting another issue.";
}

function buildGracefulShutdownAcknowledgementContent(
  operatorUserId: string,
  request: GracefulShutdownRequest,
  options: {
    created: boolean;
    requestedCommand: GracefulShutdownRequest["command"];
  },
): string {
  const confirmationLine = options.created
    ? `<@${operatorUserId}> Confirmed: \`${request.command}\` is now active.`
    : request.command === options.requestedCommand
      ? `<@${operatorUserId}> Confirmed: \`${request.command}\` was already active.`
      : `<@${operatorUserId}> Confirmed: \`${request.command}\` was already active, so the new command did not change the shutdown plan.`;

  return [
    confirmationLine,
    buildGracefulShutdownBehaviorLine(request),
  ].join("\n");
}

async function sendGracefulShutdownAcknowledgement(
  config: DiscordControlConfig,
  request: GracefulShutdownRequest,
  options: {
    created: boolean;
    requestedCommand: GracefulShutdownRequest["command"];
  },
): Promise<void> {
  await fetchDiscordJson<{ id: string }>(config, `/channels/${config.controlChannelId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content: buildGracefulShutdownAcknowledgementContent(config.operatorUserId, request, options),
    }),
  });
}

function buildStartProjectAcknowledgementContent(
  operatorUserId: string,
  request: StartProjectCommandRequest,
  result: StartProjectCommandResult,
): string {
  return !result.ok
    ? [
      `<@${operatorUserId}> Could not queue project start request for \`${request.displayName}\`.`,
      result.message,
      "Usage: `startProject <project-name>`",
    ].join("\n")
    : result.action === "created"
      ? [
        `<@${operatorUserId}> ${result.trackerIssue.alreadyOpen ? "Project creation is already queued" : "Created new project"} for \`${result.project.displayName}\`.`,
        result.message,
        `Tracker issue: #${result.trackerIssue.number} (${result.trackerIssue.url})`,
        `Planned label: \`project:${result.project.slug}\``,
        `Planned repository: \`${result.project.repositoryName}\``,
        `Planned workspace: \`${result.project.workspacePath}\``,
      ].join("\n")
      : [
        `<@${operatorUserId}> Resumed existing project \`${result.project.displayName}\`.`,
        result.message,
        `Registry status: \`${result.project.status}\``,
        `Execution repository: ${result.project.repositoryUrl}`,
        `Workspace: \`${result.project.workspacePath}\``,
        ...(result.trackerIssue
          ? [`Recovery issue: #${result.trackerIssue.number} (${result.trackerIssue.url})`]
          : []),
      ].join("\n");
}

async function sendStartProjectAcknowledgement(
  config: DiscordControlConfig,
  request: StartProjectCommandRequest,
  result: StartProjectCommandResult,
): Promise<void> {
  await fetchDiscordJson<{ id: string }>(config, `/channels/${config.controlChannelId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content: buildStartProjectAcknowledgementContent(config.operatorUserId, request, result),
    }),
  });
}

function buildStopProjectAcknowledgementContent(
  operatorUserId: string,
  result: StopProjectCommandResult,
): string {
  if (!result.ok) {
    return [
      `<@${operatorUserId}> Could not stop the current project.`,
      result.message,
      "Usage: `stopProject` or `stopProject whenProjectComplete`",
    ].join("\n");
  }

  if (result.action === "stopped") {
    return [
      `<@${operatorUserId}> Stopped current project \`${result.project?.displayName ?? result.project?.slug ?? "unknown"}\`.`,
      result.message,
      "Runtime remains online and is waiting for further operator commands.",
    ].join("\n");
  }

  if (result.action === "stop-when-complete-scheduled") {
    return [
      `<@${operatorUserId}> Current project \`${result.project?.displayName ?? result.project?.slug ?? "unknown"}\` will stop when complete.`,
      result.message,
      "Evolvo will return to self-work afterward and remain online for further operator commands.",
    ].join("\n");
  }

  if (result.action === "already-stop-when-complete-scheduled") {
    return [
      `<@${operatorUserId}> Project \`${result.project?.displayName ?? result.project?.slug ?? "unknown"}\` is already set to stop when complete.`,
      result.message,
      "Evolvo will return to self-work afterward and remain online for further operator commands.",
    ].join("\n");
  }

  if (result.action === "already-stopped") {
    return [
      `<@${operatorUserId}> Project \`${result.project?.displayName ?? result.project?.slug ?? "unknown"}\` is already stopped.`,
      result.message,
      "Runtime remains online and is waiting for further operator commands.",
    ].join("\n");
  }

  return [
    `<@${operatorUserId}> No active project is currently selected.`,
    result.message,
    "Runtime remains online and is waiting for further operator commands.",
  ].join("\n");
}

async function sendStopProjectAcknowledgement(
  config: DiscordControlConfig,
  result: StopProjectCommandResult,
): Promise<void> {
  await fetchDiscordJson<{ id: string }>(config, `/channels/${config.controlChannelId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content: buildStopProjectAcknowledgementContent(config.operatorUserId, result),
    }),
  });
}

export async function notifyDeferredProjectStopTriggeredInDiscord(project: {
  displayName: string;
  slug: string;
}): Promise<void> {
  const config = getDiscordControlConfigFromEnv();
  if (!config) {
    return;
  }

  const content = [
    `<@${config.operatorUserId}> Project \`${project.displayName}\` is complete, so the deferred stop has now been applied.`,
    `Project \`${project.slug}\` has been cleared as the active focus.`,
    "Evolvo has returned to self-work, remains online, and can receive further operator commands.",
  ].join("\n");

  try {
    await fetchDiscordJson<{ id: string }>(config, `/channels/${config.controlChannelId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
  } catch (error) {
    const sendMessage = buildStepFailureMessage("send-project-return-ack", error);
    console.error(`Discord deferred project stop notification failed: ${sendMessage}`);
    logDiscordMissingAccessHint(sendMessage);
  }
}

async function sendCycleLimitDecisionConfirmation(
  config: DiscordControlConfig,
  confirmation: CycleLimitDecisionConfirmation,
): Promise<void> {
  const content = confirmation.decision === "continue"
    ? [
      `<@${config.operatorUserId}> Confirmed: continue was applied at the cycle limit.`,
      `Added ${confirmation.additionalCycles} cycles. New limit: ${confirmation.newLimit}. Evolvo remains online.`,
    ].join("\n")
    : [
      `<@${config.operatorUserId}> Confirmed: quit was applied at the cycle limit (${confirmation.currentLimit}).`,
      "Evolvo is about to quit intentionally.",
    ].join("\n");

  await fetchDiscordJson<{ id: string }>(config, `/channels/${config.controlChannelId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content }),
  });
}

async function sendRuntimeQuitNotification(
  config: DiscordControlConfig,
  reason: string,
): Promise<void> {
  const content = [
    `<@${config.operatorUserId}> Evolvo is about to quit intentionally.`,
    `Reason: ${reason}`,
    "Runtime shutdown is starting now.",
  ].join("\n");

  await fetchDiscordJson<{ id: string }>(config, `/channels/${config.controlChannelId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content }),
  });
}

function buildDiscordSlashCommandDefinitions(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  return [
    {
      name: DISCORD_SLASH_COMMAND_NAMES.quit,
      description: "Request a graceful Evolvo shutdown",
      options: [
        {
          type: ApplicationCommandOptionType.String,
          name: "mode",
          description: "When Evolvo should stop",
          required: true,
          choices: [
            {
              name: "After current task",
              value: "after-current-task",
            },
            {
              name: "After current queue",
              value: "after-tasks",
            },
          ],
        },
      ],
    },
    {
      name: DISCORD_SLASH_COMMAND_NAMES.startProject,
      description: "Create or resume a project by name",
      options: [
        {
          type: ApplicationCommandOptionType.String,
          name: "name",
          description: "Project name",
          required: true,
        },
      ],
    },
    {
      name: DISCORD_SLASH_COMMAND_NAMES.stopProject,
      description: "Stop the currently active project",
      options: [
        {
          type: ApplicationCommandOptionType.String,
          name: "mode",
          description: "Whether to stop immediately or when the project is complete",
          required: false,
          choices: [
            {
              name: "Now",
              value: "now",
            },
            {
              name: "When project complete",
              value: "when-project-complete",
            },
          ],
        },
      ],
    },
  ];
}

async function registerDiscordSlashCommands(
  client: Client<true>,
  config: DiscordControlConfig,
): Promise<void> {
  const application = client.application;
  if (!application) {
    throw new Error("Discord slash command registration requires an active client application.");
  }

  await application.commands.set(buildDiscordSlashCommandDefinitions(), config.guildId);
}

function buildWrongChannelInteractionMessage(config: DiscordControlConfig): string {
  return `Use these commands in <#${config.controlChannelId}>.`;
}

function buildUnauthorizedInteractionMessage(): string {
  return "You are not authorized to control this Evolvo runtime.";
}

function buildDuplicateInteractionMessage(): string {
  return "This Discord command was already processed.";
}

async function processGracefulShutdownControlCommand(
  workDir: string,
  messageId: string,
  mode: GracefulShutdownMode,
): Promise<{
  request: GracefulShutdownRequest;
  created: boolean;
}> {
  return recordGracefulShutdownRequest(workDir, {
    messageId,
    mode,
  });
}

async function processStartProjectControlCommand(
  workDir: string,
  messageId: string,
  requestedProjectName: string,
  requestedBy: string,
  handlers: DiscordControlHandlers,
): Promise<{ request: StartProjectCommandRequest; result: StartProjectCommandResult; duplicate: boolean }> {
  const recordedReceipt = await recordDiscordControlCommandReceipt(workDir, {
    command: "start-project",
    messageId,
  });

  if (!recordedReceipt) {
    return {
      duplicate: true,
      request: {
        messageId,
        requestedAt: new Date().toISOString(),
        requestedBy,
        displayName: requestedProjectName.trim() || "<missing project name>",
        slug: "",
        repositoryName: "",
        issueLabel: "",
        workspacePath: "",
      },
      result: {
        ok: false,
        message: buildDuplicateInteractionMessage(),
      },
    };
  }

  let startProjectRequest: StartProjectCommandRequest | null = null;
  let commandResult: StartProjectCommandResult;

  try {
    const normalized = normalizeProjectNameInput(requestedProjectName);
    startProjectRequest = {
      messageId,
      requestedAt: new Date().toISOString(),
      requestedBy,
      displayName: normalized.displayName,
      slug: normalized.slug,
      repositoryName: normalized.repositoryName,
      issueLabel: normalized.issueLabel,
      workspacePath: normalized.workspacePath,
    };

    if (!handlers.onStartProject) {
      throw new Error("Project start commands are not available in this runtime.");
    }

    commandResult = await handlers.onStartProject(startProjectRequest);
  } catch (error) {
    const fallbackDisplayName = requestedProjectName.trim() || "<missing project name>";
    startProjectRequest = {
      messageId,
      requestedAt: new Date().toISOString(),
      requestedBy,
      displayName: fallbackDisplayName,
      slug: "",
      repositoryName: "",
      issueLabel: "",
      workspacePath: "",
    };
    commandResult = {
      ok: false,
      message: error instanceof Error ? error.message : "Unknown project start request error.",
    };
  }

  return {
    duplicate: false,
    request: startProjectRequest,
    result: commandResult,
  };
}

async function processStopProjectControlCommand(
  workDir: string,
  messageId: string,
  requestedBy: string,
  mode: "now" | "when-project-complete",
  handlers: DiscordControlHandlers,
): Promise<{ result: StopProjectCommandResult; duplicate: boolean }> {
  const recordedReceipt = await recordDiscordControlCommandReceipt(workDir, {
    command: "stop-project",
    messageId,
  });

  if (!recordedReceipt) {
    return {
      duplicate: true,
      result: {
        ok: false,
        message: buildDuplicateInteractionMessage(),
      },
    };
  }

  try {
    if (!handlers.onStopProject) {
      throw new Error("Project stop commands are not available in this runtime.");
    }

    return {
      duplicate: false,
      result: await handlers.onStopProject({
        messageId,
        requestedAt: new Date().toISOString(),
        requestedBy,
        mode,
      }),
    };
  } catch (error) {
    return {
      duplicate: false,
      result: {
        ok: false,
        message: error instanceof Error ? error.message : "Unknown project stop request error.",
      },
    };
  }
}

function getSlashCommandName(interaction: ChatInputCommandInteraction): DiscordSlashCommandName | null {
  if (
    interaction.commandName === DISCORD_SLASH_COMMAND_NAMES.quit
    || interaction.commandName === DISCORD_SLASH_COMMAND_NAMES.startProject
    || interaction.commandName === DISCORD_SLASH_COMMAND_NAMES.stopProject
  ) {
    return interaction.commandName;
  }

  return null;
}

export async function handleDiscordSlashCommandInteraction(
  interaction: ChatInputCommandInteraction,
  workDir: string,
  handlers: DiscordControlHandlers = {},
  config: DiscordControlConfig = getDiscordControlConfigFromEnv() ?? (() => {
    throw new Error("Discord operator control is not configured.");
  })(),
): Promise<DiscordSlashCommandResult | DiscordSlashCommandStopResult | null> {
  const commandName = getSlashCommandName(interaction);
  if (commandName === null) {
    return null;
  }

  if (interaction.guildId !== config.guildId || interaction.channelId !== config.controlChannelId) {
    await interaction.reply({
      content: buildWrongChannelInteractionMessage(config),
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }

  if (interaction.user.id !== config.operatorUserId) {
    await interaction.reply({
      content: buildUnauthorizedInteractionMessage(),
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }

  await interaction.deferReply();

  if (commandName === DISCORD_SLASH_COMMAND_NAMES.quit) {
    const mode = interaction.options.getString("mode", true) as GracefulShutdownMode;
    const requestedCommand = mode === "after-tasks" ? "quit after tasks" : "quit after current task";
    const recordedRequest = await processGracefulShutdownControlCommand(workDir, interaction.id, mode);
    const replyContent = buildGracefulShutdownAcknowledgementContent(config.operatorUserId, recordedRequest.request, {
      created: recordedRequest.created,
      requestedCommand,
    });
    await interaction.editReply({ content: replyContent });
    return {
      gracefulShutdownRequest: recordedRequest.request,
      replyContent,
    };
  }

  if (commandName === DISCORD_SLASH_COMMAND_NAMES.startProject) {
    const requestedProjectName = interaction.options.getString("name", true);
    const processed = await processStartProjectControlCommand(
      workDir,
      interaction.id,
      requestedProjectName,
      `discord:${interaction.user.id}`,
      handlers,
    );
    const replyContent = processed.duplicate
      ? buildDuplicateInteractionMessage()
      : buildStartProjectAcknowledgementContent(config.operatorUserId, processed.request, processed.result);
    await interaction.editReply({ content: replyContent });
    return {
      gracefulShutdownRequest: null,
      replyContent,
    };
  }

  const stopProjectMode = interaction.options.getString("mode") as "now" | "when-project-complete" | null;
  const processed = await processStopProjectControlCommand(
    workDir,
    interaction.id,
    `discord:${interaction.user.id}`,
    stopProjectMode ?? "now",
    handlers,
  );
  const replyContent = processed.duplicate
    ? buildDuplicateInteractionMessage()
    : buildStopProjectAcknowledgementContent(config.operatorUserId, processed.result);
  await interaction.editReply({ content: replyContent });
  return {
    replyContent,
  };
}

function getHighestSnowflakeId(ids: string[]): string {
  let highest = ids[0] ?? "0";
  for (const id of ids) {
    if (BigInt(id) > BigInt(highest)) {
      highest = id;
    }
  }

  return highest;
}

function compareSnowflakeIds(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  return BigInt(left) < BigInt(right) ? -1 : 1;
}

async function drainControlChannelMessages(
  config: DiscordControlConfig,
  afterId: string | null,
): Promise<DiscordControlMessage[]> {
  const backlog: DiscordControlMessage[] = [];
  let nextAfterId = afterId;

  while (true) {
    const page = await fetchControlChannelMessages(config, { afterId: nextAfterId, limit: 50 });
    if (page.length === 0) {
      return backlog.sort((left, right) => compareSnowflakeIds(left.id, right.id));
    }

    backlog.push(...page);

    const highestId = getHighestSnowflakeId(page.map((message) => message.id));
    if (highestId === nextAfterId) {
      return backlog.sort((left, right) => compareSnowflakeIds(left.id, right.id));
    }

    nextAfterId = highestId;
    if (page.length < 50) {
      return backlog.sort((left, right) => compareSnowflakeIds(left.id, right.id));
    }
  }
}

async function waitForOperatorDecision(
  config: DiscordControlConfig,
  promptMessageId: string,
): Promise<"continue" | "quit"> {
  const startedAt = Date.now();
  let afterId = promptMessageId;

  while (Date.now() - startedAt < config.timeoutMs) {
    const messages = await fetchDiscordJson<Array<{
      id: string;
      content: string;
      author?: { id?: string };
    }>>(
      config,
      `/channels/${config.controlChannelId}/messages?after=${afterId}&limit=50`,
    );

    const orderedMessages = [...messages].sort((left, right) => compareSnowflakeIds(left.id, right.id));
    for (const operatorMessage of orderedMessages) {
      if (operatorMessage.author?.id !== config.operatorUserId) {
        continue;
      }

      const decision = parseOperatorDecision(operatorMessage.content);
      if (decision) {
        return decision;
      }
    }

    if (orderedMessages.length > 0) {
      afterId = orderedMessages[orderedMessages.length - 1]?.id ?? afterId;
    }

    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }

  return "quit";
}

async function verifyControlChannel(config: DiscordControlConfig): Promise<void> {
  const channel = await fetchDiscordJson<{ id: string; guild_id?: string }>(
    config,
    `/channels/${config.controlChannelId}`,
  );
  if (channel.guild_id !== config.guildId) {
    throw new Error(
      `Configured DISCORD_CONTROL_CHANNEL_ID does not belong to DISCORD_CONTROL_GUILD_ID (${config.guildId}).`,
    );
  }
}

async function fetchControlChannelMessages(
  config: DiscordControlConfig,
  options: {
    afterId?: string | null;
    limit?: number;
  } = {},
): Promise<DiscordControlMessage[]> {
  const query = new URLSearchParams();
  query.set("limit", String(options.limit ?? 50));
  if (options.afterId && options.afterId.trim().length > 0) {
    query.set("after", options.afterId);
  }

  return fetchDiscordJson<DiscordControlMessage[]>(config, `/channels/${config.controlChannelId}/messages?${query.toString()}`);
}

async function initializeDiscordControlCursor(
  config: DiscordControlConfig,
  workDir: string,
): Promise<string | null> {
  const existingCursor = await readDiscordControlCursorState(workDir);
  if (existingCursor.lastSeenMessageId !== null || existingCursor.recoveredMalformed) {
    return existingCursor.lastSeenMessageId;
  }

  const messages = await fetchControlChannelMessages(config, { limit: 1 });
  const lastSeenMessageId = messages[0]?.id ?? null;
  await writeDiscordControlCursor(workDir, lastSeenMessageId);
  return lastSeenMessageId;
}

function buildStepFailureMessage(step: DiscordOperatorStep, error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown error";
  return `[${step}] ${message}`;
}

function logDiscordMissingAccessHint(message: string): void {
  if (message.includes("code\": 50001") || message.toLowerCase().includes("missing access")) {
    console.error(
      "Discord bot is missing access to the configured control channel. Verify DISCORD_CONTROL_GUILD_ID, DISCORD_CONTROL_CHANNEL_ID, and bot channel permissions.",
    );
  }
}

export async function runDiscordOperatorControlStartupCheck(): Promise<void> {
  const config = getDiscordControlConfigFromEnv();
  if (!config) {
    return;
  }

  try {
    await verifyControlChannel(config);
  } catch (error) {
    const message = buildStepFailureMessage("verify-channel", error);
    console.error(`Discord operator control startup preflight failed: ${message}`);
    logDiscordMissingAccessHint(message);
    return;
  }

  try {
    await fetchDiscordJson<Array<{ id: string }>>(
      config,
      `/channels/${config.controlChannelId}/messages?limit=1`,
    );
  } catch (error) {
    const message = buildStepFailureMessage("read-history", error);
    console.error(`Discord operator control startup preflight failed: ${message}`);
    logDiscordMissingAccessHint(message);
    return;
  }

  console.log("Discord operator control startup preflight passed (verify-channel, read-history).");

  try {
    await sendStartupBootMessage(config);
  } catch (error) {
    const message = buildStepFailureMessage("send-boot-message", error);
    console.error(`Discord operator control startup boot message failed: ${message}`);
    logDiscordMissingAccessHint(message);
    return;
  }

  console.log("Discord operator control startup boot message posted.");
}

export async function pollDiscordGracefulShutdownCommand(
  workDir: string,
  handlers: DiscordControlHandlers = {},
): Promise<GracefulShutdownRequest | null> {
  const config = getDiscordControlConfigFromEnv();
  if (!config) {
    return null;
  }

  try {
    const afterId = await initializeDiscordControlCursor(config, workDir);
    const messages = await drainControlChannelMessages(config, afterId);
    if (messages.length === 0) {
      return null;
    }

    let gracefulShutdownRequest: GracefulShutdownRequest | null = null;
    const orderedMessages = [...messages].sort((left, right) => compareSnowflakeIds(left.id, right.id));

    for (const message of orderedMessages) {
      if (message.author?.id !== config.operatorUserId) {
        continue;
      }

      const shutdownCommand = parseGracefulShutdownCommand(message.content);
      if (shutdownCommand !== null) {
        const recordedRequest = await processGracefulShutdownControlCommand(workDir, message.id, shutdownCommand.mode);
        gracefulShutdownRequest = recordedRequest.request;
        try {
          await sendGracefulShutdownAcknowledgement(config, recordedRequest.request, {
            created: recordedRequest.created,
            requestedCommand: shutdownCommand.command,
          });
        } catch (error) {
          const sendMessage = buildStepFailureMessage("send-quit-ack", error);
          console.error(`Discord graceful shutdown acknowledgement failed: ${sendMessage}`);
          logDiscordMissingAccessHint(sendMessage);
        }
        continue;
      }

      const stopProjectCommandSuffix = parseStopProjectCommand(message.content);
      if (stopProjectCommandSuffix !== null && handlers.onStopProject) {
        const parsedStopMode = parseStopProjectModeFromSuffix(stopProjectCommandSuffix);
        const processed = !parsedStopMode.ok
          ? {
            duplicate: false,
            result: {
              ok: false,
              message: parsedStopMode.message,
            } satisfies StopProjectCommandResult,
          }
          : await processStopProjectControlCommand(
            workDir,
            message.id,
            `discord:${config.operatorUserId}`,
            parsedStopMode.mode,
            handlers,
          );
        if (!processed.duplicate) {
          try {
            await sendStopProjectAcknowledgement(config, processed.result);
          } catch (error) {
            const sendMessage = buildStepFailureMessage("send-stop-project-ack", error);
            console.error(`Discord project stop acknowledgement failed: ${sendMessage}`);
            logDiscordMissingAccessHint(sendMessage);
          }
        }

        continue;
      }

      const requestedProjectName = parseStartProjectName(message.content);
      if (requestedProjectName !== null && handlers.onStartProject) {
        const processed = await processStartProjectControlCommand(
          workDir,
          message.id,
          requestedProjectName,
          `discord:${config.operatorUserId}`,
          handlers,
        );
        if (!processed.duplicate) {
          try {
            await sendStartProjectAcknowledgement(config, processed.request, processed.result);
          } catch (error) {
            const sendMessage = buildStepFailureMessage("send-start-project-ack", error);
            console.error(`Discord project start acknowledgement failed: ${sendMessage}`);
            logDiscordMissingAccessHint(sendMessage);
          }
        }
      }
    }

    await writeDiscordControlCursor(workDir, getHighestSnowflakeId(orderedMessages.map((message) => message.id)));

    return gracefulShutdownRequest;
  } catch (error) {
    const message = buildStepFailureMessage("read-control-commands", error);
    console.error(`Discord graceful shutdown polling failed: ${message}`);
    logDiscordMissingAccessHint(message);
    return null;
  }
}

export type DiscordGracefulShutdownListener = {
  stop: () => Promise<void>;
};

async function startDiscordSlashCommandListener(
  config: DiscordControlConfig,
  workDir: string,
  handlers: DiscordControlHandlers,
): Promise<Client<true> | null> {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  client.on(Events.Error, (error) => {
    console.error(`Discord slash command client error: ${error.message}`);
  });

  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    void handleDiscordSlashCommandInteraction(interaction, workDir, handlers, config).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "unknown error";
      console.error(`Discord slash command handling failed: ${message}`);

      if (interaction.replied || interaction.deferred) {
        void interaction.editReply({ content: "Discord command handling failed unexpectedly." }).catch(() => undefined);
        return;
      }

      void interaction.reply({
        content: "Discord command handling failed unexpectedly.",
        flags: MessageFlags.Ephemeral,
      }).catch(() => undefined);
    });
  });

  client.once(Events.ClientReady, (readyClient) => {
    void registerDiscordSlashCommands(readyClient, config)
      .then(() => {
        console.log(
          `Discord slash commands registered in guild ${config.guildId}: /${DISCORD_SLASH_COMMAND_NAMES.quit}, /${DISCORD_SLASH_COMMAND_NAMES.startProject}, /${DISCORD_SLASH_COMMAND_NAMES.stopProject}.`,
        );
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "unknown error";
        console.error(`Discord slash command registration failed: ${message}`);
      });
  });

  try {
    await client.login(config.botToken);
    console.log("Discord slash command gateway client connected.");
    return client as Client<true>;
  } catch (error) {
    client.destroy();
    const message = error instanceof Error ? error.message : "unknown error";
    console.error(`Discord slash command listener startup failed: ${message}`);
    return null;
  }
}

export async function startDiscordGracefulShutdownListener(
  workDir: string,
  handlers: DiscordControlHandlers = {},
): Promise<DiscordGracefulShutdownListener | null> {
  const config = getDiscordControlConfigFromEnv();
  if (!config) {
    return null;
  }

  try {
    await initializeDiscordControlCursor(config, workDir);
  } catch (error) {
    const message = buildStepFailureMessage("read-control-commands", error);
    console.error(`Discord graceful shutdown listener bootstrap failed: ${message}`);
    logDiscordMissingAccessHint(message);
  }

  const slashCommandClient = await startDiscordSlashCommandListener(config, workDir, handlers);
  let stopped = false;
  let pendingPoll: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;

  const scheduleNextPoll = (): void => {
    if (stopped) {
      return;
    }

    timer = setTimeout(() => {
      pendingPoll = pollDiscordGracefulShutdownCommand(workDir, handlers)
        .catch(() => undefined)
        .then(() => undefined)
        .finally(() => {
          pendingPoll = null;
          scheduleNextPoll();
        });
    }, config.pollIntervalMs);
    timer.unref?.();
  };

  scheduleNextPoll();

  return {
    stop: async () => {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
      if (pendingPoll !== null) {
        await pendingPoll;
      }
      slashCommandClient?.destroy();
    },
  };
}

export async function notifyIssueStartedInDiscord(
  notification: DiscordIssueStartNotification,
): Promise<void> {
  const config = getDiscordControlConfigFromEnv();
  if (!config) {
    return;
  }

  try {
    try {
      await verifyControlChannel(config);
    } catch (error) {
      throw new Error(buildStepFailureMessage("verify-channel", error));
    }

    try {
      await sendIssueStartNotification(config, notification);
    } catch (error) {
      throw new Error(buildStepFailureMessage("send-issue-start", error));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    console.error(`Discord issue start notification failed: ${message}`);
    logDiscordMissingAccessHint(message);
  }
}

export async function notifyCycleLimitDecisionAppliedInDiscord(
  confirmation: CycleLimitDecisionConfirmation,
): Promise<void> {
  const config = getDiscordControlConfigFromEnv();
  if (!config) {
    return;
  }

  try {
    await sendCycleLimitDecisionConfirmation(config, confirmation);
  } catch (error) {
    const message = buildStepFailureMessage("send-cycle-decision-ack", error);
    console.error(`Discord cycle-limit confirmation failed: ${message}`);
    logDiscordMissingAccessHint(message);
  }
}

export async function notifyRuntimeQuittingInDiscord(reason: string): Promise<void> {
  const config = getDiscordControlConfigFromEnv();
  if (!config) {
    return;
  }

  try {
    await sendRuntimeQuitNotification(config, reason);
  } catch (error) {
    const message = buildStepFailureMessage("send-quit-message", error);
    console.error(`Discord runtime quit notification failed: ${message}`);
    logDiscordMissingAccessHint(message);
  }
}

export async function requestCycleLimitDecisionFromOperator(
  currentLimit: number,
): Promise<CycleLimitDecision | null> {
  const config = getDiscordControlConfigFromEnv();
  if (!config) {
    return null;
  }

  try {
    try {
      await verifyControlChannel(config);
    } catch (error) {
      throw new Error(buildStepFailureMessage("verify-channel", error));
    }

    let promptMessage: { id: string };
    try {
      promptMessage = await sendCycleLimitPrompt(config, currentLimit);
    } catch (error) {
      throw new Error(buildStepFailureMessage("send-prompt", error));
    }

    let decision: "continue" | "quit";
    try {
      decision = await waitForOperatorDecision(config, promptMessage.id);
    } catch (error) {
      throw new Error(buildStepFailureMessage("wait-for-reply", error));
    }

    return {
      decision,
      additionalCycles: decision === "continue" ? config.cycleExtension : 0,
      source: "discord",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    console.error(`Discord operator control failed: ${message}`);
    logDiscordMissingAccessHint(message);
    return null;
  }
}
