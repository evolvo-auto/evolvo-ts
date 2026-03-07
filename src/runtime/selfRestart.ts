import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import { getRuntimeReadinessSignalPath, waitForRuntimeReadinessSignal } from "./runtimeReadiness.js";

const execFileAsync = promisify(execFile);
const STARTUP_READINESS_TIMEOUT_MS = 15_000;

type ExecFailure = Error & { stdout?: string | Buffer; stderr?: string | Buffer };

function formatOutput(value: string | Buffer | undefined): string {
  if (value === undefined) {
    return "";
  }

  return String(value).trim();
}

async function runStep(command: string, args: string[], workingDirectory: string): Promise<void> {
  console.log(`[restart] Running: ${command} ${args.join(" ")}`);

  try {
    await execFileAsync(command, args, { cwd: workingDirectory });
  } catch (error) {
    const execError = error as ExecFailure;
    const stderr = formatOutput(execError.stderr);
    const stdout = formatOutput(execError.stdout);
    const output = stderr || stdout;
    const detail = output ? ` Output: ${output}` : "";
    throw new Error(`Post-merge restart step failed: ${command} ${args.join(" ")}.${detail}`);
  }
}

async function startUpdatedRuntime(workingDirectory: string): Promise<void> {
  console.log("[restart] Running: pnpm start");
  const readinessToken = randomUUID();
  const readinessSignalPath = getRuntimeReadinessSignalPath(workingDirectory);
  await fs.rm(readinessSignalPath, { force: true });

  const child = spawn("pnpm", ["start"], {
    cwd: workingDirectory,
    detached: false,
    stdio: "inherit",
    env: {
      ...process.env,
      EVOLVO_RESTART_TOKEN: readinessToken,
      EVOLVO_READINESS_FILE: readinessSignalPath,
    },
  });

  let readySignalPid: number | null = null;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Post-merge restart readiness check failed: timed out after ${STARTUP_READINESS_TIMEOUT_MS}ms waiting for token ${readinessToken} at ${readinessSignalPath}.`,
        ),
      );
    }, STARTUP_READINESS_TIMEOUT_MS);

    function cleanup(): void {
      clearTimeout(timeout);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
    }

    function onError(error: Error): void {
      cleanup();
      reject(new Error(`Post-merge restart failed to launch runtime: ${error.message}`));
    }

    function onExit(code: number | null, signal: NodeJS.Signals | null): void {
      cleanup();
      const reason = code !== null ? `code ${code}` : `signal ${signal ?? "unknown"}`;
      reject(new Error(`Post-merge restart failed: pnpm start exited early with ${reason}.`));
    }

    child.once("error", onError);
    child.once("exit", onExit);
    waitForRuntimeReadinessSignal({
      workDir: workingDirectory,
      token: readinessToken,
      timeoutMs: STARTUP_READINESS_TIMEOUT_MS,
      signalPath: readinessSignalPath,
    }).then((signal) => {
      readySignalPid = signal.pid;
      cleanup();
      resolve();
    }).catch((error) => {
      cleanup();
      reject(new Error(
        `Post-merge restart readiness check failed: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      ));
    });
  });

  console.log(
    `[restart] Started updated runtime process (pid ${child.pid ?? "unknown"}) with readiness signal pid ${readySignalPid ?? "unknown"}.`,
  );
}

export async function runPostMergeSelfRestart(workingDirectory: string): Promise<void> {
  await runStep("git", ["checkout", "main"], workingDirectory);
  await runStep("git", ["pull", "--ff-only"], workingDirectory);
  await runStep("pnpm", ["i"], workingDirectory);
  await runStep("pnpm", ["build"], workingDirectory);
  await startUpdatedRuntime(workingDirectory);
}
