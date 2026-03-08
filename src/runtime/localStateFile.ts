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
  await fs.mkdir(dirname(options.statePath), { recursive: true });
  await fs.writeFile(options.statePath, `${JSON.stringify(defaultState, null, 2)}\n`, "utf8");
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
  await fs.mkdir(dirname(options.statePath), { recursive: true });
  await fs.writeFile(options.statePath, `${JSON.stringify(normalizedState, null, 2)}\n`, "utf8");
  console.warn(
    `Recovered invalid ${options.warningLabel} at ${options.statePath}; preserved corrupt file at ${corruptPath}.`,
  );
  return normalizedState;
}
