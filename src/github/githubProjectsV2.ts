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
      repositories?: {
        nodes?: Array<{
          nameWithOwner?: string | null;
        } | null> | null;
      } | null;
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

export type ProjectBoardIssueItem = {
  itemId: string;
  issueNodeId: string;
  issueNumber: number;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  url: string;
  labels: string[];
  repository: {
    owner: string;
    repo: string;
    url: string;
    reference: string;
  };
  stage: ProjectWorkflowStage | null;
  stageOptionId: string | null;
};

type GraphqlProjectItemNode = {
  id?: string | null;
  fieldValueByName?: {
    name?: string | null;
    optionId?: string | null;
  } | null;
  content?: {
    id?: string | null;
    number?: number | null;
    title?: string | null;
    body?: string | null;
    state?: "OPEN" | "CLOSED" | null;
    url?: string | null;
    labels?: {
      nodes?: Array<{ name?: string | null } | null> | null;
    } | null;
    repository?: {
      name?: string | null;
      url?: string | null;
      owner?: {
        login?: string | null;
      } | null;
    } | null;
  } | null;
};

type GraphqlProjectItemsPage = {
  node?: {
    items?: {
      nodes?: Array<GraphqlProjectItemNode | null> | null;
      pageInfo?: {
        endCursor?: string | null;
        hasNextPage?: boolean | null;
      } | null;
    } | null;
  } | null;
};

type ProjectStageOptionInput = {
  color: "BLUE" | "GRAY" | "GREEN" | "ORANGE" | "PINK" | "PURPLE" | "RED" | "YELLOW";
  description: string;
  name: ProjectWorkflowStage;
};

