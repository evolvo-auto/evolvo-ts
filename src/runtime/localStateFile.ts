import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

export type RecoverableJsonStateNormalizationResult<T> = {
  state: T;
  recoveredInvalid: boolean;
};

type ReadRecoverableJsonStateOptions<T> = {
  statePath: string;
  createDefaultState: () => T;
  normalizeState: (raw: unknown) => RecoverableJsonStateNormalizationResult<T>;
  warningLabel: string;
};

function isMalformedJsonError(error: unknown): boolean {
  return error instanceof SyntaxError;
}

function buildCorruptStatePath(statePath: string, atMs = Date.now()): string {
  const extension = extname(statePath);
  const fileName = basename(statePath, extension);
  return join(
    dirname(statePath),
    `${fileName}.corrupt-${Math.max(0, Math.floor(atMs))}${extension}`,
  );
}

function buildTempStatePath(statePath: string, atMs = Date.now(), suffix = randomUUID()): string {
  const extension = extname(statePath);
  const fileName = basename(statePath, extension);
  return join(
    dirname(statePath),
    `${fileName}.tmp-${Math.max(0, Math.floor(atMs))}-${process.pid}-${suffix}${extension}`,
  );
}

function serializeJsonState(state: unknown): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

export async function writeAtomicJsonState(statePath: string, state: unknown): Promise<void> {
  await fs.mkdir(dirname(statePath), { recursive: true });
  const tempPath = buildTempStatePath(statePath);
  try {
    await fs.writeFile(tempPath, serializeJsonState(state), "utf8");
    await fs.rename(tempPath, statePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeAtomicJsonStateIfMissing(statePath: string, state: unknown): Promise<boolean> {
  await fs.mkdir(dirname(statePath), { recursive: true });
  const tempPath = buildTempStatePath(statePath);
  try {
    await fs.writeFile(tempPath, serializeJsonState(state), "utf8");
    await fs.link(tempPath, statePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }

    throw error;
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export async function readRecoverableJsonState<T>(
  options: ReadRecoverableJsonStateOptions<T>,
): Promise<T> {
  try {
    const raw = await fs.readFile(options.statePath, "utf8");
    const normalized = options.normalizeState(JSON.parse(raw) as unknown);
    if (!normalized.recoveredInvalid) {
      return normalized.state;
    }

    return recoverInvalidJsonState(options, normalized.state);
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === "ENOENT") {
      return options.createDefaultState();
    }

    if (isMalformedJsonError(error)) {
      return recoverMalformedJsonState(options);
    }

    throw error;
  }
}

async function recoverMalformedJsonState<T>(
  options: ReadRecoverableJsonStateOptions<T>,
): Promise<T> {
  const corruptPath = buildCorruptStatePath(options.statePath);
  await fs.rename(options.statePath, corruptPath);
  const defaultState = options.normalizeState(options.createDefaultState()).state;
  await writeAtomicJsonState(options.statePath, defaultState);
  console.warn(
    `Recovered malformed ${options.warningLabel} at ${options.statePath}; preserved corrupt file at ${corruptPath}.`,
  );
  return defaultState;
}

async function recoverInvalidJsonState<T>(
  options: ReadRecoverableJsonStateOptions<T>,
  normalizedState: T,
): Promise<T> {
  const corruptPath = buildCorruptStatePath(options.statePath);
  await fs.rename(options.statePath, corruptPath);
  await writeAtomicJsonState(options.statePath, normalizedState);
  console.warn(
    `Recovered invalid ${options.warningLabel} at ${options.statePath}; preserved corrupt file at ${corruptPath}.`,
  );
  return normalizedState;
}
