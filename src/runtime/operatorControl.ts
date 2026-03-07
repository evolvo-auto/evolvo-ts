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

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 5 * 1000;
const DEFAULT_CYCLE_EXTENSION = 25;
const DISCORD_API_BASE_URL = "https://discord.com/api/v10";

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
  if (normalized === "continue") {
    return "continue";
  }
  if (normalized === "quit") {
    return "quit";
  }

  return null;
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
    `Reply in this channel with \`continue\` to add ${config.cycleExtension} more cycles, or \`quit\` to stop.`,
  ].join("\n");

  return fetchDiscordJson<{ id: string }>(config, `/channels/${config.controlChannelId}/messages`, {
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

export async function requestCycleLimitDecisionFromOperator(
  currentLimit: number,
): Promise<CycleLimitDecision | null> {
  const config = getDiscordControlConfigFromEnv();
  if (!config) {
    return null;
  }

  try {
    await verifyControlChannel(config);
    const promptMessage = await sendCycleLimitPrompt(config, currentLimit);
    const decision = await waitForOperatorDecision(config, promptMessage.id);
    return {
      decision,
      additionalCycles: decision === "continue" ? config.cycleExtension : 0,
      source: "discord",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    console.error(`Discord operator control failed: ${message}`);
    return {
      decision: "quit",
      additionalCycles: 0,
      source: "discord",
    };
  }
}
