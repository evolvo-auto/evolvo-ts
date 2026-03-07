import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDiscordControlConfigFromEnv,
  requestCycleLimitDecisionFromOperator,
} from "./operatorControl.js";

describe("operatorControl", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("returns null config when required Discord environment variables are missing", () => {
    expect(getDiscordControlConfigFromEnv({})).toBeNull();
  });

  it("returns null decision when Discord operator control is not configured", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const decision = await requestCycleLimitDecisionFromOperator(100);

    expect(decision).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
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
      expect.stringContaining("Discord operator control failed: Discord API request failed (403)"),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      "Discord bot is missing access to the configured control channel. Verify DISCORD_CONTROL_GUILD_ID, DISCORD_CONTROL_CHANNEL_ID, and bot channel permissions.",
    );
  });
});
