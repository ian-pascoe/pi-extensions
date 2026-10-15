import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonValue } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import type { CacheWarmingStatus } from "@earendil-works/pi-coding-agent";
import contextManagement from "../src/context-management-extension.js";
import {
  cacheRefreshDelayMs,
  decideIdle,
  IDLE_ROLLOVER_DEFAULTS,
  latestCacheWarm,
  promptCacheTtlMs,
  readIdleRolloverSettings,
  WARMING_SETTLE_MS,
} from "../src/idle-rollover.js";
import { createSdkHarness, reply, toolCall } from "./sdk-harness.js";

const SHORT_TTL = 300_000;
const SHORT_DELAY = 270_000;
const IDLE_PROMPT =
  "The session is idle and the prompt cache for this Context Window is about to expire.";

type SettingsDocument = Record<string, JsonValue>;

function settingsReader(global: SettingsDocument, project: SettingsDocument = {}, trusted = true) {
  return {
    getGlobalSettings: () => global,
    getProjectSettings: () => project,
    isProjectTrusted: () => trusted,
  };
}

describe("Idle Rollover decisions", () => {
  it("defaults to enabled at 200K tokens and layers trusted project over global", () => {
    expect(readIdleRolloverSettings(settingsReader({}))).toEqual({
      settings: IDLE_ROLLOVER_DEFAULTS,
      invalid: [],
    });
    expect(IDLE_ROLLOVER_DEFAULTS).toEqual({ enabled: true, minTokens: 200_000 });
    const global = { contextManagement: { idleRollover: { enabled: false, minTokens: 50_000 } } };
    const project = { contextManagement: { idleRollover: { enabled: true } } };
    expect(readIdleRolloverSettings(settingsReader(global, project)).settings).toEqual({
      enabled: true,
      minTokens: 50_000,
    });
    expect(readIdleRolloverSettings(settingsReader(global, project, false)).settings).toEqual({
      enabled: false,
      minTokens: 50_000,
    });
  });

  it("skips invalid layers and ignores legacy keys", () => {
    const read = readIdleRolloverSettings(
      settingsReader(
        { contextManagement: { tailTokens: 5, idleRollover: { minTokens: 0 } } },
        { contextManagement: { idleRollover: { minTokens: 1000, extra: true } } },
      ),
    );
    expect(read).toEqual({ settings: IDLE_ROLLOVER_DEFAULTS, invalid: ["global", "project"] });
    expect(readIdleRolloverSettings(settingsReader({ contextManagement: "malformed" }))).toEqual({
      settings: IDLE_ROLLOVER_DEFAULTS,
      invalid: [],
    });
  });

  it("derives Pi's cache lifetime and refresh point", () => {
    const model = getModel("anthropic", "claude-sonnet-4-5");
    expect(promptCacheTtlMs(model, {})).toBe(SHORT_TTL);
    expect(promptCacheTtlMs(model, { PI_CACHE_RETENTION: "long" })).toBe(3_600_000);
    const { promptCache: _omitted, ...uncached } = model;
    expect(promptCacheTtlMs(uncached, {})).toBeUndefined();
    expect(cacheRefreshDelayMs(SHORT_TTL)).toBe(SHORT_DELAY);
    expect(cacheRefreshDelayMs(3_600_000)).toBe(3_240_000);
    expect(cacheRefreshDelayMs(10_000)).toBeUndefined();
  });

  it("finds the latest Pi cache warm after a time", () => {
    const at = (ms: number) => new Date(ms).toISOString();
    const entries = [
      { type: "usage", kind: "cache_warm", timestamp: at(1_000) },
      { type: "usage", kind: "compaction", timestamp: at(9_000) },
      { type: "usage", kind: "cache_warm", timestamp: at(5_000) },
      { type: "message", timestamp: at(8_000) },
    ];
    expect(latestCacheWarm(entries, 0)).toBe(5_000);
    expect(latestCacheWarm(entries, 5_000)).toBeUndefined();
  });

  it("waits for Pi's warming, then rolls over before expiry", () => {
    const window = { touchedAt: 0, ttlMs: SHORT_TTL, delayMs: SHORT_DELAY };
    const settled = SHORT_DELAY + WARMING_SETTLE_MS;
    const inactive: CacheWarmingStatus = { state: "inactive" };
    expect(decideIdle(window, inactive, SHORT_DELAY)).toEqual({ action: "wait", at: settled });
    expect(decideIdle(window, { state: "refreshing" }, settled)).toEqual({
      action: "wait",
      at: settled + WARMING_SETTLE_MS,
    });
    expect(decideIdle(window, { state: "scheduled", nextWarmAt: settled + 10 }, settled)).toEqual({
      action: "wait",
      at: settled + 10 + WARMING_SETTLE_MS,
    });
    expect(decideIdle(window, inactive, settled)).toEqual({ action: "rollover" });
    expect(decideIdle(window, undefined, settled)).toEqual({ action: "rollover" });
    // Pi's late-refresh cutoff: half of the 30-second margin before expiry.
    expect(decideIdle(window, inactive, SHORT_DELAY + 15_000)).toEqual({ action: "rollover" });
    expect(decideIdle(window, inactive, SHORT_DELAY + 15_001)).toEqual({ action: "expired" });
  });
});

