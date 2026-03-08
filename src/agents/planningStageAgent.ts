import { extractResponseOutputText } from "./extractResponseOutputText.js";

const OPENAI_RESPONSES_API_URL = "https://api.openai.com/v1/responses";
export const PLANNING_STAGE_OPENAI_MODEL = "gpt-5.4";

export type PlanningStageAction =
  | {
    issueNumber: number;
    decision: "planning";
    title: string;
    description: string;
    splitIssues: Array<{ title: string; description: string }>;
    reasons: string[];
  }
  | {
    issueNumber: number;
    decision: "ready-for-dev";
    title: string;
    description: string;
    splitIssues: Array<{ title: string; description: string }>;
    reasons: string[];
  }
  | {
    issueNumber: number;
    decision: "blocked";
    title: string;
    description: string;
    splitIssues: Array<{ title: string; description: string }>;
    reasons: string[];
  };

type PlanningStageResponse = {
  actions?: unknown;
};

type PlannedIssueTemplate = {
  title: string;
  summary: string;
  scope: string[];
  acceptanceCriteria: string[];
  validation: string[];
};

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean)
    : [];
}

function parsePlannedIssueTemplate(value: unknown): PlannedIssueTemplate | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as {
    title?: unknown;
    summary?: unknown;
    scope?: unknown;
    acceptanceCriteria?: unknown;
    validation?: unknown;
  };
  const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
  const summary = typeof candidate.summary === "string" ? candidate.summary.trim() : "";
  const scope = normalizeStringArray(candidate.scope);
  const acceptanceCriteria = normalizeStringArray(candidate.acceptanceCriteria);
  const validation = normalizeStringArray(candidate.validation);

  if (!title || !summary || scope.length === 0 || acceptanceCriteria.length === 0 || validation.length === 0) {
    return null;
  }

  return {
    title,
    summary,
    scope,
    acceptanceCriteria,
    validation,
  };
}

export function formatPlannedIssueDescription(template: Omit<PlannedIssueTemplate, "title">): string {
  return [
    "Summary",
    template.summary,
    "",
    "Scope",
    ...template.scope.map((entry) => `- ${entry}`),
    "",
    "Acceptance Criteria",
    ...template.acceptanceCriteria.map((entry) => `- ${entry}`),
    "",
    "Validation",
    ...template.validation.map((entry) => `- ${entry}`),
  ].join("\n");
}

function formatIssues(issues: Array<{ number: number; title: string; description: string; stage: string }>): string {
  if (issues.length === 0) {
    return "- none";
  }

  return issues.map((issue) => [
    `- #${issue.number} [${issue.stage}] ${issue.title}`,
    issue.description ? `  ${issue.description}` : "  (no description)",
  ].join("\n")).join("\n");
}

function parsePlanningResponse(finalResponse: string): PlanningStageAction[] {
  const parsed = JSON.parse(finalResponse) as PlanningStageResponse;
  if (!Array.isArray(parsed.actions)) {
    throw new Error("Planning stage response did not include an actions array.");
  }

  const actions: PlanningStageAction[] = [];
  for (const rawAction of parsed.actions) {
    if (!rawAction || typeof rawAction !== "object") {
      continue;
    }

    const action = rawAction as {
      issueNumber?: unknown;
      decision?: unknown;
      issue?: unknown;
      splitIssues?: unknown;
      reasons?: unknown;
    };
    if (typeof action.issueNumber !== "number" || !Number.isInteger(action.issueNumber)) {
      continue;
    }

    const decision = action.decision === "planning" || action.decision === "ready-for-dev" || action.decision === "blocked"
      ? action.decision
      : null;
    const issue = parsePlannedIssueTemplate(action.issue);
    const reasons = Array.isArray(action.reasons)
      ? action.reasons.filter((reason): reason is string => typeof reason === "string").map((reason) => reason.trim()).filter(Boolean)
      : [];
    const splitIssues = Array.isArray(action.splitIssues)
      ? action.splitIssues.flatMap((entry) => {
        const splitTemplate = parsePlannedIssueTemplate(entry);
        return splitTemplate
          ? [{
            title: splitTemplate.title,
            description: formatPlannedIssueDescription(splitTemplate),
          }]
          : [];
      })
      : [];

    if (!decision || !issue) {
      continue;
    }

    actions.push({
      issueNumber: action.issueNumber,
      decision,
      title: issue.title,
      description: formatPlannedIssueDescription(issue),
      splitIssues,
      reasons,
    });
  }

  return actions;
}

