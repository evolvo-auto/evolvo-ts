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
  workspaceRelativePath: string;
};

export type StartProjectCommandResult =
  | {
    ok: true;
    message: string;
    issueNumber: number;
    issueUrl: string;
  }
  | {
    ok: false;
    message: string;
  };

export type DiscordControlHandlers = {
  onStartProject?: (request: StartProjectCommandRequest) => Promise<StartProjectCommandResult>;
};

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 5 * 1000;
const DEFAULT_CYCLE_EXTENSION = 25;
const DISCORD_API_BASE_URL = "https://discord.com/api/v10";

type DiscordOperatorStep =
  | "verify-channel"
  | "read-history"
  | "send-boot-message"
  | "send-prompt"
  | "wait-for-reply"
  | "send-issue-start"
  | "read-control-commands"
  | "send-quit-ack"
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
  issue: Pick<IssueSummary, "number" | "title">;
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

export function getDiscordControlConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DiscordControlConfig | null {
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
  if (normalized === "continue" || normalized === "/continue") {
    return "continue";
  }
  if (normalized === "quit" || normalized === "/quit") {
    return "quit";
  }

  return null;
}

function parseGracefulShutdownCommand(
  content: string,
): { command: GracefulShutdownRequest["command"]; mode: GracefulShutdownMode } | null {
  const normalized = content.trim().toLowerCase().replace(/\s+/g, " ");
  if (normalized === "/quit after tasks") {
    return {
      command: "/quit after tasks",
      mode: "after-tasks",
    };
  }
  if (normalized === "/quit") {
    return {
      command: "/quit",
      mode: "after-current-task",
    };
  }

  return null;
}

function parseStartProjectName(content: string): string | null {
  const match = content.match(/^\/startproject(?:\s+(.+))?$/i);
  if (!match) {
    return null;
  }

  return match[1]?.trim() ?? "";
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
  const trackerRepository = normalizeInlineText(notification.executionContext.trackerRepository);
  if (!trackerRepository || !/^[^/\s]+\/[^/\s]+$/.test(trackerRepository)) {
    return null;
  }

  return `https://github.com/${trackerRepository}/issues/${notification.issue.number}`;
}

async function fetchDiscordJson<T>(
  config: DiscordControlConfig,
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${DISCORD_API_BASE_URL}${path}`, {
    ...options,
    headers: {
      ...buildAuthHeaders(config),
      ...(options.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord API request failed (${response.status}): ${body || response.statusText}`);
  }

  return response.json() as Promise<T>;
}

async function sendCycleLimitPrompt(
  config: DiscordControlConfig,
  currentLimit: number,
): Promise<{ id: string }> {
  const content = [
    `<@${config.operatorUserId}> Evolvo has reached its cycle limit (${currentLimit}).`,
    `Reply in this channel with \`continue\` to add ${config.cycleExtension} more cycles, or \`quit\` / \`/quit\` to stop.`,
  ].join("\n");

  return fetchDiscordJson<{ id: string }>(config, `/channels/${config.controlChannelId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content }),
  });
}

async function sendStartupBootMessage(config: DiscordControlConfig): Promise<void> {
  const startedAt = new Date().toISOString();
  const content = [
    "🤖 Evolvo runtime booted.",
    "Operator control is online for cycle-limit decisions, graceful shutdown (`/quit`, `/quit after tasks`), and `/startProject` requests.",
    `Started at: ${startedAt}`,
  ].join("\n");

  await fetchDiscordJson<{ id: string }>(config, `/channels/${config.controlChannelId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content }),
  });
}

