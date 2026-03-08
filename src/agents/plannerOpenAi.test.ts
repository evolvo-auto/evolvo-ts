import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();
const fetchMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

describe("plannerOpenAi", () => {
  beforeEach(() => {
    vi.resetModules();
    execFileMock.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("calls the Responses API, requires initial repository inspection, and feeds tool output back to the model", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "planner-openai-"));
    await mkdir(join(workDir, "src"), { recursive: true });
    await writeFile(join(workDir, "README.md"), "# Evolvo\n", "utf8");
    await writeFile(join(workDir, "src", "main.ts"), "export const main = true;\n", "utf8");

    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "completed",
            output: [
              { type: "reasoning" },
              {
                type: "function_call",
                call_id: "call_list_repo",
                name: "list_repository_entries",
                arguments: JSON.stringify({ path: ".", limit: 10 }),
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "completed",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify({
                      issues: [
                        {
                          title: "Investigate planner routing hotspots",
                          description: "Ground planner issue selection in current repository hotspots.",
                        },
                      ],
                    }),
                  },
                ],
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );

    try {
      const { PLANNER_OPENAI_MODEL, runPlannerOpenAi } = await import("./plannerOpenAi.js");

      const result = await runPlannerOpenAi({
        apiKey: "planner-key",
        prompt: "Inspect the repository and return JSON issues.",
        workDir,
      });

      expect(result.finalResponse).toContain("Investigate planner routing hotspots");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        "https://api.openai.com/v1/responses",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer planner-key",
            "Content-Type": "application/json",
          }),
        }),
      );

      const firstRequest = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
        model: string;
        tool_choice: string;
        input: Array<{ role?: string; content?: string }>;
        tools: Array<{ name: string }>;
      };
      expect(firstRequest.model).toBe(PLANNER_OPENAI_MODEL);
      expect(firstRequest.tool_choice).toBe("required");
      expect(firstRequest.input).toEqual([{ role: "user", content: "Inspect the repository and return JSON issues." }]);
      expect(firstRequest.tools.map((tool) => tool.name)).toEqual([
        "list_repository_entries",
        "read_repository_file",
        "search_repository",
      ]);

      const secondRequest = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string) as {
        tool_choice: string;
        input: Array<{ type?: string; call_id?: string; output?: string }>;
      };
      expect(secondRequest.tool_choice).toBe("auto");

      const toolOutput = secondRequest.input.find((item) => item.type === "function_call_output");
      expect(toolOutput).toEqual(
        expect.objectContaining({
          type: "function_call_output",
          call_id: "call_list_repo",
        }),
      );

      const parsedToolOutput = JSON.parse(toolOutput?.output ?? "{}") as {
        ok: boolean;
        entries: Array<{ path: string; type: string }>;
      };
      expect(parsedToolOutput.ok).toBe(true);
      expect(parsedToolOutput.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "README.md", type: "file" }),
          expect.objectContaining({ path: "src", type: "directory" }),
        ]),
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("reads bounded repository file ranges for planner inspection", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "planner-openai-read-"));
    await mkdir(join(workDir, "src"), { recursive: true });
    await writeFile(join(workDir, "src", "example.ts"), "first\nsecond\nthird\nfourth\n", "utf8");

    try {
      const { runPlannerRepositoryTool } = await import("./plannerOpenAi.js");

      const result = await runPlannerRepositoryTool(
        "read_repository_file",
        {
          path: "src/example.ts",
          startLine: 2,
          lineCount: 2,
        },
        workDir,
      );

      expect(result).toEqual(
        expect.objectContaining({
          ok: true,
          path: "src/example.ts",
          startLine: 2,
          endLine: 3,
          totalLines: 4,
          truncated: true,
          content: "2: second\n3: third",
        }),
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("falls back to JavaScript search when ripgrep is unavailable", async () => {
    execFileMock.mockImplementation(
      (_command: string, _args: string[], _options: unknown, callback: (error: Error, stdout: string, stderr: string) => void) => {
        const error = Object.assign(new Error("ripgrep missing"), { code: "ENOENT" });
        callback(error, "", "");
      },
    );

    const workDir = await mkdtemp(join(tmpdir(), "planner-openai-search-"));
    await writeFile(join(workDir, "notes.txt"), "first line\nplanner issue evidence\n", "utf8");

    try {
      const { runPlannerRepositoryTool } = await import("./plannerOpenAi.js");

      const result = await runPlannerRepositoryTool(
        "search_repository",
        {
          query: "planner",
          path: ".",
          limit: 5,
        },
        workDir,
      );

      expect(result).toEqual(
        expect.objectContaining({
          ok: true,
          path: ".",
          query: "planner",
          fallback: "javascript-search",
        }),
      );
      expect(result.results).toEqual([expect.stringContaining("notes.txt:2:planner issue evidence")]);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});
