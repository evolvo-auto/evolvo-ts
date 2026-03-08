import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as gracefulShutdown from "./gracefulShutdown.js";
import {
  getDiscordControlConfigFromEnv,
  handleDiscordSlashCommandInteraction,
  notifyCycleLimitDecisionAppliedInDiscord,
  notifyIssueStartedInDiscord,
  notifyRuntimeQuittingInDiscord,
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

function createSlashInteraction(options: {
  id?: string;
  commandName: string;
  guildId?: string | null;
  channelId?: string | null;
  userId?: string;
  values?: Record<string, string | null | undefined>;
}): ChatInputCommandInteraction {
  let replied = false;
  let deferred = false;

  const interaction = {
    id: options.id ?? "interaction-1",
    commandName: options.commandName,
    guildId: options.guildId ?? "guild-1",
    channelId: options.channelId ?? "channel-1",
    user: {
      id: options.userId ?? "operator-1",
    },
    options: {
      getString: (name: string): string | null => options.values?.[name] ?? null,
    },
    reply: vi.fn(async (_payload: unknown) => {
      replied = true;
      return undefined;
    }),
    deferReply: vi.fn(async () => {
      deferred = true;
      return undefined;
    }),
    editReply: vi.fn(async (_payload: unknown) => {
      replied = true;
      return undefined;
    }),
  };

  return Object.defineProperties(interaction, {
    replied: {
      get: () => replied,
    },
    deferred: {
      get: () => deferred,
    },
  }) as unknown as ChatInputCommandInteraction;
}

describe("operatorControl", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("EVOLVO_DISCORD_TRANSPORT", "live");
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

  it("returns null config when Discord transport is explicitly disabled", () => {
    expect(getDiscordControlConfigFromEnv({
      DISCORD_BOT_TOKEN: "bot-token",
      DISCORD_CONTROL_GUILD_ID: "guild-1",
      DISCORD_CONTROL_CHANNEL_ID: "channel-1",
      DISCORD_OPERATOR_USER_ID: "operator-1",
      EVOLVO_DISCORD_TRANSPORT: "disabled",
    })).toBeNull();
  });

  it("skips Discord startup checks entirely when Discord transport is disabled", async () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");
    vi.stubEnv("EVOLVO_DISCORD_TRANSPORT", "disabled");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await runDiscordOperatorControlStartupCheck();

    expect(fetchSpy).not.toHaveBeenCalled();
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
        body: expect.stringContaining("plain-text mode"),
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
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

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
        repository: "evolvo-auto/evolvo-ts",
        url: "https://github.com/evolvo-auto/evolvo-ts/issues/298",
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
    expect(logSpy).toHaveBeenCalledWith(
      "[discord-issue-start] project=evolvo issueRepository=evolvo-auto/evolvo-ts trackerRepository=evolvo-auto/evolvo-ts executionRepository=evolvo-auto/evolvo-ts issueUrl=https://github.com/evolvo-auto/evolvo-ts/issues/298",
    );
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

  it("uses the project issue repository for project-mode embed links", async () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "channel-1", guild_id: "guild-1" }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "message-2" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await notifyIssueStartedInDiscord({
      issue: {
        number: 14,
        title: "Fix project-mode links",
        repository: "evolvo-auto/habit-cli",
        url: "https://github.com/evolvo-auto/habit-cli/issues/14",
      },
      executionContext: {
        trackerRepository: "evolvo-auto/evolvo-ts",
        executionRepository: "evolvo-auto/habit-cli",
        project: {
          displayName: "Habit CLI",
          slug: "habit-cli",
        },
      },
      lifecycleState: "selected -> executing",
    });

    expect(logSpy).toHaveBeenCalledWith(
      "[discord-issue-start] project=habit-cli issueRepository=evolvo-auto/habit-cli trackerRepository=evolvo-auto/evolvo-ts executionRepository=evolvo-auto/habit-cli issueUrl=https://github.com/evolvo-auto/habit-cli/issues/14",
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
              title: "Started Issue #14",
              description: "Fix project-mode links",
              url: "https://github.com/evolvo-auto/habit-cli/issues/14",
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
                  value: "Habit CLI (`habit-cli`)",
                  inline: true,
                },
                {
                  name: "Execution Repository",
                  value: "evolvo-auto/habit-cli",
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
                  url: "https://github.com/evolvo-auto/habit-cli/issues/14",
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

  it("returns quit when operator replies quit", async () => {
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
          JSON.stringify([{ id: "5001", content: "quit", author: { id: "operator-1" } }]),
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

  it("returns the first valid decision after scanning all operator replies in a fetched batch", async () => {
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
          JSON.stringify([
            createDiscordControlMessage(5001, "still thinking", "operator-1"),
            createDiscordControlMessage(5002, "continue", "operator-1"),
          ]),
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

  it("sends a Discord confirmation when a cycle-limit continue decision is applied", async () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");

    const fetchSpy = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: "cycle-continue-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await notifyCycleLimitDecisionAppliedInDiscord({
      decision: "continue",
      currentLimit: 5,
      additionalCycles: 3,
      newLimit: 8,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://discord.com/api/v10/channels/channel-1/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          content: "<@operator-1> Confirmed: continue was applied at the cycle limit.\nAdded 3 cycles. New limit: 8. Evolvo remains online.",
        }),
      }),
    );
  });

  it("sends a Discord confirmation when a cycle-limit quit decision is applied", async () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");

    const fetchSpy = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: "cycle-quit-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await notifyCycleLimitDecisionAppliedInDiscord({
      decision: "quit",
      currentLimit: 5,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://discord.com/api/v10/channels/channel-1/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          content: "<@operator-1> Confirmed: quit was applied at the cycle limit (5).\nEvolvo is about to quit intentionally.",
        }),
      }),
    );
  });

  it("sends a pre-quit Discord notification before intentional shutdown", async () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");

    const fetchSpy = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: "quit-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await notifyRuntimeQuittingInDiscord("Cycle limit of 5 was reached and no continue decision was applied.");

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://discord.com/api/v10/channels/channel-1/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          content: "<@operator-1> Evolvo is about to quit intentionally.\nReason: Cycle limit of 5 was reached and no continue decision was applied.\nRuntime shutdown is starting now.",
        }),
      }),
    );
  });

  it("logs quit-notification failures clearly when Discord is unavailable", async () => {
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

    await notifyRuntimeQuittingInDiscord("Post-merge restart workflow completed.");

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Discord runtime quit notification failed: [send-quit-message] Discord API request failed (403)"),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      "Discord bot is missing access to the configured control channel. Verify DISCORD_CONTROL_GUILD_ID, DISCORD_CONTROL_CHANNEL_ID, and bot channel permissions.",
    );
  });

  it("retries Discord rate-limit responses after the advertised Retry-After delay", async () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");

    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "You are being rate limited." }), {
          status: 429,
          headers: {
            "retry-after": "2",
          },
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "quit-after-retry" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const notificationPromise = notifyRuntimeQuittingInDiscord("Retry test");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await notificationPromise;

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("retries transient Discord network errors and succeeds", async () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");

    const fetchSpy = vi.fn()
      .mockRejectedValueOnce(new TypeError("Network request failed"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "quit-network-retry" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const notificationPromise = notifyRuntimeQuittingInDiscord("Network retry");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(249);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await notificationPromise;

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("retries Discord request timeouts and logs the explicit timeout when retries are exhausted", async () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");

    const abortError = new Error("aborted");
    abortError.name = "AbortError";

    const fetchSpy = vi.fn().mockRejectedValue(abortError);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchSpy);

    const notificationPromise = notifyRuntimeQuittingInDiscord("Timeout retry");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(500);
    await notificationPromise;

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "Discord runtime quit notification failed: [send-quit-message] Discord API request timed out after 10000ms.",
      ),
    );
  });

  it("records and acknowledges an authorized quit after current task graceful shutdown command", async () => {
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
          JSON.stringify([{ id: "7001", content: "quit after current task", author: { id: "operator-1" } }]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "ack-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const request = await pollDiscordGracefulShutdownCommand(workDir);

    expect(request).toEqual({
      version: 1,
      source: "discord",
      command: "quit after current task",
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
          content: "<@operator-1> Confirmed: `quit after current task` is now active.\nEvolvo will finish the current task and then stop before starting another issue.",
        }),
      }),
    );
  });

  it("confirms the active shutdown plan when quit after current task is repeated after a queue-drain request already exists", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");

    await gracefulShutdown.recordGracefulShutdownRequest(workDir, {
      messageId: "7999",
      requestedAt: "2026-03-08T09:00:00.000Z",
      mode: "after-tasks",
    });
    await gracefulShutdown.writeDiscordControlCursor(workDir, "7999");

    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ id: "8000", content: "quit after current task", author: { id: "operator-1" } }]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "ack-duplicate-quit" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const request = await pollDiscordGracefulShutdownCommand(workDir);

    expect(request).toEqual({
      version: 1,
      source: "discord",
      command: "quit after tasks",
      mode: "after-tasks",
      messageId: "7999",
      requestedAt: "2026-03-08T09:00:00.000Z",
      enforcedAt: null,
    });
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      "https://discord.com/api/v10/channels/channel-1/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          content: "<@operator-1> Confirmed: `quit after tasks` was already active, so the new command did not change the shutdown plan.\nEvolvo will finish the current actionable queue, will not plan or create new work, and will stop once the queue is drained.",
        }),
      }),
    );
  });

  it("records and acknowledges an authorized quit after tasks queue-drain command", async () => {
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
          JSON.stringify([{ id: "7051", content: "quit   after   tasks", author: { id: "operator-1" } }]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "ack-queue-drain" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const request = await pollDiscordGracefulShutdownCommand(workDir);

    expect(request).toEqual({
      version: 1,
      source: "discord",
      command: "quit after tasks",
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
          content: "<@operator-1> Confirmed: `quit after tasks` is now active.\nEvolvo will finish the current actionable queue, will not plan or create new work, and will stop once the queue is drained.",
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
            createDiscordControlMessage(7061, "quit after current task", "operator-1"),
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
      command: "quit after current task",
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
        return createDiscordControlMessage(id, "quit after current task", "operator-1");
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
      command: "quit after current task",
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
      action: "created",
      message: "Created provisioning issue #556 for project `habit-cli`.",
      project: {
        displayName: "Habit CLI",
        slug: "habit-cli",
        repositoryName: "habit-cli",
        workspacePath: "/home/paddy/habit-cli",
        status: "provisioning",
      },
      trackerIssue: {
        number: 556,
        url: "https://github.com/evolvo-auto/evolvo-ts/issues/556",
        alreadyOpen: false,
      },
    });
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            createDiscordControlMessage(9401, "quit after current task", "operator-1"),
            createDiscordControlMessage(9402, "startProject Habit CLI", "operator-1"),
          ]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "ack-quit" }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            createDiscordControlMessage(9401, "quit after current task", "operator-1"),
            createDiscordControlMessage(9402, "startProject Habit CLI", "operator-1"),
          ]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "ack-replayed-quit" }), { status: 200 }))
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
      command: "quit after current task",
      mode: "after-current-task",
      messageId: "9401",
      requestedAt: expect.any(String),
      enforcedAt: null,
    });
    expect(await gracefulShutdown.readDiscordControlCursor(workDir)).toBe("9402");
    expect(onStartProject).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(5);
  });

  it("queues an authorized startProject request and acknowledges the created tracker issue", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");

    const onStartProject = vi.fn().mockResolvedValue({
      ok: true,
      action: "created",
      message: "Created provisioning issue #555 for project `habit-cli`. Canonical workspace: `/home/paddy/habit-cli`.",
      project: {
        displayName: "Habit CLI",
        slug: "habit-cli",
        repositoryName: "habit-cli",
        workspacePath: "/home/paddy/habit-cli",
        status: "provisioning",
      },
      trackerIssue: {
        number: 555,
        url: "https://github.com/evolvo-auto/evolvo-ts/issues/555",
        alreadyOpen: false,
      },
    });
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "7100", content: "boot", author: { id: "someone" } }]), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ id: "7101", content: "startProject Habit CLI", author: { id: "operator-1" } }]),
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
      workspacePath: "/home/paddy/habit-cli",
    });
    expect(fetchSpy).toHaveBeenNthCalledWith(
      3,
      "https://discord.com/api/v10/channels/channel-1/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          content: [
            "<@operator-1> Created new project for `Habit CLI`.",
            "Created provisioning issue #555 for project `habit-cli`. Canonical workspace: `/home/paddy/habit-cli`.",
            "Tracker issue: #555 (https://github.com/evolvo-auto/evolvo-ts/issues/555)",
            "Planned label: `project:habit-cli`",
            "Planned repository: `habit-cli`",
            "Planned workspace: `/home/paddy/habit-cli`",
          ].join("\n"),
        }),
      }),
    );
  });

  it("acknowledges an authorized startProject request by resuming an existing project", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");

    const onStartProject = vi.fn().mockResolvedValue({
      ok: true,
      action: "resumed",
      message: "Resumed existing project `habit-cli`. Reused existing workspace directory `/home/paddy/habit-cli`, and that path is now the active working directory.",
      project: {
        displayName: "Habit CLI",
        slug: "habit-cli",
        repositoryName: "habit-cli",
        repositoryUrl: "https://github.com/evolvo-auto/habit-cli",
        workspacePath: "/home/paddy/habit-cli",
        status: "active",
      },
    });
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "7150", content: "boot", author: { id: "someone" } }]), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ id: "7151", content: "startProject Habit CLI", author: { id: "operator-1" } }]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "ack-resume" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await pollDiscordGracefulShutdownCommand(workDir, { onStartProject });

    expect(fetchSpy).toHaveBeenNthCalledWith(
      3,
      "https://discord.com/api/v10/channels/channel-1/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          content: [
            "<@operator-1> Resumed existing project `Habit CLI`.",
            "Resumed existing project `habit-cli`. Reused existing workspace directory `/home/paddy/habit-cli`, and that path is now the active working directory.",
            "Registry status: `active`",
            "Execution repository: https://github.com/evolvo-auto/habit-cli",
            "Workspace: `/home/paddy/habit-cli`",
          ].join("\n"),
        }),
      }),
    );
  });

  it("acknowledges an authorized stopProject request and keeps the runtime online", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");

    const onStopProject = vi.fn().mockResolvedValue({
      ok: true,
      action: "stopped",
      message: "Project `habit-cli` will not be selected again until `startProject <project-name>` is used.",
      project: {
        displayName: "Habit CLI",
        slug: "habit-cli",
      },
    });
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "7160", content: "boot", author: { id: "someone" } }]), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ id: "7161", content: "stopProject Habit CLI", author: { id: "operator-1" } }]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "ack-stop" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await pollDiscordGracefulShutdownCommand(workDir, { onStopProject });

    expect(onStopProject).toHaveBeenCalledWith({
      messageId: "7161",
      requestedAt: expect.any(String),
      requestedBy: "discord:operator-1",
      projectName: "Habit CLI",
      projectSlug: "habit-cli",
      mode: "now",
    });
    expect(fetchSpy).toHaveBeenNthCalledWith(
      3,
      "https://discord.com/api/v10/channels/channel-1/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          content: [
            "<@operator-1> Stopped current project `Habit CLI`.",
            "Project `habit-cli` will not be selected again until `startProject <project-name>` is used.",
            "Runtime remains online and is waiting for further operator commands.",
          ].join("\n"),
        }),
      }),
    );
  });

  it("acknowledges invalid authorized stopProject commands without calling the handler", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");

    const onStopProject = vi.fn();
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "7170", content: "boot", author: { id: "someone" } }]), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ id: "7171", content: "stopProject now", author: { id: "operator-1" } }]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "ack-stop-invalid" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await pollDiscordGracefulShutdownCommand(workDir, { onStopProject });

    expect(onStopProject).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenNthCalledWith(
      3,
      "https://discord.com/api/v10/channels/channel-1/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          content: [
            "<@operator-1> Could not stop the requested project.",
            "`stopProject` requires a project name.",
            "Usage: `stopProject <project-name>` or `stopProject <project-name> whenProjectComplete`",
          ].join("\n"),
        }),
      }),
    );
  });

  it("acknowledges an authorized deferred stopProject request and keeps the runtime online", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");

    const onStopProject = vi.fn().mockResolvedValue({
      ok: true,
      action: "stop-when-complete-scheduled",
      message: "Project `habit-cli` will keep running until it has no actionable issues left. Evolvo will then stop it automatically, return to self-work, and remain online.",
      project: {
        displayName: "Habit CLI",
        slug: "habit-cli",
      },
    });
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "7165", content: "boot", author: { id: "someone" } }]), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ id: "7166", content: "stopProject Habit CLI whenProjectComplete", author: { id: "operator-1" } }]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "ack-stop-when-complete" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await pollDiscordGracefulShutdownCommand(workDir, { onStopProject });

    expect(onStopProject).toHaveBeenCalledWith({
      messageId: "7166",
      requestedAt: expect.any(String),
      requestedBy: "discord:operator-1",
      projectName: "Habit CLI",
      projectSlug: "habit-cli",
      mode: "when-project-complete",
    });
    expect(fetchSpy).toHaveBeenNthCalledWith(
      3,
      "https://discord.com/api/v10/channels/channel-1/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          content: [
            "<@operator-1> Current project `Habit CLI` will stop when complete.",
            "Project `habit-cli` will keep running until it has no actionable issues left. Evolvo will then stop it automatically, return to self-work, and remain online.",
            "Evolvo will return to self-work afterward and remain online for further operator commands.",
          ].join("\n"),
        }),
      }),
    );
  });

  it("acknowledges an authorized status request with project and deferred-stop details", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");

    const onStatus = vi.fn().mockResolvedValue({
      ok: true,
      snapshot: {
        online: true,
        runtimeState: "active",
        workMode: "project-work",
        activitySummary: "Executing issue #17.",
        activeProjects: [
          {
            displayName: "Habit CLI",
            slug: "habit-cli",
            repository: "evolvo-auto/habit-cli",
          },
          {
            displayName: "Evolvo Web",
            slug: "evolvo-web",
            repository: "evolvo-auto/evolvo-web",
          },
        ],
        activeProject: {
          displayName: "Habit CLI",
          slug: "habit-cli",
          repository: "evolvo-auto/habit-cli",
        },
        activeIssue: {
          number: 17,
          title: "Fix project status routing",
          repository: "evolvo-auto/habit-cli",
          lifecycleState: "selected -> executing",
        },
        deferredStop: "when-project-complete",
        cycle: {
          current: 4,
          limit: 10,
          remaining: 6,
        },
      },
    });
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "7180", content: "boot", author: { id: "someone" } }]), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ id: "7181", content: "status", author: { id: "operator-1" } }]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "ack-status" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await pollDiscordGracefulShutdownCommand(workDir, { onStatus });

    expect(onStatus).toHaveBeenCalledWith({
      messageId: "7181",
      requestedAt: expect.any(String),
      requestedBy: "discord:operator-1",
    });
    expect(fetchSpy).toHaveBeenNthCalledWith(
      3,
      "https://discord.com/api/v10/channels/channel-1/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          content: [
            "<@operator-1> Evolvo is online.",
            "Runtime state: `active`",
            "Work mode: `project-work`",
            "Activity: Executing issue #17.",
            "Active projects: Habit CLI (`habit-cli`, `evolvo-auto/habit-cli`), Evolvo Web (`evolvo-web`, `evolvo-auto/evolvo-web`)",
            "Project: Habit CLI (`habit-cli`) | repo: `evolvo-auto/habit-cli`",
            "Issue: #17 Fix project status routing | repo: `evolvo-auto/habit-cli`",
            "Lifecycle: selected -> executing",
            "Deferred stop: current project will stop when complete, then Evolvo will return to self-work.",
            "Cycle: 4 of 10 (6 remaining after this cycle)",
          ].join("\n"),
        }),
      }),
    );
  });

  it("acknowledges invalid authorized startProject commands without calling the handler", async () => {
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
          JSON.stringify([{ id: "7201", content: "startProject", author: { id: "operator-1" } }]),
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
            "Usage: `startProject <project-name>`",
          ].join("\n"),
        }),
      }),
    );
  });

  it("ignores slash-prefixed control messages from the authorized operator", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");
    await gracefulShutdown.writeDiscordControlCursor(workDir, "8099");

    const onStartProject = vi.fn();
    const onStopProject = vi.fn();
    const fetchSpy = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          createDiscordControlMessage(8100, "/quit", "operator-1"),
          createDiscordControlMessage(8101, "/startProject Habit CLI", "operator-1"),
          createDiscordControlMessage(8102, "/stopProject", "operator-1"),
        ]),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const request = await pollDiscordGracefulShutdownCommand(workDir, { onStartProject, onStopProject });

    expect(request).toBeNull();
    expect(onStartProject).not.toHaveBeenCalled();
    expect(onStopProject).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await gracefulShutdown.readDiscordControlCursor(workDir)).toBe("8102");
  });

  it("ignores quit after current task messages from unauthorized users", async () => {
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
          JSON.stringify([{ id: "8001", content: "quit after current task", author: { id: "intruder-1" } }]),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchSpy);

    const request = await pollDiscordGracefulShutdownCommand(workDir);

    expect(request).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("ignores quit after tasks messages from unauthorized users", async () => {
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
          JSON.stringify([{ id: "8011", content: "quit after tasks", author: { id: "intruder-1" } }]),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchSpy);

    const request = await pollDiscordGracefulShutdownCommand(workDir);

    expect(request).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("ignores startProject messages from unauthorized users", async () => {
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
          JSON.stringify([{ id: "7301", content: "startProject Habit CLI", author: { id: "intruder-1" } }]),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchSpy);

    await pollDiscordGracefulShutdownCommand(workDir, { onStartProject });

    expect(onStartProject).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("ignores stopProject messages from unauthorized users", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");

    const onStopProject = vi.fn();
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "7310", content: "boot", author: { id: "someone" } }]), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ id: "7311", content: "stopProject", author: { id: "intruder-1" } }]),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchSpy);

    await pollDiscordGracefulShutdownCommand(workDir, { onStopProject });

    expect(onStopProject).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("handles an authorized /quit slash command in the configured control channel", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");

    const interaction = createSlashInteraction({
      id: "slash-quit-1",
      commandName: "quit",
      values: {
        mode: "after-tasks",
      },
    });

    const result = await handleDiscordSlashCommandInteraction(interaction, workDir);

    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: "<@operator-1> Confirmed: `quit after tasks` is now active.\nEvolvo will finish the current actionable queue, will not plan or create new work, and will stop once the queue is drained.",
    });
    expect(result).toEqual({
      gracefulShutdownRequest: {
        version: 1,
        source: "discord",
        command: "quit after tasks",
        mode: "after-tasks",
        messageId: "slash-quit-1",
        requestedAt: expect.any(String),
        enforcedAt: null,
      },
      replyContent: "<@operator-1> Confirmed: `quit after tasks` is now active.\nEvolvo will finish the current actionable queue, will not plan or create new work, and will stop once the queue is drained.",
    });
  });

  it("rejects slash commands from unauthorized Discord users", async () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");

    const interaction = createSlashInteraction({
      commandName: "stopproject",
      userId: "intruder-1",
    });

    const result = await handleDiscordSlashCommandInteraction(interaction, "/tmp/does-not-matter");

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "You are not authorized to control this Evolvo runtime.",
      flags: MessageFlags.Ephemeral,
    });
    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("rejects slash commands from the wrong Discord channel", async () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");

    const interaction = createSlashInteraction({
      commandName: "startproject",
      channelId: "other-channel",
      values: {
        name: "Habit CLI",
      },
    });

    const result = await handleDiscordSlashCommandInteraction(interaction, "/tmp/does-not-matter");

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "Use these commands in <#channel-1>.",
      flags: MessageFlags.Ephemeral,
    });
    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("handles an authorized /startproject slash command and forwards the normalized project request", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");

    const onStartProject = vi.fn().mockResolvedValue({
      ok: true,
      action: "created",
      message: "Created provisioning issue #555 for project `habit-cli`. Canonical workspace: `/home/paddy/habit-cli`.",
      project: {
        displayName: "Habit CLI",
        slug: "habit-cli",
        repositoryName: "habit-cli",
        workspacePath: "/home/paddy/habit-cli",
        status: "provisioning",
      },
      trackerIssue: {
        number: 555,
        url: "https://github.com/evolvo-auto/evolvo-ts/issues/555",
        alreadyOpen: false,
      },
    });
    const interaction = createSlashInteraction({
      id: "slash-start-1",
      commandName: "startproject",
      values: {
        name: "Habit CLI",
      },
    });

    const result = await handleDiscordSlashCommandInteraction(interaction, workDir, { onStartProject });

    expect(onStartProject).toHaveBeenCalledWith({
      messageId: "slash-start-1",
      requestedAt: expect.any(String),
      requestedBy: "discord:operator-1",
      displayName: "Habit CLI",
      slug: "habit-cli",
      repositoryName: "habit-cli",
      issueLabel: "project:habit-cli",
      workspacePath: "/home/paddy/habit-cli",
    });
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: [
        "<@operator-1> Created new project for `Habit CLI`.",
        "Created provisioning issue #555 for project `habit-cli`. Canonical workspace: `/home/paddy/habit-cli`.",
        "Tracker issue: #555 (https://github.com/evolvo-auto/evolvo-ts/issues/555)",
        "Planned label: `project:habit-cli`",
        "Planned repository: `habit-cli`",
        "Planned workspace: `/home/paddy/habit-cli`",
      ].join("\n"),
    });
    expect(result).toEqual({
      gracefulShutdownRequest: null,
      replyContent: [
        "<@operator-1> Created new project for `Habit CLI`.",
        "Created provisioning issue #555 for project `habit-cli`. Canonical workspace: `/home/paddy/habit-cli`.",
        "Tracker issue: #555 (https://github.com/evolvo-auto/evolvo-ts/issues/555)",
        "Planned label: `project:habit-cli`",
        "Planned repository: `habit-cli`",
        "Planned workspace: `/home/paddy/habit-cli`",
      ].join("\n"),
    });
  });

  it("handles an authorized /stopproject slash command", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");

    const onStopProject = vi.fn().mockResolvedValue({
      ok: true,
      action: "stopped",
      message: "Project `habit-cli` will not be selected again until `startProject <project-name>` is used.",
      project: {
        displayName: "Habit CLI",
        slug: "habit-cli",
      },
    });
    const interaction = createSlashInteraction({
      id: "slash-stop-1",
      commandName: "stopproject",
      values: {
        name: "Habit CLI",
      },
    });

    const result = await handleDiscordSlashCommandInteraction(interaction, workDir, { onStopProject });

    expect(onStopProject).toHaveBeenCalledWith({
      messageId: "slash-stop-1",
      requestedAt: expect.any(String),
      requestedBy: "discord:operator-1",
      projectName: "Habit CLI",
      projectSlug: "habit-cli",
      mode: "now",
    });
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: [
        "<@operator-1> Stopped current project `Habit CLI`.",
        "Project `habit-cli` will not be selected again until `startProject <project-name>` is used.",
        "Runtime remains online and is waiting for further operator commands.",
      ].join("\n"),
    });
    expect(result).toEqual({
      replyContent: [
        "<@operator-1> Stopped current project `Habit CLI`.",
        "Project `habit-cli` will not be selected again until `startProject <project-name>` is used.",
        "Runtime remains online and is waiting for further operator commands.",
      ].join("\n"),
    });
  });

  it("handles an authorized /stopproject slash command in deferred mode", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");

    const onStopProject = vi.fn().mockResolvedValue({
      ok: true,
      action: "stop-when-complete-scheduled",
      message: "Project `habit-cli` will keep running until it has no actionable issues left. Evolvo will then stop it automatically, return to self-work, and remain online.",
      project: {
        displayName: "Habit CLI",
        slug: "habit-cli",
      },
    });
    const interaction = createSlashInteraction({
      id: "slash-stop-when-complete-1",
      commandName: "stopproject",
      values: {
        name: "Habit CLI",
        mode: "when-project-complete",
      },
    });

    const result = await handleDiscordSlashCommandInteraction(interaction, workDir, { onStopProject });

    expect(onStopProject).toHaveBeenCalledWith({
      messageId: "slash-stop-when-complete-1",
      requestedAt: expect.any(String),
      requestedBy: "discord:operator-1",
      projectName: "Habit CLI",
      projectSlug: "habit-cli",
      mode: "when-project-complete",
    });
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: [
        "<@operator-1> Current project `Habit CLI` will stop when complete.",
        "Project `habit-cli` will keep running until it has no actionable issues left. Evolvo will then stop it automatically, return to self-work, and remain online.",
        "Evolvo will return to self-work afterward and remain online for further operator commands.",
      ].join("\n"),
    });
    expect(result).toEqual({
      replyContent: [
        "<@operator-1> Current project `Habit CLI` will stop when complete.",
        "Project `habit-cli` will keep running until it has no actionable issues left. Evolvo will then stop it automatically, return to self-work, and remain online.",
        "Evolvo will return to self-work afterward and remain online for further operator commands.",
      ].join("\n"),
    });
  });

  it("handles an authorized /status slash command", async () => {
    const workDir = await createTempWorkDir();
    tempDirs.push(workDir);
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_CONTROL_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_CONTROL_CHANNEL_ID", "channel-1");
    vi.stubEnv("DISCORD_OPERATOR_USER_ID", "operator-1");

    const onStatus = vi.fn().mockResolvedValue({
      ok: true,
      snapshot: {
        online: true,
        runtimeState: "waiting",
        workMode: "idle",
        activitySummary: "Waiting for further operator instructions.",
        activeProjects: [],
        activeProject: null,
        activeIssue: null,
        deferredStop: null,
        cycle: {
          current: null,
          limit: 10,
          remaining: 10,
        },
      },
    });
    const interaction = createSlashInteraction({
      id: "slash-status-1",
      commandName: "status",
    });

    const result = await handleDiscordSlashCommandInteraction(interaction, workDir, { onStatus });

    expect(onStatus).toHaveBeenCalledWith({
      messageId: "slash-status-1",
      requestedAt: expect.any(String),
      requestedBy: "discord:operator-1",
    });
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: [
        "<@operator-1> Evolvo is online.",
        "Runtime state: `waiting`",
        "Work mode: `idle`",
        "Activity: Waiting for further operator instructions.",
        "Active projects: none",
        "Project: none",
        "Issue: none",
        "Lifecycle: none",
        "Deferred stop: none",
        "Cycle: not started yet (10 total budget available)",
      ].join("\n"),
    });
    expect(result).toEqual({
      gracefulShutdownRequest: null,
      replyContent: [
        "<@operator-1> Evolvo is online.",
        "Runtime state: `waiting`",
        "Work mode: `idle`",
        "Activity: Waiting for further operator instructions.",
        "Active projects: none",
        "Project: none",
        "Issue: none",
        "Lifecycle: none",
        "Deferred stop: none",
        "Cycle: not started yet (10 total budget available)",
      ].join("\n"),
    });
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
