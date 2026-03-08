import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  readRecoverableJsonState,
  type RecoverableJsonStateNormalizationResult,
} from "./localStateFile.js";

const EVOLVO_DIRECTORY_NAME = ".evolvo";
const LIFECYCLE_STATE_FILE_NAME = "runtime-lifecycle-state.json";
const LIFECYCLE_STATE_VERSION = 1;
const MAX_HISTORY_ENTRIES = 25;

export const CANONICAL_LIFECYCLE_STATES = [
  "selected",
  "executing",
  "under_review",
  "accepted",
  "amended",
  "rejected",
  "committed",
  "pr_opened",
  "merged",
  "restarted",
  "completed",
  "failed",
  "blocked",
] as const;

export type CanonicalLifecycleState = typeof CANONICAL_LIFECYCLE_STATES[number];
export type LifecycleEntityKind = "issue" | "challenge";

export type LifecycleDerivedState = {
  issueState: "open" | "closed";
  labels: string[];
  isChallenge: boolean;
  reviewOutcome: string | null;
  pullRequestCreated: boolean | null;
  mergedPullRequest: boolean | null;
};

export type CanonicalLifecycleEntry = {
  issueNumber: number;
  kind: LifecycleEntityKind;
  state: CanonicalLifecycleState;
  updatedAt: string;
  transitionCount: number;
  history: Array<{
    from: CanonicalLifecycleState | null;
    to: CanonicalLifecycleState;
    at: string;
    reason: string | null;
    runCycle: number | null;
  }>;
};

type LifecycleStateStore = {
  version: number;
  issues: Record<string, CanonicalLifecycleEntry>;
};

export type TransitionLifecycleInput = {
  issueNumber: number;
  kind: LifecycleEntityKind;
  nextState: CanonicalLifecycleState;
  reason?: string;
  runCycle?: number;
  atMs?: number;
};

export type TransitionLifecycleResult = {
  ok: boolean;
  issueNumber: number;
  previousState: CanonicalLifecycleState | null;
  entry: CanonicalLifecycleEntry | null;
  message: string;
};

const ALLOWED_TRANSITIONS: Record<CanonicalLifecycleState | "none", Set<CanonicalLifecycleState>> = {
  none: new Set(["selected", "blocked", "failed"]),
  selected: new Set(["selected", "executing", "blocked", "failed"]),
  executing: new Set(["selected", "under_review", "failed", "blocked"]),
  under_review: new Set(["selected", "accepted", "amended", "rejected", "failed", "blocked"]),
  accepted: new Set(["selected", "committed", "pr_opened", "merged", "restarted", "completed", "failed"]),
  amended: new Set(["selected", "executing", "under_review", "failed", "blocked"]),
  rejected: new Set(["selected", "executing", "under_review", "failed", "blocked"]),
  committed: new Set(["selected", "pr_opened", "merged", "failed"]),
  pr_opened: new Set(["selected", "merged", "failed", "rejected"]),
  merged: new Set(["selected", "restarted", "completed", "failed"]),
  restarted: new Set(["selected", "completed", "failed"]),
  completed: new Set(["selected", "failed"]),
  failed: new Set(["selected", "executing", "under_review", "blocked", "failed"]),
  blocked: new Set(["selected", "executing", "failed", "blocked"]),
};

function toFinitePositiveInteger(value: unknown): number | null {
  const asNumber = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(asNumber) || asNumber <= 0) {
    return null;
  }

  return Math.floor(asNumber);
}

function isCanonicalLifecycleState(value: unknown): value is CanonicalLifecycleState {
  return typeof value === "string" && (CANONICAL_LIFECYCLE_STATES as readonly string[]).includes(value);
}

function getStatePath(workDir: string): string {
  return join(workDir, EVOLVO_DIRECTORY_NAME, LIFECYCLE_STATE_FILE_NAME);
}

function createDefaultStateStore(): LifecycleStateStore {
  return {
    version: LIFECYCLE_STATE_VERSION,
    issues: {},
  };
}

