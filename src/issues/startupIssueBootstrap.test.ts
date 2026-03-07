import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateStartupIssueTemplates } from "./startupIssueBootstrap.js";

const tempDirs: string[] = [];

async function createTempRepo(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "evolvo-startup-bootstrap-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("generateStartupIssueTemplates", () => {
  it("derives startup issues from repository signals", async () => {
    const repoRoot = await createTempRepo();
    await mkdir(join(repoRoot, "src"), { recursive: true });
    await writeFile(
      join(repoRoot, "package.json"),
      JSON.stringify(
        {
          name: "repo",
          scripts: {
            test: "vitest",
          },
        },
        null,
        2,
      ),
    );
    await writeFile(join(repoRoot, "README.md"), "short");
    await writeFile(join(repoRoot, "src", "orchestration.ts"), "export const value = 1;\n");

    const templates = await generateStartupIssueTemplates(repoRoot, { targetCount: 3 });

    expect(templates).toHaveLength(3);
    expect(templates.map((template) => template.title)).toEqual([
      "Add a dedicated typecheck script to validation workflow",
      "Add CI workflow for build and test validation",
      "Add regression tests for src/orchestration.ts",
    ]);
  });

  it("falls back to built-in templates when repository signals are insufficient", async () => {
    const repoRoot = await createTempRepo();
    await mkdir(join(repoRoot, ".github", "workflows"), { recursive: true });
    await mkdir(join(repoRoot, "src"), { recursive: true });
    await writeFile(
      join(repoRoot, "package.json"),
      JSON.stringify(
        {
          name: "repo",
          scripts: {
            typecheck: "tsc --noEmit",
          },
        },
        null,
        2,
      ),
    );
    await writeFile(join(repoRoot, "README.md"), "This readme is intentionally long enough to skip docs bootstrap.".repeat(3));
    await writeFile(join(repoRoot, "src", "index.ts"), "export const value = 1;\n");
    await writeFile(join(repoRoot, "src", "index.test.ts"), "import { expect, it } from \"vitest\";\nit(\"ok\", () => { expect(true).toBe(true); });\n");

    const templates = await generateStartupIssueTemplates(repoRoot, { targetCount: 3 });

    expect(templates).toHaveLength(3);
    expect(templates[0]?.title).toBe("Harden startup diagnostics when bootstrap issue creation fails");
  });

  it("returns deterministic bounded templates when repository files are mostly missing", async () => {
    const repoRoot = await createTempRepo();

    const first = await generateStartupIssueTemplates(repoRoot, { targetCount: 5 });
    const second = await generateStartupIssueTemplates(repoRoot, { targetCount: 5 });

    expect(first).toHaveLength(5);
    expect(second).toEqual(first);
    expect(first.map((template) => template.title)).toEqual([
      "Add a dedicated typecheck script to validation workflow",
      "Add CI workflow for build and test validation",
      "Harden startup diagnostics when bootstrap issue creation fails",
      "Add startup bootstrap integration test for empty-repo issue queue",
      "Emit per-cycle summary logs for issue queue health",
    ]);
  });

  it("handles unreadable README files without failing", async () => {
    const repoRoot = await createTempRepo();
    await mkdir(join(repoRoot, ".github", "workflows"), { recursive: true });
    await mkdir(join(repoRoot, "src"), { recursive: true });
    await writeFile(
      join(repoRoot, "package.json"),
      JSON.stringify(
        {
          name: "repo",
          scripts: {
            typecheck: "tsc --noEmit",
          },
        },
        null,
        2,
      ),
    );
    await writeFile(join(repoRoot, "src", "index.ts"), "export const value = 1;\n");
    await writeFile(join(repoRoot, "src", "index.test.ts"), "import { expect, it } from \"vitest\";\nit(\"ok\", () => { expect(true).toBe(true); });\n");
    const readmePath = join(repoRoot, "README.md");
    await writeFile(readmePath, "short");
    await chmod(readmePath, 0o000);

    const templates = await generateStartupIssueTemplates(repoRoot, { targetCount: 3 });

    expect(templates).toHaveLength(3);
    expect(templates[0]?.title).toBe("Harden startup diagnostics when bootstrap issue creation fails");
  });

  it("deduplicates duplicate fallback template titles", async () => {
    const repoRoot = await createTempRepo();
    await mkdir(join(repoRoot, ".github", "workflows"), { recursive: true });
    await mkdir(join(repoRoot, "src"), { recursive: true });
    await writeFile(
      join(repoRoot, "package.json"),
      JSON.stringify(
        {
          name: "repo",
          scripts: {
            typecheck: "tsc --noEmit",
          },
        },
        null,
        2,
      ),
    );
    await writeFile(join(repoRoot, "README.md"), "This readme is intentionally long enough to skip docs bootstrap.".repeat(3));
    await writeFile(join(repoRoot, "src", "index.ts"), "export const value = 1;\n");
    await writeFile(join(repoRoot, "src", "index.test.ts"), "import { expect, it } from \"vitest\";\nit(\"ok\", () => { expect(true).toBe(true); });\n");

    const templates = await generateStartupIssueTemplates(repoRoot, {
      targetCount: 3,
      fallbackTemplates: [
        { title: "Alpha", description: "A" },
        { title: " alpha ", description: "A duplicate with spacing and casing" },
        { title: "Beta", description: "B" },
        { title: "Gamma", description: "C" },
      ],
    });

    expect(templates.map((template) => template.title)).toEqual(["Alpha", "Beta", "Gamma"]);
  });
});
