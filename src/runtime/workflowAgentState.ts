import { join } from "node:path";
import { readRecoverableJsonState, writeAtomicJsonState } from "./localStateFile.js";

const WORKFLOW_AGENT_STATE_FILE_NAME = "workflow-agent-state.json";
const WORKFLOW_AGENT_STATE_VERSION = 1;

export type WorkflowAgentState = {
  version: typeof WORKFLOW_AGENT_STATE_VERSION;
  reviewCursorProjectSlug: string | null;
  releaseCursorProjectSlug: string | null;
};

function createDefaultWorkflowAgentState(): WorkflowAgentState {
  return {
    version: WORKFLOW_AGENT_STATE_VERSION,
    reviewCursorProjectSlug: null,
    releaseCursorProjectSlug: null,
  };
}

function normalizeNullableString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeWorkflowAgentState(raw: unknown): { state: WorkflowAgentState; recoveredInvalid: boolean } {
  if (typeof raw !== "object" || raw === null) {
    return {
      state: createDefaultWorkflowAgentState(),
      recoveredInvalid: true,
    };
  }

  const candidate = raw as Partial<WorkflowAgentState>;
  if ((raw as { version?: unknown }).version !== WORKFLOW_AGENT_STATE_VERSION) {
    return {
      state: createDefaultWorkflowAgentState(),
      recoveredInvalid: true,
    };
  }

  return {
    state: {
      version: WORKFLOW_AGENT_STATE_VERSION,
      reviewCursorProjectSlug: normalizeNullableString(candidate.reviewCursorProjectSlug),
      releaseCursorProjectSlug: normalizeNullableString(candidate.releaseCursorProjectSlug),
    },
    recoveredInvalid: false,
  };
}

function getWorkflowAgentStatePath(workDir: string): string {
  return join(workDir, ".evolvo", WORKFLOW_AGENT_STATE_FILE_NAME);
}

export async function readWorkflowAgentState(workDir: string): Promise<WorkflowAgentState> {
  return readRecoverableJsonState({
    statePath: getWorkflowAgentStatePath(workDir),
    createDefaultState: createDefaultWorkflowAgentState,
    normalizeState: normalizeWorkflowAgentState,
    warningLabel: "workflow agent state",
  });
}

export async function updateWorkflowAgentState(
  workDir: string,
  update: Partial<Pick<WorkflowAgentState, "reviewCursorProjectSlug" | "releaseCursorProjectSlug">>,
): Promise<WorkflowAgentState> {
  const currentState = await readWorkflowAgentState(workDir);
  const nextState: WorkflowAgentState = {
    ...currentState,
    reviewCursorProjectSlug: update.reviewCursorProjectSlug === undefined
      ? currentState.reviewCursorProjectSlug
      : normalizeNullableString(update.reviewCursorProjectSlug),
    releaseCursorProjectSlug: update.releaseCursorProjectSlug === undefined
      ? currentState.releaseCursorProjectSlug
      : normalizeNullableString(update.releaseCursorProjectSlug),
  };
  await writeAtomicJsonState(getWorkflowAgentStatePath(workDir), nextState);
  return nextState;
}