async function sendIssueStartNotification(
  config: DiscordControlConfig,
  notification: DiscordIssueStartNotification,
): Promise<void> {
  const issueUrl = buildIssueStartIssueUrl(notification);
  const issueTitle = normalizeInlineText(notification.issue.title) ?? "unavailable";
  const lifecycleState = normalizeInlineText(notification.lifecycleState) ?? "unknown";
  const trackerRepository = normalizeInlineText(notification.executionContext.trackerRepository) ?? "unknown";
  const executionProject = buildIssueStartProjectLabel(notification);
  const executionRepository = normalizeInlineText(notification.executionContext.executionRepository) ?? "unknown";
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

async function sendGracefulShutdownAcknowledgement(
  config: DiscordControlConfig,
  request: GracefulShutdownRequest,
  options: {
    created: boolean;
    requestedCommand: GracefulShutdownRequest["command"];
  },
): Promise<void> {
  const confirmationLine = options.created
    ? `<@${config.operatorUserId}> Confirmed: \`${request.command}\` is now active.`
    : request.command === options.requestedCommand
      ? `<@${config.operatorUserId}> Confirmed: \`${request.command}\` was already active.`
      : `<@${config.operatorUserId}> Confirmed: \`${request.command}\` was already active, so the new command did not change the shutdown plan.`;
  const content = [
    confirmationLine,
    buildGracefulShutdownBehaviorLine(request),
  ].join("\n");

  await fetchDiscordJson<{ id: string }>(config, `/channels/${config.controlChannelId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content }),
  });
}

async function sendStartProjectAcknowledgement(
  config: DiscordControlConfig,
  request: StartProjectCommandRequest,
  result: StartProjectCommandResult,
): Promise<void> {
  const content = result.ok
    ? [
      `<@${config.operatorUserId}> Project start request queued for \`${request.displayName}\`.`,
      `Tracker issue: #${result.issueNumber} (${result.issueUrl})`,
      `Planned label: \`${request.issueLabel}\``,
      `Planned repository: \`${request.repositoryName}\``,
      `Planned workspace: \`${request.workspaceRelativePath}\``,
    ].join("\n")
    : [
      `<@${config.operatorUserId}> Could not queue project start request for \`${request.displayName}\`.`,
      result.message,
      "Usage: `/startProject <project-name>`",
    ].join("\n");

  await fetchDiscordJson<{ id: string }>(config, `/channels/${config.controlChannelId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content }),
  });
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
    if (messages.length > 0) {
      afterId = getHighestSnowflakeId(messages.map((message) => message.id));
    }

    const operatorMessage = messages.find((message) => message.author?.id === config.operatorUserId);
    if (operatorMessage) {
      const decision = parseOperatorDecision(operatorMessage.content);
      if (decision) {
        return decision;
      }
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

      if (message.author?.id === config.operatorUserId) {
        const shutdownCommand = parseGracefulShutdownCommand(message.content);
        if (shutdownCommand !== null) {
          const recordedRequest = await recordGracefulShutdownRequest(workDir, {
            messageId: message.id,
            mode: shutdownCommand.mode,
          });
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
        } else {
          const requestedProjectName = parseStartProjectName(message.content);
          if (requestedProjectName !== null && handlers.onStartProject) {
            const recordedReceipt = await recordDiscordControlCommandReceipt(workDir, {
              command: "start-project",
              messageId: message.id,
            });
            if (recordedReceipt) {
              let startProjectRequest: StartProjectCommandRequest | null = null;
              let commandResult: StartProjectCommandResult;

              try {
                const normalized = normalizeProjectNameInput(requestedProjectName);
                startProjectRequest = {
                  messageId: message.id,
                  requestedAt: new Date().toISOString(),
                  requestedBy: `discord:${config.operatorUserId}`,
                  displayName: normalized.displayName,
                  slug: normalized.slug,
                  repositoryName: normalized.repositoryName,
                  issueLabel: normalized.issueLabel,
                  workspaceRelativePath: normalized.workspaceRelativePath,
                };
                commandResult = await handlers.onStartProject(startProjectRequest);
              } catch (error) {
                const fallbackDisplayName = requestedProjectName.trim() || "<missing project name>";
                startProjectRequest = {
                  messageId: message.id,
                  requestedAt: new Date().toISOString(),
                  requestedBy: `discord:${config.operatorUserId}`,
                  displayName: fallbackDisplayName,
                  slug: "",
                  repositoryName: "",
                  issueLabel: "",
                  workspaceRelativePath: "",
                };
                commandResult = {
                  ok: false,
                  message: error instanceof Error ? error.message : "Unknown project start request error.",
                };
              }

              try {
                await sendStartProjectAcknowledgement(config, startProjectRequest, commandResult);
              } catch (error) {
                const sendMessage = buildStepFailureMessage("send-start-project-ack", error);
                console.error(`Discord project start acknowledgement failed: ${sendMessage}`);
                logDiscordMissingAccessHint(sendMessage);
              }
            }
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