function normalizeStateStore(raw: unknown): RecoverableJsonStateNormalizationResult<LifecycleStateStore> {
  if (typeof raw !== "object" || raw === null) {
    return {
      state: createDefaultStateStore(),
      recoveredInvalid: true,
    };
  }

  const candidate = raw as Partial<LifecycleStateStore>;
  let recoveredInvalid = candidate.version !== LIFECYCLE_STATE_VERSION;
  if (candidate.issues !== undefined && (typeof candidate.issues !== "object" || candidate.issues === null)) {
    recoveredInvalid = true;
  }
  const entries = Object.entries(candidate.issues ?? {});
  const issues = Object.fromEntries(
    entries.flatMap(([issueKey, value]) => {
      if (typeof value !== "object" || value === null) {
        recoveredInvalid = true;
        return [];
      }

      const issueNumber = toFinitePositiveInteger((value as Partial<CanonicalLifecycleEntry>).issueNumber ?? issueKey);
      const state = (value as Partial<CanonicalLifecycleEntry>).state;
      if (issueNumber === null || !isCanonicalLifecycleState(state)) {
        recoveredInvalid = true;
        return [];
      }

      const kindRaw = (value as Partial<CanonicalLifecycleEntry>).kind;
      const kind = kindRaw === "challenge" ? "challenge" : "issue";
      if (kindRaw !== undefined && kindRaw !== "challenge" && kindRaw !== "issue") {
        recoveredInvalid = true;
      }
      const transitionCountRaw = toFinitePositiveInteger((value as Partial<CanonicalLifecycleEntry>).transitionCount);
      if ((value as Partial<CanonicalLifecycleEntry>).transitionCount !== undefined && transitionCountRaw === null) {
        recoveredInvalid = true;
      }
      const transitionCount = transitionCountRaw ?? 1;
      const updatedAtRaw = (value as Partial<CanonicalLifecycleEntry>).updatedAt;
      const updatedAt = typeof updatedAtRaw === "string" && updatedAtRaw.trim().length > 0
        ? updatedAtRaw
        : new Date(0).toISOString();
      if (updatedAtRaw !== undefined && updatedAtRaw !== updatedAt) {
        recoveredInvalid = true;
      }
      const historyRaw = (value as Partial<CanonicalLifecycleEntry>).history;
      const history = Array.isArray(historyRaw)
        ? historyRaw.map((historyItem) => {
            if (typeof historyItem !== "object" || historyItem === null) {
              recoveredInvalid = true;
              return null;
            }

            const fromRaw = (historyItem as { from?: unknown }).from;
            const from = fromRaw === null || isCanonicalLifecycleState(fromRaw) ? fromRaw : null;
            if (fromRaw !== undefined && fromRaw !== null && !isCanonicalLifecycleState(fromRaw)) {
              recoveredInvalid = true;
            }
            const toRaw = (historyItem as { to?: unknown }).to;
            if (!isCanonicalLifecycleState(toRaw)) {
              recoveredInvalid = true;
              return null;
            }

            const atRaw = (historyItem as { at?: unknown }).at;
            const reasonRaw = (historyItem as { reason?: unknown }).reason;
            const runCycleRaw = toFinitePositiveInteger((historyItem as { runCycle?: unknown }).runCycle);
            const runCycleSource = (historyItem as { runCycle?: unknown }).runCycle;
            if (runCycleSource !== undefined && runCycleSource !== null && runCycleRaw === null) {
              recoveredInvalid = true;
            }
            if (atRaw !== undefined && (typeof atRaw !== "string" || atRaw.trim().length === 0)) {
              recoveredInvalid = true;
            }
            if (reasonRaw !== undefined && reasonRaw !== null && (typeof reasonRaw !== "string" || reasonRaw.trim().length === 0)) {
              recoveredInvalid = true;
            }
            return {
              from,
              to: toRaw,
              at: typeof atRaw === "string" && atRaw.trim().length > 0 ? atRaw : new Date(0).toISOString(),
              reason: typeof reasonRaw === "string" && reasonRaw.trim().length > 0 ? reasonRaw.trim() : null,
              runCycle: runCycleRaw,
            };
          })
          .filter((item): item is CanonicalLifecycleEntry["history"][number] => item !== null)
          .slice(-MAX_HISTORY_ENTRIES)
        : [];
      if (historyRaw !== undefined && !Array.isArray(historyRaw)) {
        recoveredInvalid = true;
      }

      return [[String(issueNumber), {
        issueNumber,
        kind,
        state,
        updatedAt,
        transitionCount,
        history,
      } satisfies CanonicalLifecycleEntry] as const];
    }),
  );

  return {
    state: {
      version: LIFECYCLE_STATE_VERSION,
      issues,
    },
    recoveredInvalid,
  };
}

