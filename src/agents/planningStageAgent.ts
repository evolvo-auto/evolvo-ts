const OPENAI_RESPONSES_API_URL = "https://api.openai.com/v1/responses";
export const PLANNING_STAGE_OPENAI_MODEL = "gpt-5.4";

export type PlanningStageAction =
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
      title?: unknown;
      description?: unknown;
      splitIssues?: unknown;
      reasons?: unknown;
    };
    if (typeof action.issueNumber !== "number" || !Number.isInteger(action.issueNumber)) {
      continue;
    }

    const decision = action.decision === "ready-for-dev" || action.decision === "blocked"
      ? action.decision
      : null;
    const title = typeof action.title === "string" ? action.title.trim() : "";
    const description = typeof action.description === "string" ? action.description.trim() : "";
    const reasons = Array.isArray(action.reasons)
      ? action.reasons.filter((reason): reason is string => typeof reason === "string").map((reason) => reason.trim()).filter(Boolean)
      : [];
    const splitIssues = Array.isArray(action.splitIssues)
      ? action.splitIssues.flatMap((entry) => {
        if (!entry || typeof entry !== "object") {
          return [];
        }
        const candidate = entry as { title?: unknown; description?: unknown };
        const splitTitle = typeof candidate.title === "string" ? candidate.title.trim() : "";
        const splitDescription = typeof candidate.description === "string" ? candidate.description.trim() : "";
        return splitTitle && splitDescription ? [{ title: splitTitle, description: splitDescription }] : [];
      })
      : [];

    if (!decision || !title || !description) {
      continue;
    }

    actions.push({
      issueNumber: action.issueNumber,
      decision,
      title,
      description,
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
    "You are the only agent allowed to take issues out of Inbox and move them to Ready for Dev.",
    "You may rewrite issue titles/descriptions to make them implementation-ready.",
    "You may split an issue into multiple smaller issues when needed.",
    "For each issue, either mark it ready-for-dev or blocked.",
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
    "Each action must include: issueNumber, decision, title, description, splitIssues, reasons.",
    'decision must be either "ready-for-dev" or "blocked".',
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
                    decision: { type: "string", enum: ["ready-for-dev", "blocked"] },
                    title: { type: "string" },
                    description: { type: "string" },
                    splitIssues: {
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
                    reasons: {
                      type: "array",
                      items: { type: "string" },
                    },
                  },
                  required: ["issueNumber", "decision", "title", "description", "splitIssues", "reasons"],
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

  const payload = await response.json() as { output_text?: unknown };
  const finalResponse = typeof payload.output_text === "string" ? payload.output_text : "";
  if (!finalResponse.trim()) {
    throw new Error("Planning stage agent response did not include output_text.");
  }

  return parsePlanningResponse(finalResponse);
}
