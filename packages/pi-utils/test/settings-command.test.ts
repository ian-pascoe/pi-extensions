import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  completeSettingsCommandArguments,
  parseSettingsCommand,
  type SettingsCommand,
  type SettingsCommandSpec,
  type SettingsCompletionSpec,
} from "../src/settings-command.js";
import type { LayeredSettingScope } from "../src/layered-settings.js";

const schema = Type.Object(
  { enabled: Type.Optional(Type.Boolean()), limit: Type.Optional(Type.Integer({ minimum: 1 })) },
  { additionalProperties: false },
);
interface Options {
  enabled?: boolean;
  limit?: number;
}
const optionKeys = ["enabled", "limit"] as const;
type Key = (typeof optionKeys)[number];
type Extra = { action: "reset"; scope: LayeredSettingScope } | { action: "pin"; name: string };
type Command = SettingsCommand<Options, Key, Extra>;

const usage = "Usage: /demo [on|off|status|reset|inherit [key]|set <key> <JSON>]";
const spec: SettingsCommandSpec<Options, Key, Extra> = {
  usage,
  optionKey(text) {
    const key = optionKeys.find((candidate) => candidate === text);
    if (!key) throw new Error(`Unknown option ${text}`);
    return key;
  },
  parseOptions(value) {
    if (!Value.Check(schema, value)) throw new Error("Invalid option value");
    return value;
  },
  toggle: (enabled) => ({ key: "enabled", patch: { enabled } }),
  parseExtra(text, scope) {
    if (text === "reset") return { action: "reset", scope };
    const pin = /^pin\s+(\S+)$/.exec(text);
    return pin?.[1] ? { action: "pin", name: pin[1] } : undefined;
  },
};
const parse = (input: string): Command => parseSettingsCommand(input, spec);

describe("parseSettingsCommand", () => {
  it("opens the menu for blank input and reports status", () => {
    expect(parse("")).toEqual({ action: "menu" });
    expect(parse("   ")).toEqual({ action: "menu" });
    expect(parse("status")).toEqual({ action: "status" });
  });

  it("rejects a scope flag on the menu and status", () => {
    expect(() => parse("--global")).toThrow(usage);
    expect(() => parse("status --project")).toThrow(usage);
  });

  it("maps on and off to the toggle at the session scope by default", () => {
    expect(parse("on")).toEqual({
      action: "set",
      scope: "session",
      key: "enabled",
      patch: { enabled: true },
    });
    expect(parse("off")).toMatchObject({ patch: { enabled: false } });
  });

  it("reads a trailing scope flag", () => {
    expect(parse("off --global")).toMatchObject({ scope: "global" });
    expect(parse("on  --project")).toMatchObject({ scope: "project" });
    expect(parse("reset --global")).toEqual({ action: "reset", scope: "global" });
  });

  it("inherits the toggle's key without an argument and a validated key otherwise", () => {
    expect(parse("inherit")).toEqual({ action: "inherit", scope: "session", key: "enabled" });
    expect(parse("inherit limit --project")).toEqual({
      action: "inherit",
      scope: "project",
      key: "limit",
    });
    expect(() => parse("inherit nonsense")).toThrow("Unknown option nonsense");
  });

  it("parses `set <key> <JSON>` through the spec's validation", () => {
    expect(parse("set limit 4 --global")).toEqual({
      action: "set",
      scope: "global",
      key: "limit",
      patch: { limit: 4 },
    });
    expect(() => parse("set limit 0")).toThrow("Invalid option value");
    expect(() => parse("set nonsense 1")).toThrow("Unknown option nonsense");
    expect(() => parse("set limit {oops")).toThrow(SyntaxError);
  });

  it("throws the usage for malformed commands", () => {
    expect(() => parse("set limit")).toThrow(usage);
    expect(() => parse("set")).toThrow(usage);
    expect(() => parse("bogus")).toThrow(usage);
    expect(() => parse("inherit a b")).toThrow(usage);
  });

  it("tries the command's own actions first and falls through on undefined", () => {
    expect(parse("reset")).toEqual({ action: "reset", scope: "session" });
    expect(parse("pin build")).toEqual({ action: "pin", name: "build" });
    expect(() => parse("pin")).toThrow(usage);
  });

  it("works without extra actions", () => {
    const plain: SettingsCommandSpec<Options, Key> = {
      usage,
      optionKey: spec.optionKey,
      parseOptions: spec.parseOptions,
      toggle: spec.toggle,
    };
    expect(() => parseSettingsCommand("reset", plain)).toThrow(usage);
    expect(parseSettingsCommand("off", plain)).toMatchObject({ action: "set" });
  });
});

describe("completeSettingsCommandArguments", () => {
  const completion: SettingsCompletionSpec = {
    words: ["on", "off", "status", "reset", "inherit", "set", "pin"],
    optionKeys,
    parse,
    extra: (prefix) => (/^pin\s+$/.test(prefix) ? ["pin build", "pin test"] : []),
  };
  const values = (prefix: string) =>
    completeSettingsCommandArguments(prefix, completion).map((item) => item.value);

  it("offers the words that start with the prefix, labelled by value", () => {
    expect(values("")).toEqual(completion.words);
    expect(values("s")).toEqual(["status", "set"]);
    expect(completeSettingsCommandArguments("of", completion)).toEqual([
      { value: "off", label: "off" },
    ]);
  });

  it("offers option keys after set and inherit, replacing the whole prefix", () => {
    expect(values("set ")).toEqual(["set enabled", "set limit"]);
    expect(values("inherit l")).toEqual(["inherit limit"]);
    expect(values("on ")).not.toContain("on enabled");
  });

  it("adds the command's own completions", () => {
    expect(values("pin ")).toEqual(["pin build", "pin test"]);
  });

  it("offers scope flags once the command parses at the session scope", () => {
    expect(values("on ")).toEqual(["on --global", "on --project"]);
    expect(values("inherit limit --")).toEqual([
      "inherit limit --global",
      "inherit limit --project",
    ]);
    expect(values("reset --p")).toEqual(["reset --project"]);
  });

  it("offers no scope flag for an incomplete command or one that already has a scope", () => {
    expect(values("set limit ")).toEqual([]);
    expect(values("on --global ")).toEqual([]);
    expect(values("status ")).toEqual([]);
  });
});
