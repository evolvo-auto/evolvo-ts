import { join } from "node:path";
import { readRecoverableJsonState, writeAtomicJsonState } from "./localStateFile.js";
import type { CommandExecutionSummary } from "../agents/runCodingAgent.js";

const WORKFLOW_WORK_ITEM_STATE_FILE_NAME = "workflow-work-items.json";
const WORKFLOW_WORK_ITEM_STATE_VERSION = 1;

export type WorkflowWorkItemRecord = {
  queueKey: string;
  projectSlug: string;
  issueNumber: number;
  branchName: string | null;
  pullRequestUrl: string | null;
  validationCommands: CommandExecutionSummary[];
  failedValidationCommands: CommandExecutionSummary[];
  implementationSummary: string | null;
  reviewOutcome: "approved" | "rejected" | null;
  reviewSummary: string | null;
  updatedAt: string;
};

type WorkflowWorkItemState = {
  version: typeof WORKFLOW_WORK_ITEM_STATE_VERSION;
  items: WorkflowWorkItemRecord[];
};

function createDefaultState(): WorkflowWorkItemState {
  return {
    version: WORKFLOW_WORK_ITEM_STATE_VERSION,
    items: [],
  };
}

function normalizeNullableString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeCommandExecutionSummary(value: unknown): CommandExecutionSummary | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<CommandExecutionSummary>;
  const command = typeof candidate.command === "string" ? candidate.command : null;
  const commandName = typeof candidate.commandName === "string" ? candidate.commandName : null;
  const exitCode = candidate.exitCode === null || typeof candidate.exitCode === "number" ? candidate.exitCode : null;
  const durationMs = candidate.durationMs === null || typeof candidate.durationMs === "number" ? candidate.durationMs : null;
  if (!command || !commandName) {
    return null;
  }

  return {
    command,
    commandName,
    exitCode,
    durationMs,
  };
}

function normalizeRecord(value: unknown): WorkflowWorkItemRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<WorkflowWorkItemRecord>;
  const queueKey = normalizeNullableString(candidate.queueKey);
  const projectSlug = normalizeNullableString(candidate.projectSlug);
  const issueNumber = typeof candidate.issueNumber === "number" && Number.isInteger(candidate.issueNumber)
    ? candidate.issueNumber
    : null;
  const updatedAt = normalizeNullableString(candidate.updatedAt);
  if (!queueKey || !projectSlug || issueNumber === null || !updatedAt) {
    return null;
  }

  return {
    queueKey,
    projectSlug,
    issueNumber,
    branchName: normalizeNullableString(candidate.branchName),
    pullRequestUrl: normalizeNullableString(candidate.pullRequestUrl),
    validationCommands: Array.isArray(candidate.validationCommands)
      ? candidate.validationCommands
        .map((entry) => normalizeCommandExecutionSummary(entry))
        .filter((entry): entry is CommandExecutionSummary => entry !== null)
      : [],
    failedValidationCommands: Array.isArray(candidate.failedValidationCommands)
      ? candidate.failedValidationCommands
        .map((entry) => normalizeCommandExecutionSummary(entry))
        .filter((entry): entry is CommandExecutionSummary => entry !== null)
      : [],
    implementationSummary: normalizeNullableString(candidate.implementationSummary),
    reviewOutcome: candidate.reviewOutcome === "approved" || candidate.reviewOutcome === "rejected"
      ? candidate.reviewOutcome
      : null,
    reviewSummary: normalizeNullableString(candidate.reviewSummary),
    updatedAt,
  };
}

function normalizeState(raw: unknown): { state: WorkflowWorkItemState; recoveredInvalid: boolean } {
  if (!raw || typeof raw !== "object" || (raw as { version?: unknown }).version !== WORKFLOW_WORK_ITEM_STATE_VERSION) {
    return {
      state: createDefaultState(),
      recoveredInvalid: true,
    };
  }

  const candidate = raw as Partial<WorkflowWorkItemState>;
  if (!Array.isArray(candidate.items)) {
    return {
      state: createDefaultState(),
      recoveredInvalid: true,
    };
  }

  return {
    state: {
      version: WORKFLOW_WORK_ITEM_STATE_VERSION,
      items: candidate.items
        .map((entry) => normalizeRecord(entry))
        .filter((entry): entry is WorkflowWorkItemRecord => entry !== null),
    },
    recoveredInvalid: false,
  };
}

function getStatePath(workDir: string): string {
  return join(workDir, ".evolvo", WORKFLOW_WORK_ITEM_STATE_FILE_NAME);
}

async function readState(workDir: string): Promise<WorkflowWorkItemState> {
  return readRecoverableJsonState({
    statePath: getStatePath(workDir),
    createDefaultState,
    normalizeState,
    warningLabel: "workflow work item state",
  });
}

export async function listWorkflowWorkItemRecords(workDir: string): Promise<WorkflowWorkItemRecord[]> {
  return (await readState(workDir)).items;
}

export async function getWorkflowWorkItemRecord(
  workDir: string,
  queueKey: string,
): Promise<WorkflowWorkItemRecord | null> {
  const state = await readState(workDir);
  return state.items.find((item) => item.queueKey === queueKey) ?? null;
}

export async function upsertWorkflowWorkItemRecord(
  workDir: string,
  record: WorkflowWorkItemRecord,
): Promise<WorkflowWorkItemRecord> {
  const state = await readState(workDir);
  const nextState: WorkflowWorkItemState = {
    version: WORKFLOW_WORK_ITEM_STATE_VERSION,
    items: [
      ...state.items.filter((item) => item.queueKey !== record.queueKey),
      record,
    ].sort((left, right) => left.queueKey.localeCompare(right.queueKey)),
  };
  await writeAtomicJsonState(getStatePath(workDir), nextState);
  return record;
}
