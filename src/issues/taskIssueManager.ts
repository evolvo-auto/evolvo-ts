import { GitHubApiError, GitHubClient } from "../github/githubClient.js";

const IN_PROGRESS_LABEL = "in progress";
const COMPLETED_LABEL = "completed";

type GitHubLabel = {
  name: string;
};

type GitHubIssue = {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  labels: GitHubLabel[];
  pull_request?: unknown;
};

export type IssueSummary = {
  number: number;
  title: string;
  description: string;
  state: "open" | "closed";
  labels: string[];
};

export type IssueActionResult = {
  ok: boolean;
  message: string;
  issue?: IssueSummary;
};

export type ReplenishIssuesOptions = {
  minimumIssueCount: number;
  maximumOpenIssues: number;
  templates?: IssueTemplate[];
};

export type ReplenishIssuesResult = {
  created: IssueSummary[];
};

type IssueTemplate = {
  title: string;
  description: string;
};

const SELF_IMPROVEMENT_ISSUE_TEMPLATES: IssueTemplate[] = [
  {
    title: "Harden run loop retry handling for transient GitHub failures",
    description:
      "Add bounded retry/backoff around transient GitHub API errors in the run loop and cover the failure/recovery paths with tests.",
  },
  {
    title: "Add regression test for empty-queue issue replenishment flow",
    description:
      "Add an integration-style runtime test that validates queue replenishment creates new issues and continues processing without exiting.",
  },
  {
    title: "Improve validation reporting with command, exit code, and duration",
    description:
      "Enhance validation logs to include command name, exit status, and elapsed time to improve debugging after failed runs.",
  },
  {
    title: "Guard commit staging to reject unrelated modified files",
    description:
      "Add a pre-commit safeguard that verifies staged files match the active task scope and blocks accidental unrelated changes.",
  },
  {
    title: "Add structured lifecycle logging for issue cycle transitions",
    description:
      "Emit structured logs for issue selection, implementation start/end, review outcome, and merge transition to improve observability.",
  },
];

function buildFollowUpTemplate(template: IssueTemplate, sequence: number): IssueTemplate {
  return {
    title: `${template.title} (follow-up ${sequence})`,
    description: `${template.description}\n\nFollow-up: address remaining gaps discovered after earlier work.`,
  };
}

function formatIssue(issue: GitHubIssue): IssueSummary {
  return {
    number: issue.number,
    title: issue.title,
    description: issue.body ?? "",
    state: issue.state,
    labels: issue.labels.map((label) => label.name),
  };
}

function hasLabel(issue: GitHubIssue, labelName: string): boolean {
  return issue.labels.some((label) => label.name.toLowerCase() === labelName.toLowerCase());
}

function buildLabels(issue: GitHubIssue, options: { inProgress: boolean; completed: boolean }): string[] {
  const names = issue.labels.map((label) => label.name);
  const withoutManaged = names.filter(
    (name) => name.toLowerCase() !== IN_PROGRESS_LABEL && name.toLowerCase() !== COMPLETED_LABEL,
  );

  if (options.inProgress) {
    withoutManaged.push(IN_PROGRESS_LABEL);
  }

  if (options.completed) {
    withoutManaged.push(COMPLETED_LABEL);
  }

  return withoutManaged;
}

export class TaskIssueManager {
  private static readonly ISSUES_PER_PAGE = 100;

  public constructor(private readonly client: GitHubClient) {}

  public async createIssue(title: string, description: string): Promise<IssueActionResult> {
    if (!title.trim()) {
      return { ok: false, message: "Issue title is required." };
    }

    const created = await this.client.post<GitHubIssue>("", {
      title: title.trim(),
      body: description.trim(),
    });

    return {
      ok: true,
      message: `Created issue #${created.number}.`,
      issue: formatIssue(created),
    };
  }

  public async listOpenIssues(): Promise<IssueSummary[]> {
    const issues: GitHubIssue[] = [];
    let page = 1;

    while (true) {
      const batch = await this.client.get<GitHubIssue[]>(
        `?state=open&per_page=${TaskIssueManager.ISSUES_PER_PAGE}&page=${page}`,
      );
      issues.push(...batch);

      if (batch.length < TaskIssueManager.ISSUES_PER_PAGE) {
        break;
      }

      page += 1;
    }

    return issues.filter((issue) => issue.pull_request === undefined).map(formatIssue);
  }

  public async replenishSelfImprovementIssues(options: ReplenishIssuesOptions): Promise<ReplenishIssuesResult> {
    const minimumIssueCount = Math.max(0, Math.floor(options.minimumIssueCount));
    const maximumOpenIssues = Math.max(0, Math.floor(options.maximumOpenIssues));
    const baseTemplates =
      options.templates && options.templates.length > 0
        ? options.templates
        : SELF_IMPROVEMENT_ISSUE_TEMPLATES;

    if (minimumIssueCount === 0 || maximumOpenIssues === 0) {
      return { created: [] };
    }

    const openIssues = await this.listOpenIssues();
    const remainingOpenSlots = maximumOpenIssues - openIssues.length;
    if (remainingOpenSlots <= 0) {
      return { created: [] };
    }

    const recentClosed = await this.client.get<GitHubIssue[]>(
      `?state=closed&sort=updated&direction=desc&per_page=${TaskIssueManager.ISSUES_PER_PAGE}&page=1`,
    );
    const existingTitles = new Set(
      [...openIssues.map((issue) => issue.title), ...recentClosed.map((issue) => issue.title)].map((title) =>
        title.trim().toLowerCase(),
      ),
    );

    const toCreateCount = Math.min(remainingOpenSlots, minimumIssueCount);
    const templates = selectTemplatesForCreation({
      baseTemplates,
      toCreateCount,
      existingTitles,
    });

    const created: IssueSummary[] = [];
    for (const template of templates) {
      const result = await this.createIssue(template.title, template.description);
      if (result.ok && result.issue) {
        created.push(result.issue);
      }
    }

    return { created };
  }

