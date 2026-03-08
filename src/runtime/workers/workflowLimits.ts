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

export type WorkflowLimitConfig = {
  ideaStageTargetPerProject: number;
  issueGeneratorMaxIssuesPerProject: number;
  planningLimitPerProject: number;
  readyForDevLimitPerProject: number;
  inDevLimitPerProject: number;
};

export function getWorkflowLimitConfig(): WorkflowLimitConfig {
  return {
    ideaStageTargetPerProject: parsePositiveIntegerEnv("EVOLVO_IDEA_STAGE_TARGET_PER_PROJECT", 5),
    issueGeneratorMaxIssuesPerProject: parsePositiveIntegerEnv("EVOLVO_ISSUE_GENERATOR_MAX_ISSUES_PER_PROJECT", 5),
    planningLimitPerProject: parsePositiveIntegerEnv("EVOLVO_PLANNING_LIMIT_PER_PROJECT", 5),
    readyForDevLimitPerProject: parsePositiveIntegerEnv("EVOLVO_READY_FOR_DEV_LIMIT_PER_PROJECT", 3),
    inDevLimitPerProject: parsePositiveIntegerEnv("EVOLVO_IN_DEV_LIMIT_PER_PROJECT", 1),
  };
}