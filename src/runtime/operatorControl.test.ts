import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as gracefulShutdown from "./gracefulShutdown.js";
import {
  getDiscordControlConfigFromEnv,
  notifyIssueStartedInDiscord,
  pollDiscordGracefulShutdownCommand,
  requestCycleLimitDecisionFromOperator,
  runDiscordOperatorControlStartupCheck,
} from "./operatorControl.js";

async function createTempWorkDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "operator-control-"));
}

function createDiscordControlMessage(id: number, content: string, authorId = "someone"): {
  id: string;
  content: string;
  author: { id: string };
} {
  return {
    id: String(id),
    content,
    author: { id: authorId },
  };
}

describe("operatorControl", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("returns null config when required Discord environment variables are missing", () => {
    expect(getDiscordControlConfigFromEnv({})).toBeNull();
  });

  it("returns null decision when Discord operator control is not configured", async () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const decision = await requestCycleLimitDecisionFromOperator(100);

    expect(decision).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not send an issue-start notification when Discord operator control is not configured", async () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await notifyIssueStartedInDiscord({
      issue: {
        number: 298,
        title: "Send Discord start embed",
      },
      executionContext: {
        trackerRepository: "evolvo-auto/evolvo-ts",
        executionRepository: "evolvo-auto/evolvo-ts",
        project: {
          displayName: "Evolvo",
          slug: "evolvo",
        },
      },
      lifecycleState: "selected -> executing",
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("logs startup preflight success when channel lookup and history read are accessible", async () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");

    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "channel-1", guild_id: "guild-1" }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "boot-1" }), { status: 200 }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchSpy);

    await runDiscordOperatorControlStartupCheck();

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(logSpy).toHaveBeenCalledWith(
      "Discord operator control startup preflight passed (verify-channel, read-history).",
    );
    expect(logSpy).toHaveBeenCalledWith("Discord operator control startup boot message posted.");
    expect(fetchSpy).toHaveBeenNthCalledWith(
      3,
      "https://discord.com/api/v10/channels/channel-1/messages",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("graceful shutdown"),
      }),
    );
  });

  it("logs startup preflight step when Discord channel verification fails", async () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");

    const fetchSpy = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ message: "Missing Access", code: 50001 }),
        { status: 403 },
      ),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchSpy);

    await runDiscordOperatorControlStartupCheck();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Discord operator control startup preflight failed: [verify-channel]"),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      "Discord bot is missing access to the configured control channel. Verify DISCORD_CONTROL_GUILD_ID, DISCORD_CONTROL_CHANNEL_ID, and bot channel permissions.",
    );
  });

  it("logs startup boot message failure step when message post is denied", async () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");

    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "channel-1", guild_id: "guild-1" }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ message: "Missing Access", code: 50001 }),
          { status: 403 },
        ),
      );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchSpy);

    await runDiscordOperatorControlStartupCheck();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Discord operator control startup boot message failed: [send-boot-message]"),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      "Discord bot is missing access to the configured control channel. Verify DISCORD_CONTROL_GUILD_ID, DISCORD_CONTROL_CHANNEL_ID, and bot channel permissions.",
    );
  });

  it("sends an embed issue-start notification with a GitHub link button", async () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");

    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "channel-1", guild_id: "guild-1" }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "message-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await notifyIssueStartedInDiscord({
      issue: {
        number: 298,
        title: "Send a Discord embed notification with GitHub issue link when starting a new issue",
      },
      executionContext: {
        trackerRepository: "evolvo-auto/evolvo-ts",
        executionRepository: "evolvo-auto/evolvo-ts",
        project: {
          displayName: "Evolvo",
          slug: "evolvo",
        },
      },
      lifecycleState: "selected -> executing",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      "https://discord.com/api/v10/channels/channel-1",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bot bot-token",
        }),
      }),
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      "https://discord.com/api/v10/channels/channel-1/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          content: "<@operator-1>",
          embeds: [
            {
              title: "Started Issue #298",
              description: "Send a Discord embed notification with GitHub issue link when starting a new issue",
              url: "https://github.com/evolvo-auto/evolvo-ts/issues/298",
              fields: [
                {
                  name: "State",
                  value: "selected -> executing",
                  inline: true,
                },
                {
                  name: "Tracker Repository",
                  value: "evolvo-auto/evolvo-ts",
                  inline: true,
                },
                {
                  name: "Execution Project",
                  value: "Evolvo (`evolvo`)",
                  inline: true,
                },
                {
                  name: "Execution Repository",
                  value: "evolvo-auto/evolvo-ts",
                  inline: true,
                },
              ],
            },
          ],
          components: [
            {
              type: 1,
              components: [
                {
                  type: 2,
                  style: 5,
                  label: "Open GitHub Issue",
                  url: "https://github.com/evolvo-auto/evolvo-ts/issues/298",
                },
              ],
            },
          ],
        }),
      }),
    );
  });

  it("renders honest unavailable values and omits the GitHub button when tracker data is missing", async () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");

    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "channel-1", guild_id: "guild-1" }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "message-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await notifyIssueStartedInDiscord({
      issue: {
        number: 411,
        title: "   ",
      },
      executionContext: {
        trackerRepository: null,
        executionRepository: " ",
        project: null,
      },
      lifecycleState: null,
    });

    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      "https://discord.com/api/v10/channels/channel-1/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          content: "<@operator-1>",
          embeds: [
            {
              title: "Started Issue #411",
              description: "unavailable",
              fields: [
                {
                  name: "State",
                  value: "unknown",
                  inline: true,
                },
                {
                  name: "Tracker Repository",
                  value: "unknown",
                  inline: true,
                },
                {
                  name: "Execution Project",
                  value: "unavailable",
                  inline: true,
                },
                {
                  name: "Execution Repository",
                  value: "unknown",
                  inline: true,
                },
              ],
            },
          ],
          components: [],
        }),
      }),
    );
  });

  it("logs and swallows issue-start notification failures", async () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");

    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "channel-1", guild_id: "guild-1" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ message: "Missing Access", code: 50001 }),
          { status: 403 },
        ),
      );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchSpy);

    await notifyIssueStartedInDiscord({
      issue: {
        number: 298,
        title: "Send Discord start embed",
      },
      executionContext: {
        trackerRepository: "evolvo-auto/evolvo-ts",
        executionRepository: "evolvo-auto/evolvo-ts",
        project: {
          displayName: "Evolvo",
          slug: "evolvo",
        },
      },
      lifecycleState: "selected -> executing",
    });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Discord issue start notification failed: [send-issue-start]"),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      "Discord bot is missing access to the configured control channel. Verify DISCORD_CONTROL_GUILD_ID, DISCORD_CONTROL_CHANNEL_ID, and bot channel permissions.",
    );
  });

  it("returns continue with configured cycle extension when operator replies continue", async () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");
    vi.stubEnv("DISCORD_CYCLE_EXTENSION", "7");
    vi.stubEnv("DISCORD_OPERATOR_TIMEOUT_MS", "5000");
    vi.stubEnv("DISCORD_OPERATOR_POLL_INTERVAL_MS", "5");

    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "channel-1", guild_id: "guild-1" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "5000" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ id: "5001", content: "continue", author: { id: "operator-1" } }]),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchSpy);

    const decisionPromise = requestCycleLimitDecisionFromOperator(100);
    await vi.runAllTimersAsync();
    const decision = await decisionPromise;

    expect(decision).toEqual({
      decision: "continue",
      additionalCycles: 7,
      source: "discord",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("returns quit when operator replies /quit", async () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");
    vi.stubEnv("DISCORD_OPERATOR_TIMEOUT_MS", "5000");
    vi.stubEnv("DISCORD_OPERATOR_POLL_INTERVAL_MS", "5");

    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "channel-1", guild_id: "guild-1" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "5000" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ id: "5001", content: "/quit", author: { id: "operator-1" } }]),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchSpy);

    const decisionPromise = requestCycleLimitDecisionFromOperator(100);
    await vi.runAllTimersAsync();
    const decision = await decisionPromise;

    expect(decision).toEqual({
      decision: "quit",
      additionalCycles: 0,
      source: "discord",
    });
  });

  it("records and acknowledges an authorized /quit graceful shutdown command", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");

    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "7000", content: "boot", author: { id: "someone" } }]), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ id: "7001", content: "/quit", author: { id: "operator-1" } }]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "ack-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const request = await pollDiscordGracefulShutdownCommand(workDir);

    expect(request).toEqual({
      version: 1,
      source: "discord",
      command: "/quit",
      mode: "after-current-task",
      messageId: "7001",
      requestedAt: expect.any(String),
      enforcedAt: null,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy).toHaveBeenNthCalledWith(
      3,
      "https://discord.com/api/v10/channels/channel-1/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          content: "<@operator-1> Graceful shutdown requested.\nEvolvo will finish the current task and then stop before starting another issue.",
        }),
      }),
    );
  });

  it("records and acknowledges an authorized /quit after tasks queue-drain command", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");

    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "7050", content: "boot", author: { id: "someone" } }]), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ id: "7051", content: "/quit   after   tasks", author: { id: "operator-1" } }]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "ack-queue-drain" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const request = await pollDiscordGracefulShutdownCommand(workDir);

    expect(request).toEqual({
      version: 1,
      source: "discord",
      command: "/quit after tasks",
      mode: "after-tasks",
      messageId: "7051",
      requestedAt: expect.any(String),
      enforcedAt: null,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy).toHaveBeenNthCalledWith(
      3,
      "https://discord.com/api/v10/channels/channel-1/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          content: "<@operator-1> Queue-drain shutdown requested.\nEvolvo will finish the current actionable queue, will not plan or create new work, and will stop once the queue is drained.",
        }),
      }),
    );
  });

  it("replays unread control backlog when the persisted cursor file is malformed", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await gracefulShutdown.writeDiscordControlCursor(workDir, null);
    await writeFile(gracefulShutdown.getDiscordControlCursorPath(workDir), "{not-json", "utf8");

    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            createDiscordControlMessage(7060, "noise"),
            createDiscordControlMessage(7061, "/quit", "operator-1"),
          ]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "ack-recovered-cursor" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const request = await pollDiscordGracefulShutdownCommand(workDir);

    expect(request).toEqual({
      version: 1,
      source: "discord",
      command: "/quit",
      mode: "after-current-task",
      messageId: "7061",
      requestedAt: expect.any(String),
      enforcedAt: null,
    });
    expect(await gracefulShutdown.readDiscordControlCursor(workDir)).toBe("7061");
    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      "https://discord.com/api/v10/channels/channel-1/messages?limit=50",
      expect.any(Object),
    );
    expect(fetchSpy).not.toHaveBeenCalledWith(
      "https://discord.com/api/v10/channels/channel-1/messages?limit=1",
      expect.anything(),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Recovered malformed discord control cursor state store"),
    );
  });

  it("drains Discord control backlogs larger than one page before advancing the cursor", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");
    await gracefulShutdown.writeDiscordControlCursor(workDir, "9000");

    const firstPage = Array.from({ length: 50 }, (_, index) => createDiscordControlMessage(9001 + index, `noise-${index}`));
    const secondPage = Array.from({ length: 10 }, (_, index) => {
      const id = 9051 + index;
      if (id === 9058) {
        return createDiscordControlMessage(id, "/quit", "operator-1");
      }

      return createDiscordControlMessage(id, `noise-${id}`);
    });
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(firstPage), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(secondPage), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "ack-backlog" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const request = await pollDiscordGracefulShutdownCommand(workDir);

    expect(request).toEqual({
      version: 1,
      source: "discord",
      command: "/quit",
      mode: "after-current-task",
      messageId: "9058",
      requestedAt: expect.any(String),
      enforcedAt: null,
    });
    expect(await gracefulShutdown.readDiscordControlCursor(workDir)).toBe("9060");
    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      "https://discord.com/api/v10/channels/channel-1/messages?limit=50&after=9000",
      expect.any(Object),
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      "https://discord.com/api/v10/channels/channel-1/messages?limit=50&after=9050",
      expect.any(Object),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("keeps the Discord control cursor at the batch start when a later message fails mid-batch", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");
    await gracefulShutdown.writeDiscordControlCursor(workDir, "9400");

    const recordReceiptSpy = vi.spyOn(gracefulShutdown, "recordDiscordControlCommandReceipt")
      .mockRejectedValueOnce(new Error("simulated mid-batch failure"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onStartProject = vi.fn().mockResolvedValue({
      ok: true,
      message: "Created issue #556.",
      issueNumber: 556,
      issueUrl: "https://github.com/evolvo-auto/evolvo-ts/issues/556",
    });
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            createDiscordControlMessage(9401, "/quit", "operator-1"),
            createDiscordControlMessage(9402, "/startProject Habit CLI", "operator-1"),
          ]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "ack-quit" }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            createDiscordControlMessage(9401, "/quit", "operator-1"),
            createDiscordControlMessage(9402, "/startProject Habit CLI", "operator-1"),
          ]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "ack-replayed-start-project" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const firstRequest = await pollDiscordGracefulShutdownCommand(workDir, { onStartProject });

    expect(firstRequest).toBeNull();
    expect(await gracefulShutdown.readDiscordControlCursor(workDir)).toBe("9400");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Discord graceful shutdown polling failed: [read-control-commands] simulated mid-batch failure"),
    );
    expect(onStartProject).not.toHaveBeenCalled();

    recordReceiptSpy.mockRestore();

    const replayedRequest = await pollDiscordGracefulShutdownCommand(workDir, { onStartProject });

    expect(replayedRequest).toEqual({
      version: 1,
      source: "discord",
      command: "/quit",
      mode: "after-current-task",
      messageId: "9401",
      requestedAt: expect.any(String),
      enforcedAt: null,
    });
    expect(await gracefulShutdown.readDiscordControlCursor(workDir)).toBe("9402");
    expect(onStartProject).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it("queues an authorized /startProject request and acknowledges the created tracker issue", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");

    const onStartProject = vi.fn().mockResolvedValue({
      ok: true,
      message: "Created issue #555.",
      issueNumber: 555,
      issueUrl: "https://github.com/evolvo-auto/evolvo-ts/issues/555",
    });
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "7100", content: "boot", author: { id: "someone" } }]), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ id: "7101", content: "/startProject Habit CLI", author: { id: "operator-1" } }]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "ack-2" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const request = await pollDiscordGracefulShutdownCommand(workDir, { onStartProject });

    expect(request).toBeNull();
    expect(onStartProject).toHaveBeenCalledWith({
      messageId: "7101",
      requestedAt: expect.any(String),
      requestedBy: "discord:operator-1",
      displayName: "Habit CLI",
      slug: "habit-cli",
      repositoryName: "habit-cli",
      issueLabel: "project:habit-cli",
      workspaceRelativePath: "projects/habit-cli",
    });
    expect(fetchSpy).toHaveBeenNthCalledWith(
      3,
      "https://discord.com/api/v10/channels/channel-1/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          content: [
            "<@operator-1> Project start request queued for `Habit CLI`.",
            "Tracker issue: #555 (https://github.com/evolvo-auto/evolvo-ts/issues/555)",
            "Planned label: `project:habit-cli`",
            "Planned repository: `habit-cli`",
            "Planned workspace: `projects/habit-cli`",
          ].join("\n"),
        }),
      }),
    );
  });

  it("acknowledges invalid authorized /startProject commands without calling the handler", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");

    const onStartProject = vi.fn();
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "7200", content: "boot", author: { id: "someone" } }]), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ id: "7201", content: "/startProject", author: { id: "operator-1" } }]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "ack-3" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await pollDiscordGracefulShutdownCommand(workDir, { onStartProject });

    expect(onStartProject).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenNthCalledWith(
      3,
      "https://discord.com/api/v10/channels/channel-1/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          content: [
            "<@operator-1> Could not queue project start request for `<missing project name>`.",
            "Project name is required.",
            "Usage: `/startProject <project-name>`",
          ].join("\n"),
        }),
      }),
    );
  });

  it("ignores /quit messages from unauthorized users", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");

    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "8000", content: "boot", author: { id: "someone" } }]), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ id: "8001", content: "/quit", author: { id: "intruder-1" } }]),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchSpy);

    const request = await pollDiscordGracefulShutdownCommand(workDir);

    expect(request).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("ignores /quit after tasks messages from unauthorized users", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");

    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "8010", content: "boot", author: { id: "someone" } }]), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ id: "8011", content: "/quit after tasks", author: { id: "intruder-1" } }]),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchSpy);

    const request = await pollDiscordGracefulShutdownCommand(workDir);

    expect(request).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("ignores /startProject messages from unauthorized users", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");

    const onStartProject = vi.fn();
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "7300", content: "boot", author: { id: "someone" } }]), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ id: "7301", content: "/startProject Habit CLI", author: { id: "intruder-1" } }]),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchSpy);

    await pollDiscordGracefulShutdownCommand(workDir, { onStartProject });

    expect(onStartProject).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("returns null when Discord API fails and logs a Missing Access hint", async () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");

    const fetchSpy = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ message: "Missing Access", code: 50001 }),
        { status: 403 },
      ),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchSpy);

    const decision = await requestCycleLimitDecisionFromOperator(100);

    expect(decision).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Discord operator control failed: [verify-channel] Discord API request failed (403)"),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      "Discord bot is missing access to the configured control channel. Verify DISCORD_CONTROL_GUILD_ID, DISCORD_CONTROL_CHANNEL_ID, and bot channel permissions.",
    );
  });
});
