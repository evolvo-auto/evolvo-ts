import { describe, expect, it } from "vitest";
import type { StagedProjectInventory, StagedWorkItem } from "../../issues/stagedWorkInventory.js";
import type { ProjectRecord } from "../../projects/projectRegistry.js";
import { createDefaultProjectWorkflow } from "../../projects/projectWorkflow.js";
import { chooseRoundRobinProjectStageItem, isWorkerActiveProject, selectLowestIssueStageItem } from "./boardQueries.js";

function createProject(slug: string): ProjectRecord {
  return {
    slug,
    displayName: slug,
    kind: slug === "evolvo" ? "default" : "managed",
    issueLabel: `project:${slug}`,
    trackerRepo: {
      owner: "Evolvo-org",
      repo: "evolvo-ts",
      url: "https://github.com/Evolvo-org/evolvo-ts",
    },
    executionRepo: {
      owner: "Evolvo-org",
      repo: slug,
      url: `https://github.com/Evolvo-org/${slug}`,
      defaultBranch: "main",
    },
    cwd: `/tmp/${slug}`,
    status: "active",
    sourceIssueNumber: null,
    createdAt: "2026-03-08T00:00:00.000Z",
    updatedAt: "2026-03-08T00:00:00.000Z",
    provisioning: {
      labelCreated: true,
      repoCreated: true,
      workspacePrepared: true,
      lastError: null,
    },
    workflow: createDefaultProjectWorkflow("Evolvo-org"),
  };
}

function createItem(project: ProjectRecord, issueNumber: number, stage: StagedWorkItem["stage"]): StagedWorkItem {
  return {
    queueKey: `${project.slug}#${issueNumber}`,
    project,
    issueNumber,
    issueUrl: `https://github.com/${project.executionRepo.owner}/${project.executionRepo.repo}/issues/${issueNumber}`,
    title: `Issue ${issueNumber}`,
    description: `Description ${issueNumber}`,
    labels: [],
    stage,
    boardItemId: `item-${project.slug}-${issueNumber}`,
    issueNodeId: `issue-node-${project.slug}-${issueNumber}`,
    repository: {
      owner: project.executionRepo.owner,
      repo: project.executionRepo.repo,
      url: project.executionRepo.url,
      reference: `${project.executionRepo.owner}/${project.executionRepo.repo}`,
    },
  };
}

function createProjectInventory(project: ProjectRecord, items: StagedWorkItem[], activityState: "active" | "stopped"): StagedProjectInventory {
  return {
    project,
    activity: {
      slug: project.slug,
      activityState,
      deferredStopMode: null,
      requestedBy: "operator",
      updatedAt: "2026-03-08T00:00:00.000Z",
      currentCodingLease: null,
      currentWorkItem: null,
      lastStageTransition: null,
      schedulingEligibility: { eligible: activityState === "active", reason: null, lastScheduledAt: null },
      lastFailure: null,
    },
    items,
    countsByStage: {
      Inbox: items.filter((item) => item.stage === "Inbox").length,
      Planning: items.filter((item) => item.stage === "Planning").length,
      "Ready for Dev": items.filter((item) => item.stage === "Ready for Dev").length,
      "In Dev": items.filter((item) => item.stage === "In Dev").length,
      "Ready for Review": items.filter((item) => item.stage === "Ready for Review").length,
      "In Review": items.filter((item) => item.stage === "In Review").length,
      "Ready for Release": items.filter((item) => item.stage === "Ready for Release").length,
      Releasing: items.filter((item) => item.stage === "Releasing").length,
      Blocked: items.filter((item) => item.stage === "Blocked").length,
      Done: items.filter((item) => item.stage === "Done").length,
    },
  };
}

describe("boardQueries", () => {
  it("treats active projects and the default evolvo project as runnable", () => {
    const activeProject = createProjectInventory(createProject("evolvo-web"), [], "active");
    const stoppedManagedProject = createProjectInventory(createProject("habit-cli"), [], "stopped");
    const defaultStoppedProject = createProjectInventory(createProject("evolvo"), [], "stopped");

    expect(isWorkerActiveProject(activeProject)).toBe(true);
    expect(isWorkerActiveProject(stoppedManagedProject)).toBe(false);
    expect(isWorkerActiveProject(defaultStoppedProject)).toBe(true);
  });

  it("selects the lowest issue number within a stage", () => {
    const project = createProject("evolvo-web");
    const items = [
      createItem(project, 9, "Ready for Review"),
      createItem(project, 2, "Ready for Review"),
      createItem(project, 5, "In Dev"),
    ];

    expect(selectLowestIssueStageItem(items, "Ready for Review")?.issueNumber).toBe(2);
    expect(selectLowestIssueStageItem(items, "Blocked")).toBeNull();
  });

  it("round-robins across active projects from the last cursor", () => {
    const alpha = createProject("alpha");
    const beta = createProject("beta");
    const gamma = createProject("gamma");
    const projects = [
      createProjectInventory(alpha, [createItem(alpha, 10, "Ready for Review")], "active"),
      createProjectInventory(beta, [createItem(beta, 3, "Ready for Review")], "active"),
      createProjectInventory(gamma, [createItem(gamma, 5, "Planning")], "active"),
    ];

    expect(chooseRoundRobinProjectStageItem(projects, null, "Ready for Review")).toEqual({
      project: projects[0],
      item: projects[0]?.items[0],
    });
    expect(chooseRoundRobinProjectStageItem(projects, "alpha", "Ready for Review")).toEqual({
      project: projects[1],
      item: projects[1]?.items[0],
    });
    expect(chooseRoundRobinProjectStageItem(projects, "beta", "Ready for Review")).toEqual({
      project: projects[0],
      item: projects[0]?.items[0],
    });
  });
});