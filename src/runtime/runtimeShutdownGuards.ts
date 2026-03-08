import {
  markGracefulShutdownRequestEnforced,
  readGracefulShutdownRequest,
  type GracefulShutdownRequest,
} from "./gracefulShutdown.js";
import {
  notifyRuntimeQuittingInDiscord,
  pollDiscordGracefulShutdownCommand,
  type DiscordControlHandlers,
} from "./operatorControl.js";

function buildGracefulShutdownLogMessage(
  request: GracefulShutdownRequest,
  reason: string,
): string {
  return `Graceful shutdown requested via Discord ${request.command}. ${reason} Shutdown intent remains persisted so later restarts do not resume work unexpectedly.`;
}

function buildGracefulShutdownQuitNotificationReason(
  request: GracefulShutdownRequest,
  reason: string,
): string {
  return `Graceful shutdown via ${request.command} is being enforced. ${reason}`;
}

function isQueueDrainGracefulShutdownRequest(request: GracefulShutdownRequest | null): boolean {
  return request?.mode === "after-tasks";
}

function isEnforcedGracefulShutdownRequest(request: GracefulShutdownRequest | null): boolean {
  return request?.enforcedAt !== null;
}

export async function readPendingGracefulShutdownRequest(
  workDir: string,
  discordHandlers: DiscordControlHandlers,
): Promise<GracefulShutdownRequest | null> {
  await pollDiscordGracefulShutdownCommand(workDir, discordHandlers);
  return readGracefulShutdownRequest(workDir);
}

export async function stopIfSingleTaskGracefulShutdownRequested(
  workDir: string,
  reason: string,
  discordHandlers: DiscordControlHandlers,
): Promise<boolean> {
  const request = await readPendingGracefulShutdownRequest(workDir, discordHandlers);
  if (request === null) {
    return false;
  }

  if (isQueueDrainGracefulShutdownRequest(request) && !isEnforcedGracefulShutdownRequest(request)) {
    return false;
  }

  const enforced = await markGracefulShutdownRequestEnforced(workDir);
  const activeRequest = enforced?.request ?? request;
  console.log(buildGracefulShutdownLogMessage(activeRequest, reason));
  await notifyRuntimeQuittingInDiscord(buildGracefulShutdownQuitNotificationReason(activeRequest, reason));
  return true;
}

export async function stopIfGracefulShutdownPreventsNewWork(
  workDir: string,
  reason: string,
  discordHandlers: DiscordControlHandlers,
): Promise<boolean> {
  const request = await readPendingGracefulShutdownRequest(workDir, discordHandlers);
  if (request === null) {
    return false;
  }

  const enforced = await markGracefulShutdownRequestEnforced(workDir);
  const shutdownReason = isQueueDrainGracefulShutdownRequest(request)
    ? "Queue-drain shutdown is active. Planning and replenishment are disabled, so no new work will be started."
    : reason;
  const activeRequest = enforced?.request ?? request;
  console.log(buildGracefulShutdownLogMessage(activeRequest, shutdownReason));
  await notifyRuntimeQuittingInDiscord(buildGracefulShutdownQuitNotificationReason(activeRequest, shutdownReason));
  return true;
}
