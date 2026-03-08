import { promises as fs } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

const EVOLVO_DIRECTORY_NAME = ".evolvo";
const RUNTIME_READINESS_FILE_NAME = "runtime-readiness.json";
const DEFAULT_POLL_INTERVAL_MS = 100;

export type RuntimeReadinessSignal = {
  token: string;
  status: "ready";
  pid: number;
  startedAt: string;
};

function toFinitePositiveInteger(value: unknown): number | null {
  const asNumber = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(asNumber) || asNumber <= 0) {
    return null;
  }

  return Math.floor(asNumber);
}

function isRuntimeReadinessSignal(value: unknown): value is RuntimeReadinessSignal {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<RuntimeReadinessSignal>;
  const pid = toFinitePositiveInteger(candidate.pid);
  return typeof candidate.token === "string" &&
    candidate.token.trim().length > 0 &&
    candidate.status === "ready" &&
    pid !== null &&
    typeof candidate.startedAt === "string" &&
    candidate.startedAt.trim().length > 0;
}

export function getRuntimeReadinessSignalPath(workDir: string): string {
  return join(workDir, EVOLVO_DIRECTORY_NAME, RUNTIME_READINESS_FILE_NAME);
}

function buildRuntimeReadinessTempPath(signalPath: string, atMs = Date.now()): string {
  const extension = extname(signalPath);
  const fileName = basename(signalPath, extension);
  return join(
    dirname(signalPath),
    `${fileName}.tmp-${Math.max(0, Math.floor(atMs))}-${process.pid}${extension}`,
  );
}

async function readRuntimeReadinessSignal(signalPath: string): Promise<RuntimeReadinessSignal | null> {
  try {
    const raw = await fs.readFile(signalPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRuntimeReadinessSignal(parsed)) {
      return null;
    }

    return {
      ...parsed,
      pid: Math.floor(parsed.pid),
      token: parsed.token.trim(),
    };
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === "ENOENT" || error instanceof SyntaxError) {
      return null;
    }

    throw error;
  }
}

export async function writeRuntimeReadinessSignal(options: {
  workDir: string;
  token: string;
  signalPath?: string;
}): Promise<string> {
  const signalPath = options.signalPath ?? getRuntimeReadinessSignalPath(options.workDir);
  const token = options.token.trim();
  if (!token) {
    throw new Error("Runtime readiness token cannot be empty.");
  }

  const signal: RuntimeReadinessSignal = {
    token,
    status: "ready",
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  await fs.mkdir(dirname(signalPath), { recursive: true });
  const tempPath = buildRuntimeReadinessTempPath(signalPath);
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(signal, null, 2)}\n`, "utf8");
    await fs.rename(tempPath, signalPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return signalPath;
}

async function wait(delayMs: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export async function waitForRuntimeReadinessSignal(options: {
  workDir: string;
  token: string;
  timeoutMs: number;
  pollIntervalMs?: number;
  signalPath?: string;
}): Promise<RuntimeReadinessSignal> {
  const token = options.token.trim();
  if (!token) {
    throw new Error("Runtime readiness token cannot be empty.");
  }

  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs));
  const pollIntervalMs = Math.max(1, Math.floor(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS));
  const signalPath = options.signalPath ?? getRuntimeReadinessSignalPath(options.workDir);
  const startedAt = Date.now();
  let lastObservedToken: string | null = null;
  let sawMalformedPayload = false;

  while (true) {
    try {
      const signal = await readRuntimeReadinessSignal(signalPath);
      if (signal) {
        if (signal.token === token) {
          return signal;
        }

        lastObservedToken = signal.token;
      } else {
        const raw = await fs.readFile(signalPath, "utf8").catch(() => null);
        if (raw !== null) {
          sawMalformedPayload = true;
        }
      }
    } catch (error) {
      throw new Error(
        `Could not read runtime readiness signal at ${signalPath}: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }

    if (Date.now() - startedAt >= timeoutMs) {
      break;
    }

    await wait(pollIntervalMs);
  }

  const tokenHint = lastObservedToken ? ` Last observed token=${lastObservedToken}.` : "";
  const malformedHint = sawMalformedPayload ? " Last observed payload was malformed." : "";
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for runtime readiness token ${token} at ${signalPath}.${tokenHint}${malformedHint}`,
  );
}
