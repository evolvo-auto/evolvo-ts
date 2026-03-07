import { promises as fs } from "node:fs";
import { join, relative } from "node:path";

export type IssueTemplate = {
  title: string;
  description: string;
};

type PackageJsonShape = {
  scripts?: Record<string, string>;
};

const FALLBACK_TEMPLATES: IssueTemplate[] = [
  {
    title: "Harden startup diagnostics when bootstrap issue creation fails",
    description:
      "Add clearer startup diagnostics around issue bootstrapping so empty-queue failures are easy to debug and recover from.",
  },
  {
    title: "Add startup bootstrap integration test for empty-repo issue queue",
    description:
      "Add an integration-style test that verifies startup creates initial issues and proceeds into normal issue selection.",
  },
  {
    title: "Emit per-cycle summary logs for issue queue health",
    description:
      "Add concise per-cycle queue health logs covering open count, selected issue, and bootstrap/replenishment outcomes.",
  },
];

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function readPackageJson(repoRoot: string): Promise<PackageJsonShape> {
  try {
    const raw = await fs.readFile(join(repoRoot, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as PackageJsonShape;
    }

    return {};
  } catch {
    return {};
  }
}

async function listTypeScriptFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolutePath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTypeScriptFiles(absolutePath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(absolutePath);
    }
  }

  return files;
}

function uniqueByTitle(templates: IssueTemplate[]): IssueTemplate[] {
  const seen = new Set<string>();
  const unique: IssueTemplate[] = [];

  for (const template of templates) {
    const normalized = template.title.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    unique.push(template);
  }

  return unique;
}

export async function generateStartupIssueTemplates(
  repoRoot: string,
  options: { targetCount: number } = { targetCount: 3 },
): Promise<IssueTemplate[]> {
  const targetCount = Math.max(0, Math.floor(options.targetCount));
  if (targetCount === 0) {
    return [];
  }

  const packageJson = await readPackageJson(repoRoot);
  const scripts = packageJson.scripts ?? {};
  const srcRoot = join(repoRoot, "src");
  const templates: IssueTemplate[] = [];

  if (!scripts.typecheck) {
    templates.push({
      title: "Add a dedicated typecheck script to validation workflow",
      description:
        "Add a `typecheck` script and integrate it into the validation flow so static type regressions are caught before review and commit.",
    });
  }

  if (!(await pathExists(join(repoRoot, ".github", "workflows")))) {
    templates.push({
      title: "Add CI workflow for build and test validation",
      description:
        "Create a GitHub Actions workflow that runs build and tests on pull requests to catch runtime and integration regressions earlier.",
    });
  }

  if (await pathExists(srcRoot)) {
    try {
      const sourceFiles = await listTypeScriptFiles(srcRoot);
      const sourceFileSet = new Set(sourceFiles);
      const missingTests = sourceFiles
        .filter((filePath) => !filePath.endsWith(".test.ts"))
        .filter((filePath) => !sourceFileSet.has(filePath.replace(/\.ts$/u, ".test.ts")))
        .map((filePath) => relative(repoRoot, filePath))
        .sort();

      const firstMissingTest = missingTests[0];
      if (firstMissingTest) {
        templates.push({
          title: `Add regression tests for ${firstMissingTest}`,
          description: `Add focused tests for \`${firstMissingTest}\` and cover key success/failure paths to improve reliability of future self-edits.`,
        });
      }
    } catch {
      // Ignore repository scan failures and continue with fallback templates.
    }
  }

  const readmePath = join(repoRoot, "README.md");
  if (await pathExists(readmePath)) {
    try {
      const readme = await fs.readFile(readmePath, "utf8");
      if (readme.trim().length < 120) {
        templates.push({
          title: "Improve README with runtime and issue-loop operating guide",
          description:
            "Document startup flow, issue lifecycle, and validation expectations to reduce operator error and speed recovery during failures.",
        });
      }
    } catch {
      // Ignore README read failures and continue with fallback templates.
    }
  }

  const combined = uniqueByTitle([...templates, ...FALLBACK_TEMPLATES]);
  return combined.slice(0, targetCount);
}
