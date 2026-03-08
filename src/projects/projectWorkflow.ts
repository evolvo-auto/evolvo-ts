export const PROJECT_WORKFLOW_STAGES = [
  "Inbox",
  "Planning",
  "Ready for Dev",
  "In Dev",
  "Ready for Review",
  "In Review",
  "Ready for Release",
  "Releasing",
  "Blocked",
  "Done",
] as const;

export type ProjectWorkflowStage = (typeof PROJECT_WORKFLOW_STAGES)[number];

export type ProjectWorkflowStageOptionIds = Partial<Record<ProjectWorkflowStage, string>>;

export type ProjectWorkflow = {
  boardOwner: string | null;
  boardNumber: number | null;
  boardId: string | null;
  boardUrl: string | null;
  stageFieldId: string | null;
  stageOptionIds: ProjectWorkflowStageOptionIds;
  boardProvisioned: boolean;
  lastError: string | null;
  lastSyncedAt: string | null;
};

export function createDefaultProjectWorkflow(boardOwner: string | null = null): ProjectWorkflow {
  return {
    boardOwner: boardOwner?.trim() || null,
    boardNumber: null,
    boardId: null,
    boardUrl: null,
    stageFieldId: null,
    stageOptionIds: {},
    boardProvisioned: false,
    lastError: null,
    lastSyncedAt: null,
  };
}

export function normalizeProjectWorkflowStage(value: unknown): ProjectWorkflowStage | null {
  if (typeof value !== "string") {
    return null;
  }

  return PROJECT_WORKFLOW_STAGES.includes(value as ProjectWorkflowStage)
    ? (value as ProjectWorkflowStage)
    : null;
}
