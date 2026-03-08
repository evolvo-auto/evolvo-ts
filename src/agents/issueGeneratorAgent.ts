const OPENAI_RESPONSES_API_URL = "https://api.openai.com/v1/responses";
export const ISSUE_GENERATOR_OPENAI_MODEL = "gpt-5.4-mini";

export type IssueGeneratorDraft = {
  title: string;
  description: string;
};

type IssueGeneratorResponse = {
  issues?: unknown;
};

function formatList(values: string[]): string {
  if (values.length === 0) {
    return "- none";
  }

  return values.map((value) => `- ${value}`).join("\n");
}

function parseResponse(finalResponse: string): IssueGeneratorDraft[] {
  const parsed = JSON.parse(finalResponse) as IssueGeneratorResponse;
  if (!Array.isArray(parsed.issues)) {
    throw new Error("Issue generator response did not include an issues array.");
  }

  const drafts: IssueGeneratorDraft[] = [];
  const seen = new Set<string>();
  for (const rawIssue of parsed.issues) {
    if (!rawIssue || typeof rawIssue !== "object") {
      continue;
    }

    const draft = rawIssue as { title?: unknown; description?: unknown };
    const title = typeof draft.title === "string" ? draft.title.trim() : "";
    const description = typeof draft.description === "string" ? draft.description.trim() : "";
    if (!title || !description) {
      continue;
    }

    const key = title.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    drafts.push({ title, description });
  }

  return drafts;
}

function buildPrompt(input: {
  projectSlug: string;
  projectDisplayName: string;
  repository: string;
  counts: {
    inbox: number;
    planning: number;
    readyForDev: number;
    inDev: number;
  };
  openIssueTitles: string[];
  recentClosedIssueTitles: string[];
  maxIssues: number;
}): string {
  return [
    `You are Evolvo's global Issue Generator agent for project ${input.projectDisplayName} (${input.projectSlug}).`,
    "You only create candidate issues for the Inbox column.",
    "You do not plan, split, review, or release work.",
    `Create at most ${input.maxIssues} new candidate issues for the repository.`,
    "Prefer small, repo-specific, implementation-relevant work items.",
    "Do not create duplicate or lightly reworded issues.",
    "Do not create generic process-only tasks unless they clearly support delivery.",
    "",
    `Repository: ${input.repository}`,
    `Current backlog counts: Inbox=${input.counts.inbox}, Planning=${input.counts.planning}, Ready for Dev=${input.counts.readyForDev}, In Dev=${input.counts.inDev}`,
    "",
    "Current open issue titles:",
    formatList(input.openIssueTitles),
    "",
    "Recently closed issue titles:",
    formatList(input.recentClosedIssueTitles),
    "",
    "Return strict JSON with an `issues` array of objects containing `title` and `description` only.",
  ].join("\n");
}

export async function runIssueGeneratorAgent(input: {
  apiKey: string;
  projectSlug: string;
  projectDisplayName: string;
  repository: string;
  counts: {
    inbox: number;
    planning: number;
    readyForDev: number;
    inDev: number;
  };
  openIssueTitles: string[];
  recentClosedIssueTitles: string[];
  maxIssues: number;
}): Promise<IssueGeneratorDraft[]> {
  const response = await fetch(OPENAI_RESPONSES_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: ISSUE_GENERATOR_OPENAI_MODEL,
      input: [
        {
          role: "user",
          content: buildPrompt(input),
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "issue_generator_batch",
          strict: true,
          schema: {
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
          },
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Issue generator request failed with status ${response.status}: ${await response.text()}`);
  }

  const payload = await response.json() as { output_text?: unknown };
  const finalResponse = typeof payload.output_text === "string" ? payload.output_text : "";
  if (!finalResponse.trim()) {
    throw new Error("Issue generator response did not include output_text.");
  }

  return parseResponse(finalResponse);
}
