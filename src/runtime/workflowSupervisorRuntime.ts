import { spawn, type ChildProcess } from "node:child_process";
import { removeWorkflowWorkerRecord, readWorkflowWorkerState } from "./workers/workflowWorkerState.js";
import { buildWorkerId, type WorkerProcessRecord, type WorkerSpec } from "./workers/workerTypes.js";
import { runWorkflowSupervisorPlanningCycle, type WorkflowSupervisorAction } from "./workflowSupervisor.js";

const DEFAULT_SUPERVISOR_POLL_INTERVAL_MS = 5_000;

export type WorkflowWorkerHandle = {
  workerId: string;
  stop: () => Promise<void>;
};

export type WorkflowWorkerSpawner = (options: {
  workDir: string;
  spec: WorkerSpec;
  restartCount: number;
}) => Promise<WorkflowWorkerHandle>;

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

async function sleep(delayMs: number): Promise<void> {
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

function buildNodeWorkerArgs(spec: WorkerSpec): string[] {
  return spec.role === "dev"
    ? ["worker", spec.role, spec.projectSlug ?? ""]
    : ["worker", spec.role];
}

function stopChildProcess(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null || child.killed) {
      resolve();
      return;
    }

    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

export function createNodeWorkflowWorkerSpawner(): WorkflowWorkerSpawner {
  return async (options) => {
    const entryScript = process.argv[1];
    if (!entryScript) {
      throw new Error("Cannot spawn workflow worker: entry script path is unavailable.");
    }

    const child = spawn(process.execPath, [...process.execArgv, entryScript, ...buildNodeWorkerArgs(options.spec)], {
      cwd: options.workDir,
      stdio: "inherit",
      env: {
        ...process.env,
        EVOLVO_WORKER_RESTART_COUNT: String(options.restartCount),
      },
    });
    const workerId = buildWorkerId(options.spec);

    return {
      workerId,
      stop: async () => {
        await stopChildProcess(child);
      },
    };
  };
}

export async function applyWorkflowSupervisorActions(options: {
  workDir: string;
  actions: WorkflowSupervisorAction[];
  currentWorkers: WorkerProcessRecord[];
  workerHandles: Map<string, WorkflowWorkerHandle>;
  spawnWorker: WorkflowWorkerSpawner;
}): Promise<void> {
  for (const action of options.actions) {
    if (action.type === "start") {
      if (options.workerHandles.has(buildWorkerId(action.spec))) {
        continue;
      }

      const handle = await options.spawnWorker({
        workDir: options.workDir,
        spec: action.spec,
        restartCount: 0,
      });
      options.workerHandles.set(handle.workerId, handle);
      console.log(`[supervisor] started ${handle.workerId}.`);
      continue;
    }

    if (action.type === "stop") {
      const existingHandle = options.workerHandles.get(action.workerId);
      if (existingHandle) {
        await existingHandle.stop();
        options.workerHandles.delete(action.workerId);
      }
      await removeWorkflowWorkerRecord(options.workDir, action.workerId);
      console.log(`[supervisor] stopped ${action.workerId} (${action.reason}).`);
      continue;
    }

    const existingHandle = options.workerHandles.get(action.workerId);
    if (existingHandle) {
      await existingHandle.stop();
      options.workerHandles.delete(action.workerId);
    }
    await removeWorkflowWorkerRecord(options.workDir, action.workerId);
    const previousRecord = options.currentWorkers.find((worker) => worker.workerId === action.workerId);
    const handle = await options.spawnWorker({
      workDir: options.workDir,
      spec: action.spec,
      restartCount: (previousRecord?.restartCount ?? 0) + 1,
    });
    options.workerHandles.set(handle.workerId, handle);
    console.log(`[supervisor] restarted ${handle.workerId} (${action.reason}).`);
  }
}

export async function runWorkflowSupervisorRuntime(options: {
  workDir: string;
  pollIntervalMs?: number;
  runPlanningCycle?: typeof runWorkflowSupervisorPlanningCycle;
  spawnWorker?: WorkflowWorkerSpawner;
}): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? parsePositiveIntegerEnv(
    "EVOLVO_SUPERVISOR_POLL_INTERVAL_MS",
    DEFAULT_SUPERVISOR_POLL_INTERVAL_MS,
  );
  const runPlanningCycle = options.runPlanningCycle ?? runWorkflowSupervisorPlanningCycle;
  const spawnWorker = options.spawnWorker ?? createNodeWorkflowWorkerSpawner();
  const workerHandles = new Map<string, WorkflowWorkerHandle>();
  let stopping = false;

  const handleStopSignal = (): void => {
    stopping = true;
  };

  process.once("SIGINT", handleStopSignal);
  process.once("SIGTERM", handleStopSignal);

  try {
    while (!stopping) {
      const [actions, currentState] = await Promise.all([
        runPlanningCycle({ workDir: options.workDir }),
        readWorkflowWorkerState(options.workDir),
      ]);
      await applyWorkflowSupervisorActions({
        workDir: options.workDir,
        actions,
        currentWorkers: currentState.workers,
        workerHandles,
        spawnWorker,
      });
      await sleep(pollIntervalMs);
    }
  } finally {
    process.removeListener("SIGINT", handleStopSignal);
    process.removeListener("SIGTERM", handleStopSignal);
    await Promise.all([...workerHandles.values()].map((handle) => handle.stop()));
    workerHandles.clear();
  }
}
