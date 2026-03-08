import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { join, relative } from "node:path";
import { promisify } from "node:util";

export type IssueTemplate = {
  title: string;
  description: string;
};

type PackageJsonShape = {
  scripts?: Record<string, string>;
};

type PackageJsonReadResult =
  | {
    status: "ok";
    packageJson: PackageJsonShape;
  }
  | {
    status: "missing";
  }
  | {
    status: "malformed" | "unreadable";
    errorMessage: string;
  };

const IGNORED_SCAN_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "coverage", ".turbo"]);
const execFileAsync = promisify(execFile);

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function readPackageJson(repoRoot: string): Promise<PackageJsonReadResult> {
  try {
    const raw = await fs.readFile(join(repoRoot, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      return {
        status: "ok",
        packageJson: parsed as PackageJsonShape,
      };
    }

    return {
      status: "malformed",
      errorMessage: "package.json must contain a JSON object at the top level.",
    };
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === "ENOENT") {
      return {
        status: "missing",
      };
    }

    if (error instanceof SyntaxError) {
      return {
        status: "malformed",
        errorMessage: error.message,
      };
    }

    return {
      status: "unreadable",
      errorMessage: error instanceof Error ? error.message : "unknown package.json read error",
    };
  }
}

function buildPackageJsonBootstrapTemplate(result: Extract<PackageJsonReadResult, {
  status: "malformed" | "unreadable";
}>): IssueTemplate {
  if (result.status === "malformed") {
    return {
      title: "Repair malformed package.json metadata",
      description:
        "Fix `package.json` so startup bootstrap can read repository scripts and metadata reliably. Current parse error: " +
        `\`${result.errorMessage}\`. Until this is fixed, bootstrap planning cannot trust package-based signals.`,
    };
  }

  return {
    title: "Restore readable package.json metadata",
    description:
      "Fix repository access to `package.json` so startup bootstrap can inspect scripts and metadata reliably. Current read error: " +
      `\`${result.errorMessage}\`. Until this is fixed, bootstrap planning cannot trust package-based signals.`,
  };
}

async function listTypeScriptFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolutePath = join(root, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_SCAN_DIRECTORIES.has(entry.name)) {
        continue;
      }
      files.push(...(await listTypeScriptFiles(absolutePath)));
      continue;
    }

    if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      files.push(absolutePath);
    }
  }

  return files;
}

async function listTrackedTypeScriptFiles(repoRoot: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoRoot, "ls-files", "*.ts", "*.tsx"]);
    const files = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((relativePath) => join(repoRoot, relativePath));
    return files;
  } catch {
    return null;
  }
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
  if (packageJson.status === "malformed" || packageJson.status === "unreadable") {
    return [buildPackageJsonBootstrapTemplate(packageJson)].slice(0, targetCount);
  }

  const scripts = packageJson.status === "ok" ? packageJson.packageJson.scripts ?? {} : {};
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

  const trackedTypeScriptFiles = await listTrackedTypeScriptFiles(repoRoot);
  const allTypeScriptFiles = trackedTypeScriptFiles ?? (await listTypeScriptFiles(repoRoot));
  const sourceFiles = allTypeScriptFiles
    .filter((filePath) => !filePath.endsWith(".d.ts"))
    .filter((filePath) => !/(\.test|\.spec)\.tsx?$/u.test(filePath))
    .sort();
  const sourceFileByBase = new Map(sourceFiles.map((filePath) => [filePath.replace(/\.tsx?$/u, ""), filePath] as const));
  const testFiles = new Set(
    allTypeScriptFiles
      .filter((filePath) => /(\.test|\.spec)\.tsx?$/u.test(filePath))
      .map((filePath) => filePath.replace(/(\.test|\.spec)\.tsx?$/u, "")),
  );

  const missingTests = [...sourceFileByBase.entries()]
    .filter(([fileBasePath]) => !testFiles.has(fileBasePath))
    .map(([, sourceFilePath]) => sourceFilePath)
    .map((filePath) => relative(repoRoot, filePath));

  for (const missingTestFilePath of missingTests) {
    if (templates.length >= targetCount) {
      break;
    }

    templates.push({
      title: `Add regression tests for ${missingTestFilePath}`,
      description: `Add focused tests for \`${missingTestFilePath}\` and cover key success/failure paths to improve reliability of future self-edits.`,
    });
  }

  const readmePath = join(repoRoot, "README.md");
  if (await pathExists(readmePath)) {
    try {
      const readme = await fs.readFile(readmePath, "utf8");
      if (readme.trim().length < 200 && templates.length < targetCount) {
        templates.push({
          title: "Improve README with runtime and issue-loop operating guide",
          description:
            "Document startup flow, issue lifecycle, and validation expectations to reduce operator error and speed recovery during failures.",
        });
      }
    } catch {
      // Ignore README read failures and continue with bounded repository-derived candidates.
    }
  }

  return uniqueByTitle(templates).slice(0, targetCount);
}
