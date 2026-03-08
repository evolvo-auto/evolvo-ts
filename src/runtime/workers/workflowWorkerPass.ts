import { GITHUB_OWNER, GITHUB_REPO } from "../../environment.js";
import { createRuntimeServices } from "../runtimeServices.js";
import { buildWorkerId, type WorkerRole } from "./workerTypes.js";
import { buildWorkerInventory } from "./boardQueries.js";
import { runDevWorkerPass } from "./devWorker.js";
import { runIssueGeneratorWorkerPass } from "./issueGeneratorWorker.js";
import { runPlannerWorkerPass } from "./plannerWorker.js";
import { runReleaseWorkerPass } from "./releaseWorker.js";
import { runReviewWorkerPass } from "./reviewWorker.js";

export async function runWorkflowWorkerPass(options: {
  workDir: string;
  role: WorkerRole;
  projectSlug: string | null;
  workerId?: string;
}): Promise<boolean> {
  const workerId = options.workerId ?? buildWorkerId({ role: options.role, projectSlug: options.projectSlug });
  const services = createRuntimeServices({
    githubOwner: GITHUB_OWNER,
    githubRepo: GITHUB_REPO,
    workDir: options.workDir,
  });
  const inventory = await buildWorkerInventory({
    workDir: options.workDir,
    defaultProject: services.defaultProjectContext,
    trackerIssueManager: services.issueManager,
    boardsClient: services.projectsClient,
  });

  switch (options.role) {
    case "issue-generator":
      return (await runIssueGeneratorWorkerPass({
        inventory,
        trackerIssueManager: services.issueManager,
        boardsClient: services.projectsClient,
      })) > 0;

    case "review":
      return runReviewWorkerPass({
        workDir: options.workDir,
        workerId,
        inventory,
        boardsClient: services.projectsClient,
        pullRequestClient: services.pullRequestClient,
      });

    case "release":
      return runReleaseWorkerPass({
        workDir: options.workDir,
        workerId,
        inventory,
        boardsClient: services.projectsClient,
        trackerIssueManager: services.issueManager,
      });

    case "planner":
      return await runPlannerWorkerPass({
        workDir: options.workDir,
        inventory,
        trackerIssueManager: services.issueManager,
        boardsClient: services.projectsClient,
      }).then((summary) => summary.movedToPlanning > 0 || summary.movedToReadyForDev > 0 || summary.blocked > 0);

    case "dev":
      return options.projectSlug
        ? runDevWorkerPass({
          workDir: options.workDir,
          workerId,
          projectSlug: options.projectSlug,
          inventory,
          boardsClient: services.projectsClient,
        })
        : false;
  }
}