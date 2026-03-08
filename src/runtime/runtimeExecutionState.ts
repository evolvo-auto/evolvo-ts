import type { RuntimeStatusIssue, RuntimeStatusState } from "./runtimeStatus.js";

export type RuntimeExecutionState = {
  runtimeStatusState: RuntimeStatusState;
  runtimeStatusActivitySummary: string;
  runtimeStatusCycle: number | null;
  runtimeStatusCycleLimit: number | null;
  runtimeStatusIssue: RuntimeStatusIssue | null;
};

export function createInitialRuntimeExecutionState(initialCycleLimit: number): RuntimeExecutionState {
  return {
    runtimeStatusState: "starting",
    runtimeStatusActivitySummary: "Starting runtime.",
    runtimeStatusCycle: null,
    runtimeStatusCycleLimit: initialCycleLimit,
    runtimeStatusIssue: null,
  };
}
