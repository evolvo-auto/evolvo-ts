import { promises as fs } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

const EVOLVO_DIRECTORY_NAME = ".evolvo";
const GRACEFUL_SHUTDOWN_REQUEST_FILE_NAME = "graceful-shutdown-request.json";
const DISCORD_CONTROL_CURSOR_FILE_NAME = "discord-control-cursor.json";
const DISCORD_CONTROL_RECEIPTS_DIRECTORY_NAME = "discord-control-receipts";
const GRACEFUL_SHUTDOWN_REQUEST_VERSION = 1;

export type GracefulShutdownMode = "after-current-task" | "after-tasks";

export type GracefulShutdownRequest = {
  version: typeof GRACEFUL_SHUTDOWN_REQUEST_VERSION;
  source: "discord";
  command: "/quit" | "/quit after tasks";
  mode: GracefulShutdownMode;
  messageId: string;
  requestedAt: string;
};

type DiscordControlCursorState = {
  lastSeenMessageId: string | null;
  recoveredMalformed?: boolean;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeMessageId(value: unknown): string | null {
  if (!isNonEmptyString(value)) {
    return null;
  }

  return value.trim();
}

function normalizeGracefulShutdownRequest(raw: unknown): GracefulShutdownRequest | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  const candidate = raw as Partial<GracefulShutdownRequest>;
  const messageId = normalizeMessageId(candidate.messageId);
  if (candidate.source !== "discord" || messageId === null) {
    return null;
  }

  let command: GracefulShutdownRequest["command"] | null = null;
  let mode: GracefulShutdownMode | null = null;
  if (candidate.command === "/quit after tasks") {
    command = "/quit after tasks";
    mode = "after-tasks";
  } else if (candidate.command === "/quit") {
    command = "/quit";
    mode = candidate.mode === "after-tasks" ? "after-tasks" : "after-current-task";
  }

  if (command === null || mode === null) {
    return null;
  }

  const requestedAt = isNonEmptyString(candidate.requestedAt) ? candidate.requestedAt.trim() : null;
  if (requestedAt === null) {
    return null;
  }

  return {
    version: GRACEFUL_SHUTDOWN_REQUEST_VERSION,
    source: "discord",
    command,
    mode,
    messageId,
    requestedAt,
  };
}

function normalizeDiscordControlCursorState(raw: unknown): DiscordControlCursorState | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  const candidate = raw as Partial<DiscordControlCursorState>;
  if (!Object.hasOwn(candidate, "lastSeenMessageId")) {
    return null;
  }

  return {
    lastSeenMessageId: normalizeMessageId(candidate.lastSeenMessageId),
    recoveredMalformed: candidate.recoveredMalformed === true,
  };
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function buildCorruptStatePath(path: string, atMs = Date.now()): string {
  const extension = extname(path);
  const fileName = basename(path, extension);
  return join(
    dirname(path),
    `${fileName}.corrupt-${Math.max(0, Math.floor(atMs))}${extension}`,
  );
}

async function recoverMalformedJsonFile(path: string, defaultValue: unknown, warningLabel: string): Promise<void> {
  const corruptPath = buildCorruptStatePath(path);
  await fs.rename(path, corruptPath);
  await writeJsonFile(path, defaultValue);
  console.warn(`Recovered malformed ${warningLabel} at ${path}; preserved corrupt file at ${corruptPath}.`);
}

export function getGracefulShutdownRequestPath(workDir: string): string {
  return join(workDir, EVOLVO_DIRECTORY_NAME, GRACEFUL_SHUTDOWN_REQUEST_FILE_NAME);
}

export function getDiscordControlCursorPath(workDir: string): string {
  return join(workDir, EVOLVO_DIRECTORY_NAME, DISCORD_CONTROL_CURSOR_FILE_NAME);
}

function getDiscordControlReceiptPath(workDir: string, command: string, messageId: string): string {
  return join(
    workDir,
    EVOLVO_DIRECTORY_NAME,
    DISCORD_CONTROL_RECEIPTS_DIRECTORY_NAME,
    `${command}-${messageId}.json`,
  );
}

async function readGracefulShutdownRequestState(workDir: string): Promise<{
  request: GracefulShutdownRequest | null;
  recoveredMalformed: boolean;
}> {
  const path = getGracefulShutdownRequestPath(workDir);
  try {
    const raw = await fs.readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null) {
      return {
        request: null,
        recoveredMalformed: false,
      };
    }

    const normalized = normalizeGracefulShutdownRequest(parsed);
    if (normalized !== null) {
      return {
        request: normalized,
        recoveredMalformed: false,
      };
    }

    await recoverMalformedJsonFile(path, null, "graceful shutdown request store");
    return {
      request: null,
      recoveredMalformed: true,
    };
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === "ENOENT") {
      return {
        request: null,
        recoveredMalformed: false,
      };
    }

    if (error instanceof SyntaxError) {
      await recoverMalformedJsonFile(path, null, "graceful shutdown request store");
      return {
        request: null,
        recoveredMalformed: true,
      };
    }

    throw error;
  }
}

