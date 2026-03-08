import { WORK_DIR } from "../constants/workDir.js";
import { createDiscordControlHandlers } from "./runtimeOperatorHandlers.js";
import { createInitialRuntimeExecutionState } from "./runtimeExecutionState.js";
import { createRuntimeServices } from "./runtimeServices.js";
import { runRuntimeStartup } from "./runtimeStartup.js";
import { runWorkflowSupervisorRuntime } from "./workflowSupervisorRuntime.js";

const MAX_ISSUE_CYCLES = 10;

export async function runRuntimeApp(options: {
  githubOwner: string;
  githubRepo: string;
  workDir?: string;
}): Promise<void> {
  const workDir = options.workDir ?? WORK_DIR;
  const services = createRuntimeServices({
    githubOwner: options.githubOwner,
    githubRepo: options.githubRepo,
    workDir,
  });
  const runtimeState = createInitialRuntimeExecutionState(MAX_ISSUE_CYCLES);
  const discordHandlers = createDiscordControlHandlers({
    workDir,
    trackerOwner: options.githubOwner,
    trackerRepo: options.githubRepo,
    defaultProjectContext: services.defaultProjectContext,
    issueManager: services.issueManager,
    runtimeState,
  });
  const gracefulShutdownListener = await runRuntimeStartup({
    workDir,
    githubOwner: options.githubOwner,
    githubRepo: options.githubRepo,
    defaultProjectContext: services.defaultProjectContext,
    projectsClient: services.projectsClient,
    discordHandlers,
  });

  try {
    await runWorkflowSupervisorRuntime({
      workDir,
    });
  } finally {
    await gracefulShutdownListener?.stop();
  }
}
