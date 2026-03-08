import "dotenv/config";
import { pathToFileURL } from "node:url";
import { runIssueCommand } from "./issues/runIssueCommand.js";
import { DEFAULT_PROMPT as LOOP_DEFAULT_PROMPT } from "./runtime/loopUtils.js";
import { runRuntimeApp } from "./runtime/runRuntimeApp.js";
import { parseWorkflowRuntimeCommand } from "./runtime/workers/workerCli.js";
import { runWorkflowWorkerCommand } from "./runtime/workers/runWorkflowWorker.js";

export const DEFAULT_PROMPT = LOOP_DEFAULT_PROMPT;

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const runtimeCommand = parseWorkflowRuntimeCommand(args);
  if (runtimeCommand?.kind === "worker") {
    await runWorkflowWorkerCommand({
      role: runtimeCommand.role,
      projectSlug: runtimeCommand.projectSlug,
    });
    return;
  }

  const issueCommandHandled = await runIssueCommand(args);
  if (issueCommandHandled) {
    return;
  }

  const { GITHUB_OWNER, GITHUB_REPO } = await import("./environment.js");
  await runRuntimeApp({
    githubOwner: GITHUB_OWNER,
    githubRepo: GITHUB_REPO,
  });
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  main().catch((error) => {
    console.error("Error in main execution:", error);
  }).finally(() => {
    console.log("Execution finished.");
  });
}
