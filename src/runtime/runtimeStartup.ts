import type { GitHubProjectsV2Client } from "../github/githubProjectsV2.js";
import { ensureProjectBoardsForRegistry } from "../projects/projectBoards.js";
import {
  ensureProjectRegistry,
  type DefaultProjectContext,
} from "../projects/projectRegistry.js";
import {
  runDiscordOperatorControlStartupCheck,
  startDiscordGracefulShutdownListener,
  type DiscordControlHandlers,
  type DiscordGracefulShutdownListener,
} from "./operatorControl.js";
import { writeRuntimeReadinessSignal } from "./runtimeReadiness.js";

export async function signalRestartReadinessIfRequested(workDir: string): Promise<void> {
  const token = process.env.EVOLVO_RESTART_TOKEN?.trim();
  if (!token) {
    return;
  }

  const signalPathOverride = process.env.EVOLVO_READINESS_FILE?.trim();
  const signalPath = await writeRuntimeReadinessSignal({
    workDir,
    token,
    signalPath: signalPathOverride || undefined,
  });
  console.log(`[startup] Runtime readiness signal written: ${signalPath}`);
}

export async function runRuntimeStartup(options: {
  workDir: string;
  githubOwner: string;
  githubRepo: string;
  defaultProjectContext: DefaultProjectContext;
  projectsClient: GitHubProjectsV2Client;
  discordHandlers: DiscordControlHandlers;
}): Promise<DiscordGracefulShutdownListener | null> {
  console.log(`Hello from ${options.githubOwner}/${options.githubRepo}!`);
  console.log(`Working directory: ${options.workDir}`);
  await ensureProjectRegistry(options.workDir, options.defaultProjectContext);
  const boardProvisioning = await ensureProjectBoardsForRegistry({
    workDir: options.workDir,
    defaultProject: options.defaultProjectContext,
    boardsClient: options.projectsClient,
  });
  for (const result of boardProvisioning.results) {
    if (result.ok) {
      console.log(
        `[project-board] ensured ${result.project.slug} board ${result.project.workflow.boardUrl ?? "unknown-url"}.`,
      );
    } else {
      console.error(
        `[project-board] failed to ensure board for ${result.project.slug}: ${result.message}`,
      );
    }
  }
  await signalRestartReadinessIfRequested(options.workDir);
  await runDiscordOperatorControlStartupCheck();
  return startDiscordGracefulShutdownListener(options.workDir, options.discordHandlers);
}
