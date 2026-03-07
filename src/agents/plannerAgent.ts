import type { IssueSummary, TaskIssueManager } from "../issues/taskIssueManager.js";
import { generateStartupIssueTemplates } from "../issues/startupIssueBootstrap.js";
import { bootstrapStartupIssues } from "../runtime/loopUtils.js";

export type PlannerAgentInput = {
  cycle: number;
  openIssueCount: number;
  minimumIssueCount: number;
  maximumOpenIssues: number;
  issueManager: TaskIssueManager;
  workDir: string;
};

export type PlannerAgentResult = {
  created: IssueSummary[];
  startupBootstrap: boolean;
};

export async function runPlannerAgent(input: PlannerAgentInput): Promise<PlannerAgentResult> {
  const startupBootstrap = input.cycle === 1 && input.openIssueCount === 0;
  if (startupBootstrap) {
    return {
      created: await bootstrapStartupIssues(input.issueManager, input.workDir),
      startupBootstrap: true,
    };
  }

  let plannerTemplates:
    | Array<{
      title: string;
      description: string;
    }>
    | undefined;
  try {
    plannerTemplates = await generateStartupIssueTemplates(input.workDir, {
      targetCount: input.minimumIssueCount,
    });
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Queue analysis for replenishment templates failed: ${error.message}`);
    } else {
      console.error("Queue analysis for replenishment templates failed with an unknown error.");
    }
  }

  const created = (
    await input.issueManager.replenishSelfImprovementIssues({
      minimumIssueCount: input.minimumIssueCount,
      maximumOpenIssues: input.maximumOpenIssues,
      ...(plannerTemplates && plannerTemplates.length > 0 ? { templates: plannerTemplates } : {}),
    })
  ).created;

  return {
    created,
    startupBootstrap: false,
  };
}
