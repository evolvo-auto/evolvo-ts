import { WORK_DIR } from "../../constants/workDir.js";
import { heartbeatWorkflowWorker, registerWorkflowWorker } from "./workerHeartbeat.js";
import { buildWorkerId, type WorkerRole } from "./workerTypes.js";
import { runWorkflowWorkerPass } from "./workflowWorkerPass.js";

const DEFAULT_WORKER_HEARTBEAT_INTERVAL_MS = 5_000;

function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function parseRestartCountFromEnv(): number {
  const raw = process.env.EVOLVO_WORKER_RESTART_COUNT?.trim();
  if (!raw) {
    return 0;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

export async function runWorkflowWorkerCommand(options: {
  role: WorkerRole;
  projectSlug: string | null;
  workDir?: string;
}): Promise<void> {
  const workDir = options.workDir ?? WORK_DIR;
  const workerId = buildWorkerId({ role: options.role, projectSlug: options.projectSlug });
  const heartbeatIntervalMs = parsePositiveIntegerEnv(
    "EVOLVO_WORKER_HEARTBEAT_INTERVAL_MS",
    DEFAULT_WORKER_HEARTBEAT_INTERVAL_MS,
  );
  const restartCount = parseRestartCountFromEnv();
  const startedAt = new Date().toISOString();
  let stopping = false;

  const handleStopSignal = (): void => {
    stopping = true;
  };

  process.once("SIGINT", handleStopSignal);
  process.once("SIGTERM", handleStopSignal);

  await registerWorkflowWorker({
    workDir,
    role: options.role,
    projectSlug: options.projectSlug,
    pid: process.pid,
    startedAt,
    heartbeatAt: startedAt,
    restartCount,
  });

  console.log(
    `[worker][${options.role}] started workerId=${workerId} project=${options.projectSlug ?? "global"} restartCount=${restartCount}`,
  );

  try {
    while (!stopping) {
      await heartbeatWorkflowWorker({
        workDir,
        workerId,
        heartbeatAt: new Date().toISOString(),
      });
      await runWorkflowWorkerPass({
        workDir,
        workerId,
        role: options.role,
        projectSlug: options.projectSlug,
      });
      await sleep(heartbeatIntervalMs);
    }
  } finally {
    process.removeListener("SIGINT", handleStopSignal);
    process.removeListener("SIGTERM", handleStopSignal);
    console.log(`[worker][${options.role}] stopping workerId=${workerId}`);
  }
}