const PROJECT_TITLE_SUFFIX = " Workflow";
const STAGE_FIELD_NAME = "Stage";
const PROJECT_STAGE_OPTIONS: ProjectStageOptionInput[] = [
  {
    name: "Inbox",
    color: "GRAY",
    description: "raw generated work, not yet processed",
  },
  {
    name: "Planning",
    color: "BLUE",
    description: "planner is evaluating/splitting/prioritizing",
  },
  {
    name: "Ready for Dev",
    color: "YELLOW",
    description: "implementation-ready",
  },
  {
    name: "In Dev",
    color: "ORANGE",
    description: "dev agent currently owns it",
  },
  {
    name: "Ready for Review",
    color: "PURPLE",
    description: "PR exists and is awaiting review",
  },
  {
    name: "In Review",
    color: "PINK",
    description: "review agent currently processing it",
  },
  {
    name: "Ready for Release",
    color: "GREEN",
    description: "approved, merge/release pending",
  },
  {
    name: "Releasing",
    color: "BLUE",
    description: "release agent currently processing it",
  },
  {
    name: "Blocked",
    color: "RED",
    description: "needs human input / external dependency / repeated failure",
  },
  {
    name: "Done",
    color: "GREEN",
    description: "completed",
  },
];

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
    const repositoryId = await this.getRepositoryId(project.executionRepo.owner, project.executionRepo.repo);
    const existingProject = owner.projectsV2?.nodes?.find((entry) =>
      entry?.title?.trim().toLowerCase() === buildProjectBoardTitle(project).trim().toLowerCase()
    ) ?? null;

    const board = existingProject?.id && typeof existingProject.number === "number" && existingProject.url
      ? {
        id: existingProject.id,
        number: existingProject.number,
        url: existingProject.url,
      }
      : await this.createProjectBoard(owner.id, buildProjectBoardTitle(project), repositoryId);
    if (existingProject?.id && !this.isRepositoryLinked(existingProject, project.executionRepo.owner, project.executionRepo.repo)) {
      await this.linkProjectToRepository(board.id, repositoryId);
    }
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

  public async listProjectIssueItems(project: ProjectRecord): Promise<ProjectBoardIssueItem[]> {
    const projectId = this.requireWorkflowMetadata(project, "boardId");
    const normalizedItems: ProjectBoardIssueItem[] = [];
    let cursor: string | null = null;

    while (true) {
      const data: GraphqlProjectItemsPage = await this.client.graphql<GraphqlProjectItemsPage>(
        `
        query ListProjectIssueItems($projectId: ID!, $after: String) {
          node(id: $projectId) {
            ... on ProjectV2 {
              items(first: 100, after: $after) {
                nodes {
                  id
                  fieldValueByName(name: "${STAGE_FIELD_NAME}") {
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      name
                      optionId
                    }
                  }
                  content {
                    ... on Issue {
                      id
                      number
                      title
                      body
                      state
                      url
                      labels(first: 50) {
                        nodes {
                          name
                        }
                      }
                      repository {
                        name
                        url
                        owner {
                          login
                        }
                      }
                    }
                  }
                }
                pageInfo {
                  endCursor
                  hasNextPage
                }
              }
            }
          }
        }
      `,
        { projectId, after: cursor },
      );

      const items: Array<GraphqlProjectItemNode | null> = data.node?.items?.nodes ?? [];
      normalizedItems.push(...items
        .map((item: GraphqlProjectItemNode | null) => this.normalizeProjectBoardIssueItem(item))
        .filter((item: ProjectBoardIssueItem | null): item is ProjectBoardIssueItem => item !== null));

      const pageInfo: { endCursor?: string | null; hasNextPage?: boolean | null } | null = data.node?.items?.pageInfo ?? null;
      if (!pageInfo?.hasNextPage || !pageInfo.endCursor) {
        break;
      }
      cursor = pageInfo.endCursor;
    }

    return normalizedItems;
  }

  public async ensureRepositoryIssueItem(project: ProjectRecord, issueNumber: number): Promise<ProjectBoardIssueItem> {
    const existingItems = await this.listProjectIssueItems(project);
    const existingItem = existingItems.find((item) => item.issueNumber === issueNumber);
    if (existingItem) {
      return existingItem;
    }

    const projectId = this.requireWorkflowMetadata(project, "boardId");
    const issueNodeId = await this.getRepositoryIssueId(
      project.executionRepo.owner,
      project.executionRepo.repo,
      issueNumber,
    );
    const addResult = await this.client.graphql<{
      addProjectV2ItemById?: {
        item?: {
          id?: string | null;
        } | null;
      } | null;
    }>(
      `
        mutation AddProjectIssueItem($projectId: ID!, $contentId: ID!) {
          addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
            item {
              id
            }
          }
        }
      `,
      {
        projectId,
        contentId: issueNodeId,
      },
    );

    const addedItemId = addResult.addProjectV2ItemById?.item?.id?.trim();
    const addedItem = addedItemId
      ? await this.getProjectIssueItemById(addedItemId)
      : null;
    if (!addedItem) {
      throw new Error(`GitHub did not return board item metadata for issue #${issueNumber} in project ${project.slug}.`);
    }

    return addedItem;
  }

  public async moveProjectItemToStage(
    project: ProjectRecord,
    itemId: string,
    stage: ProjectWorkflowStage,
  ): Promise<void> {
    const projectId = this.requireWorkflowMetadata(project, "boardId");
    const fieldId = this.requireWorkflowMetadata(project, "stageFieldId");
    const optionId = project.workflow.stageOptionIds[stage]?.trim();
    if (!optionId) {
      throw new Error(`Project ${project.slug} is missing the stage option id for ${stage}.`);
    }

    await this.client.graphql(
      `
        mutation MoveProjectItemStage($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
          updateProjectV2ItemFieldValue(
            input: {
              projectId: $projectId
              itemId: $itemId
              fieldId: $fieldId
              value: { singleSelectOptionId: $optionId }
            }
          ) {
            projectV2Item {
              id
            }
          }
        }
      `,
      {
        projectId,
        itemId,
        fieldId,
        optionId,
      },
    );
  }

  private async getOwner(owner: string, projectTitle: string): Promise<GraphqlOwner> {
    const organization = await this.tryGetOrganizationOwner(owner, projectTitle);
    if (organization?.id && organization.login) {
      return organization;
    }

    const user = await this.tryGetUserOwner(owner, projectTitle);
    if (user?.id && user.login) {
      return user;
    }

    throw new Error(`Could not resolve GitHub Projects owner metadata for ${owner}.`);
  }

  private async createProjectBoard(
    ownerId: string,
    title: string,
    repositoryId: string,
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
        mutation CreateProjectBoard($ownerId: ID!, $repositoryId: ID!, $title: String!) {
          createProjectV2(input: { ownerId: $ownerId, repositoryId: $repositoryId, title: $title }) {
            projectV2 {
              id
              number
              url
            }
          }
        }
      `,
      { ownerId, repositoryId, title },
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
    const fields = await this.getProjectStageFields(owner, projectNumber);
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
        options: PROJECT_STAGE_OPTIONS,
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

  private async getRepositoryId(owner: string, repo: string): Promise<string> {
    const data = await this.client.graphql<{
      repository?: {
        id?: string | null;
      } | null;
    }>(
      `
        query GetRepositoryId($owner: String!, $repo: String!) {
          repository(owner: $owner, name: $repo) {
            id
          }
        }
      `,
      { owner, repo },
    );

    const repositoryId = data.repository?.id?.trim();
    if (!repositoryId) {
      throw new Error(`Could not resolve repository metadata for ${owner}/${repo}.`);
    }

    return repositoryId;
  }

  private async getRepositoryIssueId(owner: string, repo: string, issueNumber: number): Promise<string> {
    const data = await this.client.graphql<{
      repository?: {
        issue?: {
          id?: string | null;
        } | null;
      } | null;
    }>(
      `
        query GetRepositoryIssueId($owner: String!, $repo: String!, $issueNumber: Int!) {
          repository(owner: $owner, name: $repo) {
            issue(number: $issueNumber) {
              id
            }
          }
        }
      `,
      { owner, repo, issueNumber },
    );

    const issueId = data.repository?.issue?.id?.trim();
    if (!issueId) {
      throw new Error(`Could not resolve issue node id for ${owner}/${repo}#${issueNumber}.`);
    }

    return issueId;
  }

  private normalizeStageName(stageName: string | null | undefined): ProjectWorkflowStage | null {
    if (!stageName) {
      return null;
    }

    const normalizedStageName = stageName.trim();
    if (!PROJECT_WORKFLOW_STAGES.includes(normalizedStageName as ProjectWorkflowStage)) {
      return null;
    }

    return normalizedStageName as ProjectWorkflowStage;
  }

  private normalizeProjectBoardIssueItem(item: GraphqlProjectItemNode | null | undefined): ProjectBoardIssueItem | null {
    const itemId = item?.id?.trim();
    const issueNodeId = item?.content?.id?.trim();
    const issueNumber = typeof item?.content?.number === "number" ? item.content.number : null;
    const title = item?.content?.title?.trim();
    const url = item?.content?.url?.trim();
    const repoName = item?.content?.repository?.name?.trim();
    const repoOwner = item?.content?.repository?.owner?.login?.trim();
    const repoUrl = item?.content?.repository?.url?.trim();
    if (!itemId || !issueNodeId || issueNumber === null || !title || !url || !repoName || !repoOwner || !repoUrl) {
      return null;
    }

    return {
      itemId,
      issueNodeId,
      issueNumber,
      title,
      body: item?.content?.body ?? "",
      state: item?.content?.state === "CLOSED" ? "CLOSED" : "OPEN",
      url,
      labels: (item?.content?.labels?.nodes ?? [])
        .map((label) => label?.name?.trim() ?? "")
        .filter((label) => label.length > 0),
      repository: {
        owner: repoOwner,
        repo: repoName,
        url: repoUrl,
        reference: `${repoOwner}/${repoName}`,
      },
      stage: this.normalizeStageName(item?.fieldValueByName?.name),
      stageOptionId: item?.fieldValueByName?.optionId?.trim() || null,
    };
  }

  private async getProjectIssueItemById(itemId: string): Promise<ProjectBoardIssueItem | null> {
    const data = await this.client.graphql<{
      node?: GraphqlProjectItemNode | null;
    }>(
      `
        query GetProjectIssueItem($itemId: ID!) {
          node(id: $itemId) {
            ... on ProjectV2Item {
              id
              fieldValueByName(name: "${STAGE_FIELD_NAME}") {
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  optionId
                }
              }
              content {
                ... on Issue {
                  id
                  number
                  title
                  body
                  state
                  url
                  labels(first: 50) {
                    nodes {
                      name
                    }
                  }
                  repository {
                    name
                    url
                    owner {
                      login
                    }
                  }
                }
              }
            }
          }
        }
      `,
      { itemId },
    );

    return this.normalizeProjectBoardIssueItem(data.node ?? null);
  }

  private requireWorkflowMetadata(
    project: ProjectRecord,
    key: "boardId" | "stageFieldId",
  ): string {
    const value = project.workflow[key]?.trim();
    if (!value) {
      throw new Error(`Project ${project.slug} is missing workflow metadata: ${key}.`);
    }

    return value;
  }

  private isRepositoryLinked(
    project: {
      repositories?: {
        nodes?: Array<{
          nameWithOwner?: string | null;
        } | null> | null;
      } | null;
    },
    owner: string,
    repo: string,
  ): boolean {
    const repositoryReference = `${owner}/${repo}`.toLowerCase();
    return project.repositories?.nodes?.some((entry) => entry?.nameWithOwner?.trim().toLowerCase() === repositoryReference) ?? false;
  }

  private async linkProjectToRepository(projectId: string, repositoryId: string): Promise<void> {
    await this.client.graphql<{
      linkProjectV2ToRepository?: {
        repository?: {
          id?: string | null;
        } | null;
      } | null;
    }>(
      `
        mutation LinkProjectToRepository($projectId: ID!, $repositoryId: ID!) {
          linkProjectV2ToRepository(input: { projectId: $projectId, repositoryId: $repositoryId }) {
            repository {
              id
            }
          }
        }
      `,
      { projectId, repositoryId },
    );
  }

  private async tryGetOrganizationOwner(owner: string, projectTitle: string): Promise<GraphqlOwner | null> {
    const data = await this.client.graphql<{
      organization?: GraphqlOwner | null;
    }>(
      `
        query GetOrganizationProjectsOwner($owner: String!, $projectTitle: String!) {
          organization(login: $owner) {
            id
            login
            __typename
            projectsV2(first: 100, query: $projectTitle) {
              nodes {
                id
                number
                repositories(first: 20) {
                  nodes {
                    nameWithOwner
                  }
                }
                title
                url
              }
            }
          }
        }
      `,
      { owner, projectTitle },
    );

    return data.organization ?? null;
  }

  private async tryGetUserOwner(owner: string, projectTitle: string): Promise<GraphqlOwner | null> {
    const data = await this.client.graphql<{
      user?: GraphqlOwner | null;
    }>(
      `
        query GetUserProjectsOwner($owner: String!, $projectTitle: String!) {
          user(login: $owner) {
            id
            login
            __typename
            projectsV2(first: 100, query: $projectTitle) {
              nodes {
                id
                number
                repositories(first: 20) {
                  nodes {
                    nameWithOwner
                  }
                }
                title
                url
              }
            }
          }
        }
      `,
      { owner, projectTitle },
    );

    return data.user ?? null;
  }

  private async getProjectStageFields(owner: string, projectNumber: number): Promise<Array<GraphqlProjectField | null>> {
    const organizationFields = await this.tryGetOrganizationStageFields(owner, projectNumber);
    if (organizationFields !== null) {
      return organizationFields;
    }

    const userFields = await this.tryGetUserStageFields(owner, projectNumber);
    return userFields ?? [];
  }

  private async tryGetOrganizationStageFields(
    owner: string,
    projectNumber: number,
  ): Promise<Array<GraphqlProjectField | null> | null> {
    const project = await this.client.graphql<{
      organization?: {
        projectV2?: {
          fields?: {
            nodes?: Array<GraphqlProjectField | null> | null;
          } | null;
        } | null;
      } | null;
    }>(
      `
        query GetOrganizationProjectStageField($owner: String!, $number: Int!) {
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
        }
      `,
      { owner, number: projectNumber },
    );

    return project.organization?.projectV2?.fields?.nodes ?? null;
  }

  private async tryGetUserStageFields(
    owner: string,
    projectNumber: number,
  ): Promise<Array<GraphqlProjectField | null> | null> {
    const project = await this.client.graphql<{
      user?: {
        projectV2?: {
          fields?: {
            nodes?: Array<GraphqlProjectField | null> | null;
          } | null;
        } | null;
      } | null;
    }>(
      `
        query GetUserProjectStageField($owner: String!, $number: Int!) {
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

    return project.user?.projectV2?.fields?.nodes ?? null;
  }
}
