import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  consumeGracefulShutdownRequest,
  getDiscordControlCursorPath,
  getGracefulShutdownRequestPath,
  readDiscordControlCursor,
  readGracefulShutdownRequest,
  recordDiscordControlCommandReceipt,
  recordGracefulShutdownRequest,
  writeDiscordControlCursor,
} from "./gracefulShutdown.js";

async function createTempWorkDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "graceful-shutdown-"));
}

describe("gracefulShutdown", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("records a pending graceful shutdown request once and preserves the first request details", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    const first = await recordGracefulShutdownRequest(workDir, {
      messageId: "9001",
      requestedAt: "2026-03-07T12:00:00.000Z",
    });
    const second = await recordGracefulShutdownRequest(workDir, {
      messageId: "9002",
      requestedAt: "2026-03-07T12:05:00.000Z",
    });

    expect(first).toEqual({
      created: true,
      request: {
        version: 1,
        source: "discord",
        command: "/quit",
        mode: "after-current-task",
        messageId: "9001",
        requestedAt: "2026-03-07T12:00:00.000Z",
      },
    });
    expect(second).toEqual({
      created: false,
      request: first.request,
    });
    await expect(readGracefulShutdownRequest(workDir)).resolves.toEqual(first.request);
  });

  it("consumes and clears a pending graceful shutdown request", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    await recordGracefulShutdownRequest(workDir, {
      messageId: "9010",
      requestedAt: "2026-03-07T13:00:00.000Z",
    });

    await expect(consumeGracefulShutdownRequest(workDir)).resolves.toEqual({
      version: 1,
      source: "discord",
      command: "/quit",
      mode: "after-current-task",
      messageId: "9010",
      requestedAt: "2026-03-07T13:00:00.000Z",
    });
    await expect(consumeGracefulShutdownRequest(workDir)).resolves.toBeNull();
  });

  it("records queue-drain shutdown requests with the after-tasks mode", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    const result = await recordGracefulShutdownRequest(workDir, {
      messageId: "9050",
      requestedAt: "2026-03-07T13:30:00.000Z",
      mode: "after-tasks",
    });

    expect(result).toEqual({
      created: true,
      request: {
        version: 1,
        source: "discord",
        command: "/quit after tasks",
        mode: "after-tasks",
        messageId: "9050",
        requestedAt: "2026-03-07T13:30:00.000Z",
      },
    });
    await expect(readGracefulShutdownRequest(workDir)).resolves.toEqual(result.request);
  });

  it("preserves malformed Discord control cursor state and rewrites a recoverable default", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T15:00:00.000Z"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await writeDiscordControlCursor(workDir, "  7777  ");
    expect(await readDiscordControlCursor(workDir)).toBe("7777");

    const cursorPath = getDiscordControlCursorPath(workDir);
    const corruptCursorPath = cursorPath.replace(".json", ".corrupt-1772895600000.json");
    await writeFile(cursorPath, "{not-json", "utf8");

    await expect(readDiscordControlCursor(workDir)).resolves.toBeNull();
    await expect(readFile(cursorPath, "utf8")).resolves.toBe(
      `${JSON.stringify({ lastSeenMessageId: null, recoveredMalformed: true }, null, 2)}\n`,
    );
    await expect(readFile(corruptCursorPath, "utf8")).resolves.toBe("{not-json");
    expect(warnSpy).toHaveBeenCalledWith(
      `Recovered malformed discord control cursor state store at ${cursorPath}; preserved corrupt file at ${corruptCursorPath}.`,
    );
  });

  it("preserves malformed graceful shutdown state and rewrites a clean default", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T16:00:00.000Z"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const requestPath = getGracefulShutdownRequestPath(workDir);
    const corruptRequestPath = requestPath.replace(".json", ".corrupt-1772899200000.json");
    await recordGracefulShutdownRequest(workDir, { messageId: "seed-request" });
    await writeFile(requestPath, JSON.stringify({ version: 1, source: "discord", command: "/quit", messageId: "   " }), "utf8");

    await expect(readGracefulShutdownRequest(workDir)).resolves.toBeNull();
    await expect(readFile(requestPath, "utf8")).resolves.toBe("null\n");
    await expect(readFile(corruptRequestPath, "utf8")).resolves.toBe(
      `${JSON.stringify({ version: 1, source: "discord", command: "/quit", messageId: "   " })}`,
    );
    expect(warnSpy).toHaveBeenCalledWith(
      `Recovered malformed graceful shutdown request store at ${requestPath}; preserved corrupt file at ${corruptRequestPath}.`,
    );
  });

  it("normalizes persisted graceful shutdown payloads", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    await recordGracefulShutdownRequest(workDir, { messageId: "seed-request" });
    await writeFile(
      getGracefulShutdownRequestPath(workDir),
      JSON.stringify({
        version: 1,
        source: "discord",
        command: "/quit",
        messageId: "9200",
        requestedAt: "2026-03-07T15:00:00.000Z",
      }),
      "utf8",
    );
    await expect(readGracefulShutdownRequest(workDir)).resolves.toEqual({
      version: 1,
      source: "discord",
      command: "/quit",
      mode: "after-current-task",
      messageId: "9200",
      requestedAt: "2026-03-07T15:00:00.000Z",
    });
  });

  it("records Discord control receipts once per message id", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);

    await expect(
      recordDiscordControlCommandReceipt(workDir, {
        command: "start-project",
        messageId: "9100",
        recordedAt: "2026-03-07T14:00:00.000Z",
      }),
    ).resolves.toBe(true);
    await expect(
      recordDiscordControlCommandReceipt(workDir, {
        command: "start-project",
        messageId: "9100",
        recordedAt: "2026-03-07T14:05:00.000Z",
      }),
    ).resolves.toBe(false);
  });
});
