import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("validation pipeline", () => {
  it("runs lint as part of pnpm validate", async () => {
    const packageJson = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.lint).toBe(
      "pnpm exec tsc --noEmit --noUnusedLocals --noUnusedParameters -p tsconfig.json",
    );
    expect(packageJson.scripts?.validate).toBe("pnpm typecheck && pnpm lint && pnpm build && pnpm test");
  });

  it("documents lint in the standard validation pipeline", async () => {
    const readme = await readFile(join(REPO_ROOT, "README.md"), "utf8");

    expect(readme).toContain("2. `pnpm lint`");
    expect(readme).toContain("pnpm lint       # compiler-backed unused-code/static analysis");
    expect(readme).toContain("pnpm validate   # typecheck + lint + build + test");
    expect(readme).toContain("`pnpm test`, `pnpm typecheck`, `pnpm lint`");
  });
});