  public async markInProgress(issueNumber: number): Promise<IssueActionResult> {
    const issue = await this.getIssue(issueNumber);

    if (!issue) {
      return { ok: false, message: `Issue #${issueNumber} was not found.` };
    }

    if (issue.state === "closed") {
      return { ok: false, message: `Issue #${issueNumber} is closed and cannot be started.` };
    }

    if (hasLabel(issue, IN_PROGRESS_LABEL)) {
      return { ok: false, message: `Issue #${issueNumber} is already in progress.` };
    }

    const updated = await this.client.patch<GitHubIssue>(`/${issueNumber}`, {
      labels: buildLabels(issue, { inProgress: true, completed: false }),
    });

    return {
      ok: true,
      message: `Issue #${issueNumber} marked as in progress.`,
      issue: formatIssue(updated),
    };
  }

  public async addProgressComment(issueNumber: number, comment: string): Promise<IssueActionResult> {
    const trimmedComment = comment.trim();
    if (!trimmedComment) {
      return { ok: false, message: "Progress comment cannot be empty." };
    }

    const issue = await this.getIssue(issueNumber);

    if (!issue) {
      return { ok: false, message: `Issue #${issueNumber} was not found.` };
    }

    if (issue.state === "closed") {
      return { ok: false, message: `Issue #${issueNumber} is closed and cannot be updated.` };
    }

    await this.client.post(`/${issueNumber}/comments`, { body: trimmedComment });

    return {
      ok: true,
      message: `Added progress comment to issue #${issueNumber}.`,
      issue: formatIssue(issue),
    };
  }

  public async markCompleted(issueNumber: number, summary: string): Promise<IssueActionResult> {
    const trimmedSummary = summary.trim();
    if (!trimmedSummary) {
      return { ok: false, message: "Completion summary cannot be empty." };
    }

    const issue = await this.getIssue(issueNumber);

    if (!issue) {
      return { ok: false, message: `Issue #${issueNumber} was not found.` };
    }

    if (issue.state === "closed") {
      return { ok: false, message: `Issue #${issueNumber} is closed and cannot be completed.` };
    }

    if (hasLabel(issue, COMPLETED_LABEL)) {
      return { ok: false, message: `Issue #${issueNumber} is already marked as completed.` };
    }

    await this.client.post(`/${issueNumber}/comments`, { body: trimmedSummary });
    const updated = await this.client.patch<GitHubIssue>(`/${issueNumber}`, {
      labels: buildLabels(issue, { inProgress: false, completed: true }),
    });

    return {
      ok: true,
      message: `Issue #${issueNumber} marked as completed.`,
      issue: formatIssue(updated),
    };
  }

  public async closeIssue(issueNumber: number): Promise<IssueActionResult> {
    const issue = await this.getIssue(issueNumber);

    if (!issue) {
      return { ok: false, message: `Issue #${issueNumber} was not found.` };
    }

    if (issue.state === "closed") {
      return { ok: false, message: `Issue #${issueNumber} is already closed.` };
    }

    await this.client.patch<GitHubIssue>(`/${issueNumber}`, { state: "closed" });

    return {
      ok: true,
      message: `Issue #${issueNumber} closed successfully.`,
      issue: formatIssue({ ...issue, state: "closed" }),
    };
  }

  private async getIssue(issueNumber: number): Promise<GitHubIssue | null> {
    try {
      const issue = await this.client.get<GitHubIssue>(`/${issueNumber}`);
      if (issue.pull_request !== undefined) {
        return null;
      }

      return issue;
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) {
        return null;
      }

      throw error;
    }
  }
}

function selectTemplatesForCreation(options: {
  baseTemplates: IssueTemplate[];
  toCreateCount: number;
  existingTitles: Set<string>;
}): IssueTemplate[] {
  if (options.toCreateCount <= 0 || options.baseTemplates.length === 0) {
    return [];
  }

  const selected: IssueTemplate[] = [];
  const followUpSequenceByTemplate = new Map<string, number>();
  let cursor = 0;
  const maxAttempts = Math.max(options.baseTemplates.length * options.toCreateCount * 4, 20);

  while (selected.length < options.toCreateCount && cursor < maxAttempts) {
    const template = options.baseTemplates[cursor % options.baseTemplates.length];
    if (!template) {
      break;
    }

    const key = template.title.trim().toLowerCase();
    const sequence = followUpSequenceByTemplate.get(key) ?? 0;
    const candidate = sequence === 0 ? template : buildFollowUpTemplate(template, sequence);
    const normalizedTitle = candidate.title.trim().toLowerCase();

    if (normalizedTitle && !options.existingTitles.has(normalizedTitle)) {
      selected.push(candidate);
      options.existingTitles.add(normalizedTitle);
      cursor += 1;
    }

    followUpSequenceByTemplate.set(key, sequence + 1);
  }

  return selected;
}

export { COMPLETED_LABEL, IN_PROGRESS_LABEL };
