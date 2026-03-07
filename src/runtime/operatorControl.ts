import {
  recordDiscordControlCommandReceipt,
  recordGracefulShutdownRequest,
  readDiscordControlCursor,
  type GracefulShutdownMode,
  type GracefulShutdownRequest,
  writeDiscordControlCursor,
} from "./gracefulShutdown.js";
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
  | "send-start-project-ack";

type DiscordIssueStartNotification = {
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  trackerRepository: string;
  executionProject: string;
  executionRepository: string;
  lifecycleState: string;
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
  await fetchDiscordJson<{ id: string }>(config, `/channels/${config.controlChannelId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content: `<@${config.operatorUserId}>`,
      embeds: [
        {
          title: `Started Issue #${notification.issueNumber}`,
          description: notification.issueTitle,
          url: notification.issueUrl,
          fields: [
            {
              name: "State",
              value: notification.lifecycleState,
              inline: true,
            },
            {
              name: "Tracker Repository",
              value: notification.trackerRepository,
              inline: true,
            },
            {
              name: "Execution Project",
              value: notification.executionProject,
              inline: true,
            },
            {
              name: "Execution Repository",
              value: notification.executionRepository,
              inline: true,
            },
          ],
        },
      ],
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 5,
              label: "Open GitHub Issue",
              url: notification.issueUrl,
            },
          ],
        },
      ],
    }),
  });
}

async function sendGracefulShutdownAcknowledgement(
  config: DiscordControlConfig,
  request: GracefulShutdownRequest,
): Promise<void> {
  const content = request.mode === "after-tasks"
    ? [
      `<@${config.operatorUserId}> Queue-drain shutdown requested.`,
      "Evolvo will finish the current actionable queue, will not plan or create new work, and will stop once the queue is drained.",
    ].join("\n")
    : [
      `<@${config.operatorUserId}> Graceful shutdown requested.`,
      "Evolvo will finish the current task and then stop before starting another issue.",
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

function getHighestSnowflakeId(ids: string[]): string {
  let highest = ids[0] ?? "0";
  for (const id of ids) {
    if (BigInt(id) > BigInt(highest)) {
      highest = id;
    }
  }

  return highest;
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
  const existingCursor = await readDiscordControlCursor(workDir);
  if (existingCursor !== null) {
    return existingCursor;
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
    const messages = await fetchControlChannelMessages(config, { afterId, limit: 50 });
    if (messages.length === 0) {
      return null;
    }

    let gracefulShutdownRequest: GracefulShutdownRequest | null = null;
    const orderedMessages = [...messages].sort((left, right) => {
      if (left.id === right.id) {
        return 0;
      }

      return BigInt(left.id) < BigInt(right.id) ? -1 : 1;
    });

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
          if (recordedRequest.created) {
            try {
              await sendGracefulShutdownAcknowledgement(config, recordedRequest.request);
            } catch (error) {
              const sendMessage = buildStepFailureMessage("send-quit-ack", error);
              console.error(`Discord graceful shutdown acknowledgement failed: ${sendMessage}`);
              logDiscordMissingAccessHint(sendMessage);
            }
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

      await writeDiscordControlCursor(workDir, message.id);
    }

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