export async function readCanonicalLifecycleState(workDir: string): Promise<LifecycleStateStore> {
  return readRecoverableJsonState({
    statePath: getStatePath(workDir),
    createDefaultState: createDefaultStateStore,
    normalizeState: normalizeStateStore,
    warningLabel: "lifecycle state store",
  });
}

async function writeCanonicalLifecycleState(workDir: string, state: LifecycleStateStore): Promise<void> {
  await fs.mkdir(join(workDir, EVOLVO_DIRECTORY_NAME), { recursive: true });
  await fs.writeFile(getStatePath(workDir), `${JSON.stringify(normalizeStateStore(state).state, null, 2)}\n`, "utf8");
}

export async function transitionCanonicalLifecycleState(
  workDir: string,
  input: TransitionLifecycleInput,
): Promise<TransitionLifecycleResult> {
  const issueNumber = toFinitePositiveInteger(input.issueNumber);
  if (issueNumber === null) {
    return {
      ok: false,
      issueNumber: 0,
      previousState: null,
      entry: null,
      message: "Issue number must be a positive integer.",
    };
  }

  const stateStore = await readCanonicalLifecycleState(workDir);
  const issueKey = String(issueNumber);
  const current = stateStore.issues[issueKey] ?? null;
  const previousState = current?.state ?? null;
  const allowed = ALLOWED_TRANSITIONS[previousState ?? "none"];
  if (!allowed.has(input.nextState)) {
    return {
      ok: false,
      issueNumber,
      previousState,
      entry: current,
      message: `Invalid lifecycle transition: ${previousState ?? "none"} -> ${input.nextState}.`,
    };
  }

  const reason = typeof input.reason === "string" && input.reason.trim().length > 0 ? input.reason.trim() : null;
  const runCycle = toFinitePositiveInteger(input.runCycle);
  const now = new Date(typeof input.atMs === "number" && Number.isFinite(input.atMs) ? input.atMs : Date.now()).toISOString();
  const nextEntry: CanonicalLifecycleEntry = {
    issueNumber,
    kind: input.kind,
    state: input.nextState,
    updatedAt: now,
    transitionCount: (current?.transitionCount ?? 0) + 1,
    history: [
      ...(current?.history ?? []),
      {
        from: previousState,
        to: input.nextState,
        at: now,
        reason,
        runCycle,
      },
    ].slice(-MAX_HISTORY_ENTRIES),
  };

  stateStore.issues[issueKey] = nextEntry;
  await writeCanonicalLifecycleState(workDir, stateStore);
  return {
    ok: true,
    issueNumber,
    previousState,
    entry: nextEntry,
    message: previousState === null
      ? `Lifecycle initialized at ${input.nextState}.`
      : `Lifecycle transitioned ${previousState} -> ${input.nextState}.`,
  };
}

export function buildLifecycleStateComment(options: {
  issueNumber: number;
  currentState: CanonicalLifecycleState;
  previousState: CanonicalLifecycleState | null;
  kind: LifecycleEntityKind;
  reason: string;
  derived: LifecycleDerivedState;
}): string {
  const transitionLabel = options.previousState === null
    ? `none -> ${options.currentState}`
    : `${options.previousState} -> ${options.currentState}`;
  const labels = options.derived.labels.length > 0 ? options.derived.labels.map((label) => `\`${label}\``).join(", ") : "(none)";

  return [
    "## Canonical Lifecycle State",
    `- Scope: issue #${options.issueNumber} (${options.kind}).`,
    `- Canonical state: \`${options.currentState}\`.`,
    `- Transition: \`${transitionLabel}\`.`,
    `- Transition reason: ${options.reason}.`,
    "",
    "### Derived Runtime Signals",
    `- GitHub issue state: \`${options.derived.issueState}\`.`,
    `- Labels snapshot: ${labels}.`,
    `- Challenge issue: ${options.derived.isChallenge ? "yes" : "no"}.`,
    `- Review outcome signal: ${options.derived.reviewOutcome ?? "unknown"}.`,
    `- PR created signal: ${options.derived.pullRequestCreated === null ? "unknown" : options.derived.pullRequestCreated ? "yes" : "no"}.`,
    `- PR merged signal: ${options.derived.mergedPullRequest === null ? "unknown" : options.derived.mergedPullRequest ? "yes" : "no"}.`,
    "",
    "### Presentation Note",
    "- This comment is a human-facing snapshot; canonical state is persisted in `.evolvo/runtime-lifecycle-state.json`.",
  ].join("\n");
}
