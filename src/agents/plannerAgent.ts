import { Codex, type ThreadOptions } from "@openai/codex-sdk";
import {
  normalizePlannedIssueComparisonTitle,
  type IssueSummary,
  type PlannedIssueDraft,
  type TaskIssueManager,
} from "../issues/taskIssueManager.js";

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

const codex = new Codex();

const PLANNER_THREAD_OPTIONS: Omit<ThreadOptions, "workingDirectory"> = {
  sandboxMode: "read-only",
  approvalPolicy: "never",
  modelReasoningEffort: "medium",
  networkAccessEnabled: false,
};

const PLANNER_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
        },
        required: ["title", "description"],
        additionalProperties: false,
      },
    },
  },
  required: ["issues"],
  additionalProperties: false,
} as const;

type PlannerResponse = {
  issues: unknown[];
};

function dedupeClosedIssueHistory(issues: IssueSummary[]): IssueSummary[] {
  const seen = new Set<string>();
  const unique: IssueSummary[] = [];

  for (const issue of issues) {
    const key = normalizePlannedIssueComparisonTitle(issue.title);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(issue);
  }

  return unique;
}

function validatePlannedIssueDraft(issue: unknown, index: number): PlannedIssueDraft | null {
  if (!issue || typeof issue !== "object") {
    console.warn(`Planner returned invalid issue draft at index ${index}: expected an object.`);
    return null;
  }

  const draft = issue as { title?: unknown; description?: unknown };
  if (typeof draft.title !== "string" || typeof draft.description !== "string") {
    console.warn(`Planner returned invalid issue draft at index ${index}: title and description must be strings.`);
    return null;
  }

  const title = draft.title.trim();
  const description = draft.description.trim();
  if (!title || !description) {
    console.warn(`Planner returned invalid issue draft at index ${index}: title and description cannot be empty.`);
    return null;
  }

  return { title, description };
}

function dedupePlannedIssues(issues: PlannedIssueDraft[]): PlannedIssueDraft[] {
  const seen = new Set<string>();
  const unique: PlannedIssueDraft[] = [];

  for (const issue of issues) {
    const key = normalizePlannedIssueComparisonTitle(issue.title);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(issue);
  }

  return unique;
}

function parsePlannerResponse(finalResponse: string): PlannedIssueDraft[] {
  const parsed = JSON.parse(finalResponse) as PlannerResponse;
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.issues)) {
    throw new Error("Planner response did not contain an issues array.");
  }

  const validIssues = parsed.issues
    .map((issue, index) => validatePlannedIssueDraft(issue, index))
    .filter((issue): issue is PlannedIssueDraft => issue !== null);
  return dedupePlannedIssues(validIssues);
}

function formatIssueListForPrompt(issues: IssueSummary[]): string {
  if (issues.length === 0) {
    return "- none";
  }

  return issues
    .map((issue) => `- #${issue.number} ${issue.title}`)
    .join("\n");
}

function buildPlannerPrompt(input: PlannerAgentInput, openIssues: IssueSummary[], recentClosedIssues: IssueSummary[]): string {
  const recentClosedIssueHistory = dedupeClosedIssueHistory(recentClosedIssues).slice(0, 25);

  return [
    "Inspect this repository and propose new GitHub issues for Evolvo.",
    "",
    "Requirements:",
    `- Return at most ${input.minimumIssueCount} issues.`,
    "- Each issue must be a small, concrete, repo-specific self-improvement task.",
    "- Base proposals on actual repository evidence, not canned templates.",
    "- Do not create follow-up titles.",
    "- Do not repeat or lightly reword existing open or recently closed issues.",
    "- Prefer reliability, runtime safety, validation quality, planning quality, and operational robustness.",
    "",
    "Current open issues:",
    formatIssueListForPrompt(openIssues),
    "",
    "Recently closed issues:",
    formatIssueListForPrompt(recentClosedIssueHistory),
    "",
    "Return only structured JSON matching the schema.",
  ].join("\n");
}

export async function runPlannerAgent(input: PlannerAgentInput): Promise<PlannerAgentResult> {
  const startupBootstrap = input.cycle === 1 && input.openIssueCount === 0;

  try {
    const openIssues = await input.issueManager.listOpenIssues();
    const recentClosedIssues = await input.issueManager.listRecentClosedIssues();
    const thread = codex.startThread({
      ...PLANNER_THREAD_OPTIONS,
      workingDirectory: input.workDir,
    });
    const plannerPrompt = buildPlannerPrompt(input, openIssues, recentClosedIssues);
    const turn = await thread.run(plannerPrompt, {
      outputSchema: PLANNER_OUTPUT_SCHEMA,
    });
    const plannedIssues = parsePlannerResponse(turn.finalResponse);
    const created = (
      await input.issueManager.createPlannedIssues({
        minimumIssueCount: input.minimumIssueCount,
        maximumOpenIssues: input.maximumOpenIssues,
        issues: plannedIssues,
      })
    ).created;

    return {
      created,
      startupBootstrap,
    };
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Queue repository analysis failed during replenishment planning: ${error.message}`);
    } else {
      console.error("Queue repository analysis failed during replenishment planning with an unknown error.");
    }

    return {
      created: [],
      startupBootstrap,
    };
  }
}