export async function readGracefulShutdownRequest(workDir: string): Promise<GracefulShutdownRequest | null> {
  return (await readGracefulShutdownRequestState(workDir)).request;
}

export async function recordGracefulShutdownRequest(
  workDir: string,
  input: {
    messageId: string;
    requestedAt?: string;
    mode?: GracefulShutdownMode;
  },
): Promise<{ request: GracefulShutdownRequest; created: boolean }> {
  const existing = await readGracefulShutdownRequest(workDir);
  if (existing !== null) {
    return { request: existing, created: false };
  }

  const messageId = normalizeMessageId(input.messageId);
  if (messageId === null) {
    throw new Error("Graceful shutdown request message ID cannot be empty.");
  }

  const requestedAt = isNonEmptyString(input.requestedAt)
    ? input.requestedAt.trim()
    : new Date().toISOString();
  const mode = input.mode ?? "after-current-task";

  const request: GracefulShutdownRequest = {
    version: GRACEFUL_SHUTDOWN_REQUEST_VERSION,
    source: "discord",
    command: mode === "after-tasks" ? "/quit after tasks" : "/quit",
    mode,
    messageId,
    requestedAt,
  };
  await writeJsonFile(getGracefulShutdownRequestPath(workDir), request);
  return { request, created: true };
}

export async function clearGracefulShutdownRequest(workDir: string): Promise<void> {
  await fs.rm(getGracefulShutdownRequestPath(workDir), { force: true });
}

export async function consumeGracefulShutdownRequest(workDir: string): Promise<GracefulShutdownRequest | null> {
  const request = await readGracefulShutdownRequest(workDir);
  if (request === null) {
    return null;
  }

  await clearGracefulShutdownRequest(workDir);
  return request;
}

export async function readDiscordControlCursor(workDir: string): Promise<string | null> {
  return (await readDiscordControlCursorState(workDir)).lastSeenMessageId;
}

export async function readDiscordControlCursorState(workDir: string): Promise<{
  lastSeenMessageId: string | null;
  recoveredMalformed: boolean;
}> {
  const path = getDiscordControlCursorPath(workDir);
  try {
    const raw = await fs.readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const normalized = normalizeDiscordControlCursorState(parsed);
    if (normalized !== null) {
      return {
        lastSeenMessageId: normalized.lastSeenMessageId,
        recoveredMalformed: normalized.recoveredMalformed === true,
      };
    }

    await recoverMalformedJsonFile(path, {
      lastSeenMessageId: null,
      recoveredMalformed: true,
    } satisfies DiscordControlCursorState, "discord control cursor state store");
    return {
      lastSeenMessageId: null,
      recoveredMalformed: true,
    };
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === "ENOENT") {
      return {
        lastSeenMessageId: null,
        recoveredMalformed: false,
      };
    }

    if (error instanceof SyntaxError) {
      await recoverMalformedJsonFile(path, {
        lastSeenMessageId: null,
        recoveredMalformed: true,
      } satisfies DiscordControlCursorState, "discord control cursor state store");
      return {
        lastSeenMessageId: null,
        recoveredMalformed: true,
      };
    }

    throw error;
  }
}

export async function writeDiscordControlCursor(workDir: string, lastSeenMessageId: string | null): Promise<void> {
  await writeJsonFile(getDiscordControlCursorPath(workDir), {
    lastSeenMessageId: normalizeMessageId(lastSeenMessageId),
    recoveredMalformed: false,
  } satisfies DiscordControlCursorState);
}

export async function recordDiscordControlCommandReceipt(
  workDir: string,
  input: {
    command: "start-project";
    messageId: string;
    recordedAt?: string;
  },
): Promise<boolean> {
  const messageId = normalizeMessageId(input.messageId);
  if (messageId === null) {
    throw new Error("Discord control receipt message ID cannot be empty.");
  }

  const path = getDiscordControlReceiptPath(workDir, input.command, messageId);
  try {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(
      path,
      `${JSON.stringify({
        command: input.command,
        messageId,
        recordedAt: isNonEmptyString(input.recordedAt) ? input.recordedAt.trim() : new Date().toISOString(),
      }, null, 2)}\n`,
      {
        encoding: "utf8",
        flag: "wx",
      },
    );
    return true;
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === "EEXIST") {
      return false;
    }

    throw error;
  }
}
