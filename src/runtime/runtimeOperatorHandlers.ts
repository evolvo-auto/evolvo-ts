import {
  activateProjectInState,
  deactivateProjectInState,
  readActiveProjectsState,
} from "../projects/activeProjectsState.js";
import { readProjectActivityState, setProjectActivityMode } from "../projects/projectActivityState.js";
import {
  handleStartProjectCommand,
} from "../projects/projectProvisioning.js";
import {
  findProjectBySlug,
  readProjectRegistry,
  type DefaultProjectContext,
} from "../projects/projectRegistry.js";
import {
  buildRuntimeStatusSnapshot,
  type RuntimeStatusProject,
  type RuntimeStatusQueueTotals,
  type RuntimeStatusWorker,
} from "./runtimeStatus.js";
import type { TaskIssueManager } from "../issues/taskIssueManager.js";
import { buildStagedWorkInventory } from "../issues/stagedWorkInventory.js";
import type { GitHubProjectsV2Client } from "../github/githubProjectsV2.js";
import { readWorkflowWorkerState } from "./workers/workflowWorkerState.js";
import { getWorkflowLimitConfig } from "./workers/workflowLimits.js";
import type {
  DiscordControlHandlers,
  StatusCommandResult,
  StopProjectCommandResult,
} from "./operatorControl.js";
import type { RuntimeExecutionState } from "./runtimeExecutionState.js";

function buildStopProjectResultLog(result: StopProjectCommandResult): string {
  if (!result.ok) {
    return `[stopProject] failed: ${result.message}`;
  }

  if (result.action === "stopped") {
    return `[stopProject] halted project ${result.project?.displayName ?? result.project?.slug ?? "unknown"}. Runtime remains online.`;
  }

  if (result.action === "stop-when-complete-scheduled") {
    return `[stopProject] project ${result.project?.displayName ?? result.project?.slug ?? "unknown"} will stop automatically when it runs out of actionable work. Evolvo will then return to self-work.`;
  }

  if (result.action === "already-stop-when-complete-scheduled") {
    return `[stopProject] project ${result.project?.displayName ?? result.project?.slug ?? "unknown"} is already scheduled to stop when complete. Evolvo will return to self-work afterward.`;
  }

  if (result.action === "already-stopped") {
    return `[stopProject] project ${result.project?.displayName ?? result.project?.slug ?? "unknown"} was already halted. Runtime remains online.`;
  }

  return "[stopProject] no active project was selected. Runtime remains online.";
}

async function resolveActiveStatusProjects(
  workDir: string,
  defaultProjectContext: DefaultProjectContext,
): Promise<RuntimeStatusProject[]> {
  try {
    const [activeProjectsState, registry] = await Promise.all([
      readActiveProjectsState(workDir),
      readProjectRegistry(workDir, defaultProjectContext),
    ]);

    const managedProjects = activeProjectsState.projects.map((entry) => {
      const projectRecord = findProjectBySlug(registry, entry.slug);
      if (projectRecord !== null) {
        return {
          displayName: projectRecord.displayName,
          slug: projectRecord.slug,
          repository: `${projectRecord.executionRepo.owner}/${projectRecord.executionRepo.repo}`,
        };
      }

      return {
        displayName: entry.slug,
        slug: entry.slug,
        repository: null,
      };
    });
    const defaultProjectRecord = findProjectBySlug(registry, "evolvo");
    const defaultProject: RuntimeStatusProject = defaultProjectRecord !== null
      ? {
        displayName: defaultProjectRecord.displayName,
        slug: defaultProjectRecord.slug,
        repository: `${defaultProjectRecord.executionRepo.owner}/${defaultProjectRecord.executionRepo.repo}`,
      }
      : {
        displayName: "Evolvo",
        slug: "evolvo",
        repository: `${defaultProjectContext.owner}/${defaultProjectContext.repo}`,
      };

    return [defaultProject, ...managedProjects];
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    console.error(`[status] could not resolve active project set: ${message}`);
    return [];
  }
}

