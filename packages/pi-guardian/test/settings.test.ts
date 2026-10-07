import { describe, expect, it } from "vitest";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  completeGuardianCommandArguments,
  parseGuardianCommand,
  updatedToolEntries,
} from "../src/guardian-command.js";
import { parseGuardianMenuValue } from "../src/guardian-menu.js";
import {
  escalationThinkingLevel,
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
        commands: {},
        policy: "",
        reviewTimeoutMs: 60_000,
        evidenceBudgetTokens: "auto",
        onDeny: "block",
        maxConsecutiveRejections: 3,
        verbose: false,
      },
      sources: expect.objectContaining({ enabled: "default", tools: "default" }),
    });
  });

  it("merges Tool Policies per entry and lets null reset an entry to the built-in default", () => {
    const { settings, sources } = resolve(
      { tools: { bash: "allow", mcp__x: "deny" }, commands: { "npm test": "allow", rm: "deny" } },
      { tools: { bash: "review", terminal_start: "allow" }, commands: { make: "allow" } },
      { tools: { mcp__x: null }, commands: { rm: null, "git push": "review" } },
    );
    expect(settings.tools).toEqual({ bash: "review", terminal_start: "allow" });
    expect(settings.commands).toEqual({
      "npm test": "allow",
      make: "allow",
      "git push": "review",
    });
    expect(sources["tools"]).toBe("session");
    expect(sources["commands"]).toBe("session");
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

  it("rejects Command Rules that could never match", () => {
    expect(() => resolveInvalid('{"commands":{"./gradlew test":"allow"}}')).toThrow(
      'Invalid global Guardian settings/commands: Command Rule "./gradlew test" must start with a bare program name, not a path or an assignment',
    );
    expect(() => resolveInvalid('{"commands":{"npm test | tee":"allow"}}')).toThrow(
      /must be literal words without shell syntax/,
    );
    expect(() => resolveInvalid('{"commands":{"rm":"maybe"}}')).toThrow(
      /Invalid global Guardian settings/,
    );
    expect(() => parseGuardianCommand('set commands {"bin/test":"deny"} --global')).toThrow(
      /must start with a bare program name/,
    );
    expect(() => parseGuardianCommand("command PAGER=x git deny")).toThrow(/assignment/);
    expect(resolve({ commands: { "npm test -- src/a": "allow" } }, {}).settings.commands).toEqual({
      "npm test -- src/a": "allow",
    });
  });

  it("derives the Escalation Pass thinking level: low, or the first pass's if higher", () => {
    expect(escalationThinkingLevel({ thinkingLevel: "off" })).toBe("low");
    expect(escalationThinkingLevel({ thinkingLevel: "high" })).toBe("high");
    expect(escalationThinkingLevel({ thinkingLevel: "high", escalationThinkingLevel: "off" })).toBe(
      "off",
    );
    expect(escalationThinkingLevel({})).toBe("low");
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
    expect(parseGuardianCommand('set commands {"npm test":"allow"}')).toMatchObject({
      key: "commands",
      patch: { commands: { "npm test": "allow" } },
    });
    expect(parseGuardianCommand("command git push --force deny --global")).toEqual({
      action: "command",
      scope: "global",
      prefix: "git push --force",
      value: "deny",
    });
    expect(() => parseGuardianCommand("command rm maybe")).toThrow(/Usage/);
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
    expect(values("command rm d")).toEqual(["command rm deny", "command rm default"]);
    expect(values("off ")).toEqual(["off --global", "off --project"]);
  });

  it("parses menu values", () => {
    expect(parseGuardianMenuValue("reviewTimeoutMs", "30", "session")).toEqual({
      action: "set",
      key: "reviewTimeoutMs",
      patch: { reviewTimeoutMs: 30_000 },
    });
    expect(
      parseGuardianMenuValue("commands", "npm test=allow, rm=deny, make=default", "global"),
    ).toMatchObject({
      patch: { commands: { "npm test": "allow", rm: "deny", make: null } },
    });
    expect(parseGuardianMenuValue("commands", '{"git push":"review"}', "global")).toMatchObject({
      patch: { commands: { "git push": "review" } },
    });
    expect(parseGuardianMenuValue("commands", "none", "global")).toMatchObject({
      patch: { commands: {} },
    });
    expect(() => parseGuardianMenuValue("commands", "rm", "global")).toThrow(/prefix=/);
    expect(() => parseGuardianMenuValue("commands", "rm=maybe", "global")).toThrow(/Invalid/);
    expect(parseGuardianMenuValue("evidenceBudgetTokens", "inherit", "global")).toEqual({
      action: "inherit",
      key: "evidenceBudgetTokens",
    });
    expect(() => parseGuardianMenuValue("maxConsecutiveRejections", "", "session")).toThrow();
  });
});
