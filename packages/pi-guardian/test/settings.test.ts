import { describe, expect, it } from "vitest";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  completeGuardianCommandArguments,
  parseGuardianCommand,
  updatedToolEntries,
} from "../src/guardian-command.js";
import { parseGuardianMenuValue } from "../src/guardian-menu.js";
import {
  evidenceBudget,
  readGuardianSettings,
  type GuardianOptions,
} from "../src/guardian-settings.js";

function resolve(global: GuardianOptions, project: GuardianOptions, session?: GuardianOptions) {
  const documents = {
    global: JSON.stringify({ guardian: global }),
    project: JSON.stringify({ guardian: project }),
  };
  const storage: Parameters<typeof SettingsManager.fromStorage>[0] = {
    withLock(scope, update) {
      const next = update(documents[scope]);
      if (next !== undefined) documents[scope] = next;
    },
  };
  const settingsManager = SettingsManager.fromStorage(storage, { projectTrusted: true });
  const sessionManager = SessionManager.inMemory();
  if (session)
    sessionManager.appendCustomEntry("pi-guardian-settings", { version: 1, overrides: session });
  return readGuardianSettings({ settingsManager, sessionManager });
}

/** Authored JSON that the settings schema must reject. */
function resolveInvalid(global: string) {
  const storage: Parameters<typeof SettingsManager.fromStorage>[0] = {
    withLock(scope, update) {
      update(scope === "global" ? `{"guardian":${global}}` : "{}");
    },
  };
  const settingsManager = SettingsManager.fromStorage(storage, { projectTrusted: true });
  return readGuardianSettings({ settingsManager, sessionManager: SessionManager.inMemory() });
}

describe("Guardian settings", () => {
  it("defaults to enabled with conservative review settings", () => {
    expect(resolve({}, {})).toEqual({
      settings: {
        enabled: true,
        thinkingLevel: "low",
        tools: {},
        safeCommands: [],
        policy: "",
        reviewTimeoutMs: 60_000,
        evidenceBudgetTokens: "auto",
        onDeny: "block",
        maxConsecutiveRejections: 3,
      },
      sources: expect.objectContaining({ enabled: "default", tools: "default" }),
    });
  });

  it("merges Tool Policies per entry and lets null reset an entry to the built-in default", () => {
    const { settings, sources } = resolve(
      { tools: { bash: "allow", mcp__x: "deny" }, safeCommands: ["npm test"] },
      { tools: { bash: "review", terminal_start: "allow" }, safeCommands: ["make"] },
      { tools: { mcp__x: null }, safeCommands: ["npm test"] },
    );
    expect(settings.tools).toEqual({ bash: "review", terminal_start: "allow" });
    expect(settings.safeCommands).toEqual(["npm test", "make"]);
    expect(sources["tools"]).toBe("session");
  });

  it("lets a trusted project weaken Guardian (ADR-0002)", () => {
    expect(resolve({ enabled: true }, { enabled: false }).settings.enabled).toBe(false);
  });

  it("rejects invalid authored settings", () => {
    expect(() => resolveInvalid('{"tools":{"bash":"maybe"}}')).toThrow(
      /Invalid global Guardian settings/,
    );
    expect(() => resolveInvalid('{"onDeny":"prompt"}')).toThrow(/Invalid global Guardian settings/);
  });

  it("rejects safeCommands that could never match", () => {
    expect(() => resolveInvalid('{"safeCommands":["./gradlew test"]}')).toThrow(
      'Invalid global Guardian settings/safeCommands/0: Safe Command "./gradlew test" must start with a bare program name, not a path',
    );
    expect(() => resolveInvalid('{"safeCommands":["npm test | tee"]}')).toThrow(
      /must be literal words without shell syntax/,
    );
    expect(() => parseGuardianCommand('set safeCommands ["bin/test"] --global')).toThrow(
      /must start with a bare program name/,
    );
    expect(resolve({ safeCommands: ["npm test -- src/a"] }, {}).settings.safeCommands).toEqual([
      "npm test -- src/a",
    ]);
  });

  it("budgets evidence at a quarter of the context window, at most 32K", () => {
    expect(evidenceBudget("auto", 200_000)).toBe(32_000);
    expect(evidenceBudget("auto", 64_000)).toBe(16_000);
    expect(evidenceBudget("auto", undefined)).toBe(32_000);
    expect(evidenceBudget(50_000, 20_000)).toBe(20_000);
  });
});

describe("/guardian command", () => {
  it("parses scoped changes", () => {
    expect(parseGuardianCommand("")).toEqual({ action: "menu" });
    expect(parseGuardianCommand("status")).toEqual({ action: "status" });
    expect(parseGuardianCommand("off --global")).toEqual({
      action: "set",
      scope: "global",
      key: "enabled",
      patch: { enabled: false },
    });
    expect(parseGuardianCommand("tool bash deny --project")).toEqual({
      action: "tool",
      scope: "project",
      name: "bash",
      value: "deny",
    });
    expect(parseGuardianCommand('set safeCommands ["npm test"]')).toMatchObject({
      key: "safeCommands",
      patch: { safeCommands: ["npm test"] },
    });
    expect(() => parseGuardianCommand("tool bash maybe")).toThrow(/Usage/);
    expect(() => parseGuardianCommand("set nonsense 1")).toThrow(/Unknown Guardian option/);
    expect(() => parseGuardianCommand("set maxConsecutiveRejections -1")).toThrow(/Invalid/);
  });

  it("updates one tool entry within a scope", () => {
    expect(updatedToolEntries(undefined, "bash", "deny")).toEqual({ bash: "deny" });
    expect(updatedToolEntries({ bash: "deny" }, "read", "default")).toEqual({
      bash: "deny",
      read: null,
    });
    expect(updatedToolEntries({ bash: "deny" }, "bash", "inherit")).toBeUndefined();
  });

  it("completes subcommands, keys, tool values, and scopes", () => {
    const values = (prefix: string) =>
      completeGuardianCommandArguments(prefix).map((item) => item.value);
    expect(values("t")).toEqual(["tool"]);
    expect(values("set on")).toEqual(["set onDeny"]);
    expect(values("tool bash d")).toEqual(["tool bash deny", "tool bash default"]);
    expect(values("off ")).toEqual(["off --global", "off --project"]);
  });

  it("parses menu values", () => {
    expect(parseGuardianMenuValue("reviewTimeoutMs", "30", "session")).toEqual({
      action: "set",
      key: "reviewTimeoutMs",
      patch: { reviewTimeoutMs: 30_000 },
    });
    expect(parseGuardianMenuValue("safeCommands", "npm test, make", "global")).toMatchObject({
      patch: { safeCommands: ["npm test", "make"] },
    });
    expect(parseGuardianMenuValue("evidenceBudgetTokens", "inherit", "global")).toEqual({
      action: "inherit",
      key: "evidenceBudgetTokens",
    });
    expect(() => parseGuardianMenuValue("maxConsecutiveRejections", "", "session")).toThrow();
  });
});