export function createDiscordControlHandlers(options: {
  workDir: string;
  trackerOwner: string;
  trackerRepo: string;
  defaultProjectContext: DefaultProjectContext;
  issueManager: TaskIssueManager;
  boardsClient: GitHubProjectsV2Client;
  runtimeState: RuntimeExecutionState;
}): DiscordControlHandlers {
  const buildEmptyQueueTotals = (): RuntimeStatusQueueTotals => ({
    Inbox: 0,
    Planning: 0,
    "Ready for Dev": 0,
    "In Dev": 0,
    "Ready for Review": 0,
    "In Review": 0,
    "Ready for Release": 0,
    Releasing: 0,
    Blocked: 0,
    Done: 0,
  });

  const summarizeWorkers = (workers: Awaited<ReturnType<typeof readWorkflowWorkerState>>["workers"]): RuntimeStatusWorker[] =>
    workers
      .slice()
      .sort((left, right) => left.workerId.localeCompare(right.workerId))
      .map((worker) => ({
        workerId: worker.workerId,
        role: worker.role,
        projectSlug: worker.projectSlug ?? null,
        claim: worker.currentClaim?.issueNumber !== null && worker.currentClaim?.issueNumber !== undefined
          ? `#${worker.currentClaim.issueNumber} ${worker.currentClaim.stage ?? "unknown"}`
          : null,
        restartCount: worker.restartCount,
      }));

  const summarizeQueueTotals = (projects: Awaited<ReturnType<typeof buildStagedWorkInventory>>["projects"]): RuntimeStatusQueueTotals => {
    const totals = buildEmptyQueueTotals();
    for (const project of projects) {
      totals.Inbox += project.countsByStage.Inbox;
      totals.Planning += project.countsByStage.Planning;
      totals["Ready for Dev"] += project.countsByStage["Ready for Dev"];
      totals["In Dev"] += project.countsByStage["In Dev"];
      totals["Ready for Review"] += project.countsByStage["Ready for Review"];
      totals["In Review"] += project.countsByStage["In Review"];
      totals["Ready for Release"] += project.countsByStage["Ready for Release"];
      totals.Releasing += project.countsByStage.Releasing;
      totals.Blocked += project.countsByStage.Blocked;
      totals.Done += project.countsByStage.Done;
    }
    return totals;
  };

  return {
    onListRegisteredProjects: async () => {
      const registry = await readProjectRegistry(options.workDir, options.defaultProjectContext);
      return registry.projects.map((project) => ({
        slug: project.slug,
        displayName: project.displayName,
        status: project.status,
      }));
    },
    onStartProject: async (request) => {
      const registry = await readProjectRegistry(options.workDir, options.defaultProjectContext);
      const existingProject = findProjectBySlug(registry, request.slug);
      if (existingProject === null) {
        const message = `Project \`${request.slug || request.displayName}\` is not registered. Select a registered project with \`/startproject existing\`.`;
        console.error(`[startProject] failed for ${request.displayName}: ${message}`);
        return {
          ok: false,
          message,
        };
      }
      const result = await handleStartProjectCommand({
        issueManager: options.issueManager,
        workDir: options.workDir,
        trackerOwner: options.trackerOwner,
        trackerRepo: options.trackerRepo,
        projectName: existingProject.displayName,
        requestedBy: request.requestedBy,
        requestedAt: request.requestedAt,
        allowCreateIfMissing: false,
      });
      if (result.ok && result.action === "created") {
        const message = `Project \`${existingProject.slug}\` is not eligible for creation via \`startProject\`. Select a registered project with \`/startproject existing\`.`;
        console.error(`[startProject] rejected unexpected create result for ${request.displayName}: ${message}`);
        return {
          ok: false,
          message,
        };
      }
      if (result.ok) {
        await activateProjectInState({
          workDir: options.workDir,
          slug: result.project.slug,
          requestedBy: request.requestedBy,
          source: "start-project-command",
          updatedAt: request.requestedAt,
        });
        console.log(
          `[startProject] resumed existing project ${result.project.displayName} (${result.project.slug}) with status ${result.project.status} at ${result.project.workspacePath}.`,
        );
        console.log(`[projects] marked ${result.project.slug} as active in the multi-project set.`);
      } else {
        console.error(`[startProject] failed for ${request.displayName}: ${result.message}`);
      }
      return result;
    },
    onStopProject: async (request) => {
      console.log(`[stopProject] received stop request for ${request.projectSlug} from ${request.requestedBy}.`);
      const registry = await readProjectRegistry(options.workDir, options.defaultProjectContext);
      const projectRecord = findProjectBySlug(registry, request.projectSlug);
      if (projectRecord === null) {
        return {
          ok: false,
          message: `Project \`${request.projectName}\` is not registered.`,
        };
      }

      if (projectRecord.slug === "evolvo") {
        return {
          ok: false,
          message: "Stopping the default Evolvo project is not supported yet.",
        };
      }

      const projectActivityState = await readProjectActivityState(options.workDir);
      const currentProjectActivity = projectActivityState.projects.find((entry) => entry.slug === projectRecord.slug) ?? null;
      const activeProjectsState = await readActiveProjectsState(options.workDir);
      const isProjectActive = activeProjectsState.projects.some((entry) => entry.slug === projectRecord.slug);

      let result: StopProjectCommandResult;
      if (currentProjectActivity?.activityState === "stopped" || !isProjectActive) {
        result = {
          ok: true,
          action: "already-stopped",
          message: `Project \`${projectRecord.slug}\` is already halted. Use \`startProject existing <registered-project>\` to resume it later.`,
          project: {
            displayName: projectRecord.displayName,
            slug: projectRecord.slug,
          },
        };
      } else if (request.mode === "when-project-complete") {
        if (currentProjectActivity?.deferredStopMode === "when-project-complete") {
          result = {
            ok: true,
            action: "already-stop-when-complete-scheduled",
            message: `Project \`${projectRecord.slug}\` is already scheduled to stop when it runs out of actionable work.`,
            project: {
              displayName: projectRecord.displayName,
              slug: projectRecord.slug,
            },
          };
        } else {
          await setProjectActivityMode({
            workDir: options.workDir,
            slug: projectRecord.slug,
            activityState: "active",
            deferredStopMode: "when-project-complete",
            requestedBy: request.requestedBy,
            updatedAt: request.requestedAt,
          });
          result = {
            ok: true,
            action: "stop-when-complete-scheduled",
            message: `Project \`${projectRecord.slug}\` will stop automatically when it has no non-terminal board items left.`,
            project: {
              displayName: projectRecord.displayName,
              slug: projectRecord.slug,
            },
          };
        }
      } else {
        await setProjectActivityMode({
          workDir: options.workDir,
          slug: projectRecord.slug,
          activityState: "stopped",
          requestedBy: request.requestedBy,
          updatedAt: request.requestedAt,
        });
        await deactivateProjectInState(options.workDir, projectRecord.slug);
        console.log(`[projects] removed ${projectRecord.slug} from the multi-project active set.`);
        result = {
          ok: true,
          action: "stopped",
          message: `Project \`${projectRecord.slug}\` will not be scheduled again until \`startProject existing <registered-project>\` is used.`,
          project: {
            displayName: projectRecord.displayName,
            slug: projectRecord.slug,
          },
        };
      }

      console.log(buildStopProjectResultLog(result));
      return result;
    },
    onStatus: async (request): Promise<StatusCommandResult> => {
      const [activeProjects, registry, projectActivityState, workerState, inventory] = await Promise.all([
        resolveActiveStatusProjects(options.workDir, options.defaultProjectContext),
        readProjectRegistry(options.workDir, options.defaultProjectContext),
        readProjectActivityState(options.workDir),
        readWorkflowWorkerState(options.workDir),
        buildStagedWorkInventory({
          workDir: options.workDir,
          defaultProject: options.defaultProjectContext,
          trackerIssueManager: options.issueManager,
          boardsClient: options.boardsClient,
        }).catch((error) => {
          const message = error instanceof Error ? error.message : "unknown error";
          console.error(`[status] could not build staged work inventory: ${message}`);
          return { projects: [], activityState: { version: 1, projects: [] } };
        }),
      ]);
      const leasedProjectSlug = projectActivityState.projects.find((entry) => entry.currentCodingLease !== null)?.slug
        ?? projectActivityState.projects.find((entry) => entry.activityState === "active" && entry.slug !== "evolvo")?.slug
        ?? projectActivityState.projects.find((entry) => entry.activityState === "active")?.slug
        ?? null;
      const activeProjectRecord = leasedProjectSlug ? findProjectBySlug(registry, leasedProjectSlug) : null;
      const activeProject = activeProjectRecord
        ? {
          displayName: activeProjectRecord.displayName,
          slug: activeProjectRecord.slug,
          repository: `${activeProjectRecord.executionRepo.owner}/${activeProjectRecord.executionRepo.repo}`,
        }
        : null;
      const hasDeferredStop = projectActivityState.projects.some((entry) => entry.deferredStopMode === "when-project-complete");
      const snapshot = buildRuntimeStatusSnapshot({
        runtimeState: options.runtimeState.runtimeStatusState,
        activitySummary: options.runtimeState.runtimeStatusActivitySummary,
        activeProjectState: {
          activeProjectSlug: activeProject?.slug ?? null,
          selectionState: activeProjects.length > 0 ? "active" : null,
          deferredStopMode: hasDeferredStop ? "when-project-complete" : null,
        },
        activeProjects,
        activeProject,
        activeIssue: options.runtimeState.runtimeStatusIssue,
        currentCycle: options.runtimeState.runtimeStatusCycle,
        cycleLimit: options.runtimeState.runtimeStatusCycleLimit,
        queueTotals: summarizeQueueTotals(inventory.projects),
        workers: summarizeWorkers(workerState.workers),
        limits: getWorkflowLimitConfig(),
      });
      console.log(
        `[status] served runtime status to ${request.requestedBy}: state=${snapshot.runtimeState} mode=${snapshot.workMode} project=${snapshot.activeProject?.slug ?? "none"} issue=${snapshot.activeIssue?.number ?? "none"}`,
      );
      return {
        ok: true,
        snapshot,
      };
    },
  };
}
