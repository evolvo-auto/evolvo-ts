import { describe, expect, it } from "vitest";
import { parseWorkflowRuntimeCommand } from "./workerCli.js";

describe("workerCli", () => {
  it("treats no args as supervisor mode", () => {
    expect(parseWorkflowRuntimeCommand([])).toEqual({ kind: "supervisor" });
  });

  it("parses explicit supervisor mode", () => {
    expect(parseWorkflowRuntimeCommand(["supervisor"])).toEqual({ kind: "supervisor" });
  });

  it("parses global worker roles", () => {
    expect(parseWorkflowRuntimeCommand(["worker", "planner"])).toEqual({
      kind: "worker",
      role: "planner",
      projectSlug: null,
    });
  });

  it("parses dev workers with project slug", () => {
    expect(parseWorkflowRuntimeCommand(["worker", "dev", "habit-cli"])).toEqual({
      kind: "worker",
      role: "dev",
      projectSlug: "habit-cli",
    });
  });

  it("returns null for non-runtime commands", () => {
    expect(parseWorkflowRuntimeCommand(["issues", "list"])).toBeNull();
  });

  it("rejects invalid worker command shapes", () => {
    expect(() => parseWorkflowRuntimeCommand(["worker", "unknown-role"])).toThrow(
      "Worker command requires a valid role",
    );
    expect(() => parseWorkflowRuntimeCommand(["worker", "dev"])).toThrow(
      "Dev worker command requires a project slug.",
    );
  });
});