function buildPrompt(input: {
  projectSlug: string;
  projectDisplayName: string;
  repository: string;
  maxIssues: number;
  planningIssues: Array<{ number: number; title: string; description: string; stage: string }>;
  openIssueTitles: string[];
  recentClosedIssueTitles: string[];
}): string {
  return [
    `You are Evolvo's global Planner agent for project ${input.projectDisplayName} (${input.projectSlug}).`,
    "You are the only agent allowed to take issues out of Inbox and plan them properly.",
    "Inbox issues must always be clarified, rewritten, or split first, then moved to Planning.",
    "Only issues that are already in Planning may move to Ready for Dev.",
    "You may rewrite issue titles/descriptions to make them implementation-ready.",
    "You may split an issue into multiple smaller issues when needed.",
    "For each issue, return one of: planning, ready-for-dev, or blocked.",
    `Process at most ${input.maxIssues} issues from the supplied Inbox/Planning set.`,
    "Do not review, implement, or release work.",
    "",
    `Repository: ${input.repository}`,
    "",
    "Issues currently in Inbox / Planning:",
    formatIssues(input.planningIssues),
    "",
    "Current open issue titles in the repository:",
    input.openIssueTitles.length > 0 ? input.openIssueTitles.map((title) => `- ${title}`).join("\n") : "- none",
    "",
    "Recently closed issue titles:",
    input.recentClosedIssueTitles.length > 0 ? input.recentClosedIssueTitles.map((title) => `- ${title}`).join("\n") : "- none",
    "",
    "Return strict JSON with an `actions` array.",
    "Each action must include: issueNumber, decision, issue, splitIssues, reasons.",
    "The `issue` object and every entry in `splitIssues` must use this template:",
    "- title: concise implementation-ready issue title",
    "- summary: short plain-English summary of the work",
    "- scope: array of concrete implementation steps or boundaries",
    "- acceptanceCriteria: array of specific acceptance checks",
    "- validation: array of concrete validation commands or checks",
    "The host will render these fields into the final issue description template.",
    'decision must be one of "planning", "ready-for-dev", or "blocked".',
  ].join("\n");
}

export async function runPlanningStageAgent(input: {
  apiKey: string;
  projectSlug: string;
  projectDisplayName: string;
  repository: string;
  maxIssues: number;
  planningIssues: Array<{ number: number; title: string; description: string; stage: string }>;
  openIssueTitles: string[];
  recentClosedIssueTitles: string[];
}): Promise<PlanningStageAction[]> {
  const response = await fetch(OPENAI_RESPONSES_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: PLANNING_STAGE_OPENAI_MODEL,
      input: [
        {
          role: "user",
          content: buildPrompt(input),
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "planning_stage_actions",
          strict: true,
          schema: {
            type: "object",
            properties: {
              actions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    issueNumber: { type: "integer" },
                    decision: { type: "string", enum: ["planning", "ready-for-dev", "blocked"] },
                    issue: {
                      type: "object",
                      properties: {
                        title: { type: "string" },
                        summary: { type: "string" },
                        scope: {
                          type: "array",
                          items: { type: "string" },
                        },
                        acceptanceCriteria: {
                          type: "array",
                          items: { type: "string" },
                        },
                        validation: {
                          type: "array",
                          items: { type: "string" },
                        },
                      },
                      required: ["title", "summary", "scope", "acceptanceCriteria", "validation"],
                      additionalProperties: false,
                    },
                    splitIssues: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          title: { type: "string" },
                          summary: { type: "string" },
                          scope: {
                            type: "array",
                            items: { type: "string" },
                          },
                          acceptanceCriteria: {
                            type: "array",
                            items: { type: "string" },
                          },
                          validation: {
                            type: "array",
                            items: { type: "string" },
                          },
                        },
                        required: ["title", "summary", "scope", "acceptanceCriteria", "validation"],
                        additionalProperties: false,
                      },
                    },
                    reasons: {
                      type: "array",
                      items: { type: "string" },
                    },
                  },
                  required: ["issueNumber", "decision", "issue", "splitIssues", "reasons"],
                  additionalProperties: false,
                },
              },
            },
            required: ["actions"],
            additionalProperties: false,
          },
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Planning stage agent request failed with status ${response.status}: ${await response.text()}`);
  }

  const payload = await response.json() as {
    output_text?: unknown;
    output?: Array<{
      type?: string;
      content?: Array<{ type?: string; text?: string; refusal?: string }>;
    }>;
    status?: string;
    error?: { message?: string } | null;
    incomplete_details?: { reason?: string } | null;
  };
  const finalResponse = extractResponseOutputText(payload, "Planning stage agent");

  return parsePlanningResponse(finalResponse);
}
