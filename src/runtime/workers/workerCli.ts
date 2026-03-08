import type { WorkerRole } from "./workerTypes.js";

export type WorkflowRuntimeCommand =
  | {
    kind: "supervisor";
  }
  | {
    kind: "worker";
    role: WorkerRole;
    projectSlug: string | null;
  };

function normalizeWorkerRole(value: string): WorkerRole | null {
  return value === "issue-generator"
    || value === "planner"
    || value === "review"
    || value === "release"
    || value === "dev"
    ? value
    : null;
}

export function parseWorkflowRuntimeCommand(args: string[]): WorkflowRuntimeCommand | null {
  if (args.length === 0) {
    return { kind: "supervisor" };
  }

  if (args[0] === "supervisor") {
    return { kind: "supervisor" };
  }

  if (args[0] !== "worker") {
    return null;
  }

  const role = normalizeWorkerRole(args[1] ?? "");
  if (role === null) {
    throw new Error("Worker command requires a valid role: issue-generator, planner, review, release, or dev.");
  }

  if (role === "dev") {
    const projectSlug = args[2]?.trim();
    if (!projectSlug) {
      throw new Error("Dev worker command requires a project slug.");
    }

    return {
      kind: "worker",
      role,
      projectSlug,
    };
  }

  return {
    kind: "worker",
    role,
    projectSlug: null,
  };
}