describe("Idle Rollover in a Pi session", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
    // Pi's default short (five-minute) cache tier, whatever the developer's environment selects.
    vi.stubEnv("PI_CACHE_RETENTION", undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  const checkpoints = (f: Awaited<ReturnType<typeof createSdkHarness>>) =>
    f.manager.getBranch().filter((entry) => entry.type === "compaction");

  async function idleSession(options: { contextSettings?: unknown; tokens?: number } = {}) {
    const f = await createSdkHarness([contextManagement], {
      contextWindow: 1_000_000,
      contextSettings: options.contextSettings,
    });
    f.responses.push(reply("Ready.", options.tokens ?? 250_000));
    await f.session.prompt("OLD-IDLE-TASK " + "history ".repeat(2000));
    return f;
  }

  it("prepares a pausing Rollover from the warm cached prefix just before expiry", async () => {
    const f = await idleSession();
    f.responses.push(toolCall("context_rollover", { handoff: "Idle continuation." }));
    await vi.advanceTimersByTimeAsync(SHORT_DELAY);
    expect(f.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(WARMING_SETTLE_MS);
    await expect.poll(() => checkpoints(f).length).toBe(1);
    await f.session.waitForIdle();

    expect(f.requests).toHaveLength(2);
    const [first, idle] = f.transcripts;
    // Cache proof: the idle request extends the exact earlier transcript and keeps its prefix.
    expect(idle?.slice(0, first?.length)).toEqual(first);
    expect(idle?.[first?.length ?? 0]).toMatchObject({ role: "assistant" });
    expect(f.requests[1]?.systemPrompt).toBe(f.requests[0]?.systemPrompt);
    expect(f.requests[1]?.toolDefinitions).toEqual(f.requests[0]?.toolDefinitions);
    expect(JSON.stringify(f.requests[1]?.messages.at(-1))).toContain(IDLE_PROMPT);
    expect(JSON.stringify(f.requests[1]?.messages.at(-1))).toContain(
      "Stop after the checkpoint and wait for the user's next input.",
    );
    expect(checkpoints(f)[0]?.summary).toContain("Idle continuation.");

    // Paused: nothing further runs, and the small new Context Window does not re-arm.
    await vi.advanceTimersByTimeAsync(SHORT_TTL * 3);
    expect(f.requests).toHaveLength(2);
    expect(f.providerRequests).toEqual([]);
    expect(f.extensionErrors).toEqual([]);
  });

  it.each([
    { name: "below the default minimum", tokens: 150_000, contextSettings: undefined },
    {
      name: "below a configured minimum",
      tokens: 250_000,
      contextSettings: { idleRollover: { minTokens: 300_000 } },
    },
    {
      name: "disabled",
      tokens: 250_000,
      contextSettings: { idleRollover: { enabled: false } },
    },
  ])("leaves the Context Window alone when $name", async ({ tokens, contextSettings }) => {
    const f = await idleSession({ tokens, contextSettings });
    await vi.advanceTimersByTimeAsync(SHORT_TTL * 2);
    expect(f.requests).toHaveLength(1);
    expect(checkpoints(f)).toHaveLength(0);
  });

  it("honours a lower configured minimum", async () => {
    const f = await idleSession({
      tokens: 5000,
      contextSettings: { idleRollover: { minTokens: 4000 } },
    });
    f.responses.push(toolCall("context_rollover", { handoff: "Small idle continuation." }));
    await vi.advanceTimersByTimeAsync(SHORT_DELAY + WARMING_SETTLE_MS);
    await expect.poll(() => checkpoints(f).length).toBe(1);
  });

  it("does not arm in print mode, where no user returns", async () => {
    const f = await createSdkHarness([contextManagement], { contextWindow: 1_000_000 });
    await f.session.bindExtensions({ mode: "print" });
    f.responses.push(reply("Ready.", 250_000));
    await f.session.prompt("OLD-IDLE-TASK");
    await vi.advanceTimersByTimeAsync(SHORT_TTL * 2);
    expect(f.requests).toHaveLength(1);
  });

  it("skips a cache that already expired, for example after the machine slept", async () => {
    const f = await idleSession();
    vi.setSystemTime(Date.now() + SHORT_TTL);
    await vi.advanceTimersByTimeAsync(SHORT_DELAY + WARMING_SETTLE_MS);
    expect(f.requests).toHaveLength(1);
    expect(checkpoints(f)).toHaveLength(0);
  });

  it("is cancelled by new activity before the refresh point", async () => {
    const f = await idleSession();
    await vi.advanceTimersByTimeAsync(SHORT_DELAY - 10_000);
    f.responses.push(reply("Small follow-up.", 1000));
    await f.session.prompt("Quick question");
    await vi.advanceTimersByTimeAsync(SHORT_TTL * 2);
    expect(f.requests).toHaveLength(2);
    expect(checkpoints(f)).toHaveLength(0);
  });

  it("waits while Pi's idle cache warming keeps the cache alive", async () => {
    const f = await idleSession();
    let status: CacheWarmingStatus = { state: "scheduled", nextWarmAt: Date.now() + SHORT_DELAY };
    Object.defineProperty(f.session, "cacheWarmingStatus", {
      get: () => status,
      configurable: true,
    });
    const usage = reply("", 0).usage;
    /** Pi's refresh point: a warm request is in flight, then recorded and rescheduled. */
    const warm = async (last: boolean) => {
      await vi.advanceTimersByTimeAsync(SHORT_DELAY);
      status = { state: "refreshing" };
      await vi.advanceTimersByTimeAsync(WARMING_SETTLE_MS + 500);
      expect(f.requests).toHaveLength(1);
      f.manager.appendUsage("cache_warm", "anthropic", "claude-sonnet-4-5", usage);
      status = last
        ? { state: "inactive", reason: "30-minute idle safety limit reached" }
        : { state: "scheduled", nextWarmAt: Date.now() + SHORT_DELAY };
    };
    await warm(false);
    await warm(false);
    // At its idle limit Pi warms one last time and stops; the cache stays warm for one more lifetime.
    await warm(true);
    f.responses.push(toolCall("context_rollover", { handoff: "After warming." }));
    await vi.advanceTimersByTimeAsync(SHORT_DELAY - WARMING_SETTLE_MS);
    expect(f.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(WARMING_SETTLE_MS * 2);
    await expect.poll(() => checkpoints(f).length).toBe(1);
    expect(f.requests).toHaveLength(2);
  });

  it("queues input that arrives mid-preparation until after the checkpoint", async () => {
    const f = await idleSession();
    f.responses.push(
      toolCall("context_notes", { action: "write", name: "idle", content: "Saved." }, "notes"),
      toolCall("context_rollover", { handoff: "Idle continuation." }, "rollover"),
      reply("Answering the returned user."),
    );
    let steered = false;
    f.session.subscribe((event) => {
      if (event.type !== "tool_execution_start" || event.toolName !== "context_notes" || steered)
        return;
      steered = true;
      void f.session.steer("USER-RETURNED");
    });
    await vi.advanceTimersByTimeAsync(SHORT_DELAY + WARMING_SETTLE_MS);
    await expect.poll(() => f.requests.length).toBe(4);
    await f.session.waitForIdle();

    expect(steered).toBe(true);
    // Neither preparation request sees the returned user's message.
    expect(JSON.stringify(f.requests[1])).not.toContain("USER-RETURNED");
    expect(JSON.stringify(f.requests[2])).not.toContain("USER-RETURNED");
    // It runs after the checkpoint, in the new Context Window.
    expect(JSON.stringify(f.requests[3])).toContain("USER-RETURNED");
    expect(JSON.stringify(f.requests[3])).toContain("Idle continuation.");
    expect(JSON.stringify(f.requests[3])).not.toContain("OLD-IDLE-TASK");
    expect(checkpoints(f)).toHaveLength(1);
    expect(f.extensionErrors).toEqual([]);
  });
});
