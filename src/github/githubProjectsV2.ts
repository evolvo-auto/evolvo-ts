import {
  PROJECT_WORKFLOW_STAGES,
  type ProjectWorkflow,
  type ProjectWorkflowStage,
} from "../projects/projectWorkflow.js";
import type { ProjectRecord } from "../projects/projectRegistry.js";
import type { GitHubClient } from "./githubClient.js";

type GraphqlOwner = {
  id: string;
  login: string;
  __typename: "Organization" | "User";
  projectsV2?: {
    nodes?: Array<{
      id?: string | null;
      number?: number | null;
      title?: string | null;
      url?: string | null;
    } | null> | null;
  } | null;
};

type GraphqlProjectField = {
  id?: string | null;
  name?: string | null;
  options?: Array<{
    id?: string | null;
    name?: string | null;
  } | null> | null;
};

type EnsureProjectBoardResult = {
  workflow: ProjectWorkflow;
};

const PROJECT_TITLE_SUFFIX = " Workflow";
const STAGE_FIELD_NAME = "Stage";

function buildProjectBoardTitle(project: ProjectRecord): string {
  return `${project.executionRepo.repo}${PROJECT_TITLE_SUFFIX}`;
}

function toStageOptionIdMap(field: GraphqlProjectField | null | undefined): ProjectWorkflow["stageOptionIds"] {
  const optionIds: ProjectWorkflow["stageOptionIds"] = {};
  for (const option of field?.options ?? []) {
    const name = option?.name?.trim();
    const id = option?.id?.trim();
    if (!name || !id || !PROJECT_WORKFLOW_STAGES.includes(name as ProjectWorkflowStage)) {
      continue;
    }

    optionIds[name as ProjectWorkflowStage] = id;
  }

  return optionIds;
}

export class GitHubProjectsV2Client {
  public constructor(private readonly client: GitHubClient) {}

  public async ensureProjectBoard(project: ProjectRecord): Promise<EnsureProjectBoardResult> {
    const owner = await this.getOwner(project.executionRepo.owner, buildProjectBoardTitle(project));
    const existingProject = owner.projectsV2?.nodes?.find((entry) =>
      entry?.title?.trim().toLowerCase() === buildProjectBoardTitle(project).trim().toLowerCase()
    ) ?? null;

    const board = existingProject?.id && typeof existingProject.number === "number" && existingProject.url
      ? {
        id: existingProject.id,
        number: existingProject.number,
        url: existingProject.url,
      }
      : await this.createProjectBoard(owner.id, buildProjectBoardTitle(project));
    const stageField = await this.ensureStageField(board.id, board.number, project.executionRepo.owner);

    return {
      workflow: {
        boardOwner: owner.login,
        boardNumber: board.number ?? null,
        boardId: board.id ?? null,
        boardUrl: board.url ?? null,
        stageFieldId: stageField.id,
        stageOptionIds: toStageOptionIdMap(stageField),
        boardProvisioned: true,
        lastError: null,
        lastSyncedAt: new Date().toISOString(),
      },
    };
  }

  private async getOwner(owner: string, projectTitle: string): Promise<GraphqlOwner> {
    const data = await this.client.graphql<{
      organization?: GraphqlOwner | null;
      user?: GraphqlOwner | null;
    }>(
      `
        query GetProjectsOwner($owner: String!, $projectTitle: String!) {
          organization(login: $owner) {
            id
            login
            __typename
            projectsV2(first: 100, query: $projectTitle) {
              nodes {
                id
                number
                title
                url
              }
            }
          }
          user(login: $owner) {
            id
            login
            __typename
            projectsV2(first: 100, query: $projectTitle) {
              nodes {
                id
                number
                title
                url
              }
            }
          }
        }
      `,
      { owner, projectTitle },
    );

    const resolvedOwner = data.organization ?? data.user ?? null;
    if (!resolvedOwner?.id || !resolvedOwner.login) {
      throw new Error(`Could not resolve GitHub Projects owner metadata for ${owner}.`);
    }

    return resolvedOwner;
  }

  private async createProjectBoard(
    ownerId: string,
    title: string,
  ): Promise<{ id: string; number: number; url: string }> {
    const data = await this.client.graphql<{
      createProjectV2?: {
        projectV2?: {
          id?: string | null;
          number?: number | null;
          url?: string | null;
        } | null;
      } | null;
    }>(
      `
        mutation CreateProjectBoard($ownerId: ID!, $title: String!) {
          createProjectV2(input: { ownerId: $ownerId, title: $title }) {
            projectV2 {
              id
              number
              url
            }
          }
        }
      `,
      { ownerId, title },
    );

    const project = data.createProjectV2?.projectV2 ?? null;
    if (!project?.id || typeof project.number !== "number" || !project.url) {
      throw new Error(`GitHub did not return complete board metadata for ${title}.`);
    }

    return {
      id: project.id,
      number: project.number,
      url: project.url,
    };
  }

  private async ensureStageField(
    projectId: string,
    projectNumber: number,
    owner: string,
  ): Promise<GraphqlProjectField & { id: string }> {
    const project = await this.client.graphql<{
      organization?: {
        projectV2?: {
          fields?: {
            nodes?: Array<GraphqlProjectField | null> | null;
          } | null;
        } | null;
      } | null;
      user?: {
        projectV2?: {
          fields?: {
            nodes?: Array<GraphqlProjectField | null> | null;
          } | null;
        } | null;
      } | null;
    }>(
      `
        query GetProjectStageField($owner: String!, $number: Int!) {
          organization(login: $owner) {
            projectV2(number: $number) {
              fields(first: 50) {
                nodes {
                  ... on ProjectV2SingleSelectField {
                    id
                    name
                    options {
                      id
                      name
                    }
                  }
                }
              }
            }
          }
          user(login: $owner) {
            projectV2(number: $number) {
              fields(first: 50) {
                nodes {
                  ... on ProjectV2SingleSelectField {
                    id
                    name
                    options {
                      id
                      name
                    }
                  }
                }
              }
            }
          }
        }
      `,
      { owner, number: projectNumber },
    );

    const fields = project.organization?.projectV2?.fields?.nodes
      ?? project.user?.projectV2?.fields?.nodes
      ?? [];
    const existing = fields.find((field) => field?.name?.trim() === STAGE_FIELD_NAME) ?? null;
    if (existing?.id) {
      return {
        ...existing,
        id: existing.id,
      };
    }

    const created = await this.client.graphql<{
      createProjectV2Field?: {
        projectV2Field?: GraphqlProjectField | null;
      } | null;
    }>(
      `
        mutation CreateProjectStageField($projectId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
          createProjectV2Field(
            input: {
              projectId: $projectId
              dataType: SINGLE_SELECT
              name: "${STAGE_FIELD_NAME}"
              singleSelectOptions: $options
            }
          ) {
            projectV2Field {
              ... on ProjectV2SingleSelectField {
                id
                name
                options {
                  id
                  name
                }
              }
            }
          }
        }
      `,
      {
        projectId,
        options: PROJECT_WORKFLOW_STAGES.map((stage) => ({ name: stage })),
      },
    );

    const createdField = created.createProjectV2Field?.projectV2Field ?? null;
    if (!createdField?.id) {
      throw new Error(`GitHub did not return stage field metadata for project ${projectNumber}.`);
    }

    return {
      ...createdField,
      id: createdField.id,
    };
  }
}
