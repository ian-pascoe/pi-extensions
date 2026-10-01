import { describe, expect, it } from "vitest";
import { BUILTIN_COMMAND_NAMES, isPiCommand } from "../src/pi-commands.js";

interface BuiltinSlashCommandModule {
  BUILTIN_SLASH_COMMANDS: ReadonlyArray<{ name: string }>;
}

describe("Pi commands", () => {
  it("matches the installed SDK's built-in slash commands", async () => {
    const sdkEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
    const builtinModule: BuiltinSlashCommandModule = await import(
      new URL("./core/slash-commands.js", sdkEntry).href
    );
    expect([...BUILTIN_COMMAND_NAMES].toSorted()).toEqual(
      builtinModule.BUILTIN_SLASH_COMMANDS.map(({ name }) => name).toSorted(),
    );
  });

  it("recognizes built-in and registered commands only", () => {
    const sourceInfo = {
      path: "<test>",
      source: "test",
      scope: "temporary",
      origin: "top-level",
    } as const;
    const commands = [{ name: "skill:review", source: "skill", sourceInfo } as const];
    expect(isPiCommand("model", [])).toBe(true);
    expect(isPiCommand("skill:review", commands)).toBe(true);
    expect(isPiCommand("nope", commands)).toBe(false);
  });
});
