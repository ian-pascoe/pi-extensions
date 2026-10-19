import { describe, expect, it } from "vitest";
import { getKeybindings } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import {
  escapeTaggedTheme,
  expectLinesFitWidth,
  taggedTheme,
} from "@ian-pascoe/pi-utils/ui-testing";
import { SecretDialog, type SecretDialogResult } from "../src/secret-dialog.js";
import { keys } from "./fixtures/secret-harness.js";

function dialog(names: readonly string[], reason?: string, theme = taggedTheme) {
  const results: SecretDialogResult[] = [];
  const component = new SecretDialog({
    names,
    reason,
    lifetimeMinutes: 15,
    theme,
    keybindings: getKeybindings(),
    requestRender: () => {},
    done: (result) => results.push(result),
  });
  const type = (...inputs: string[]) => {
    for (const input of inputs) component.handleInput(input);
  };
  /** The rendered lines without theme tags. */
  const screen = (width = 80) =>
    component.render(width).map((line) => line.replace(/<\/?[a-z:]+>/gi, ""));
  return { component, results, type, screen };
}

describe("Secret Request dialog", () => {
  it("shows the reason, the lifetime, and one bullet per character typed, never the value", () => {
    const { type, screen } = dialog(["API_TOKEN"], "Deploy to staging");
    type("s", "e", "c", "r", "e", "t", "-", "9", "🔑");
    const text = screen().join("\n");

    expect(text).toContain("Deploy to staging");
    expect(text).toContain("kept for 15 minutes");
    expect(text).toContain(`API_TOKEN  ${"•".repeat(9)}`);
    expect(text).not.toContain("secret-9");
    expect(text).not.toContain("🔑");
  });

  it("warns about a value shorter than 8 characters until it is long enough", () => {
    const { type, screen } = dialog(["PIN"]);
    type("1", "2", "3", "4");
    expect(screen().join("\n")).toContain("shorter than 8 characters");
    type("5", "6", "7", "8");
    expect(screen().join("\n")).not.toContain("shorter than 8 characters");
  });

  it("moves between fields with Tab and Shift+Tab, wrapping, and submits with Enter; empty fields are skipped", () => {
    const { type, results } = dialog(["FIRST", "SECOND", "THIRD"]);
    type(keys.paste("first-value"), keys.shiftTab, keys.paste("third-value"), keys.tab, keys.tab);
    type(keys.enter);

    expect(results).toEqual([
      {
        kind: "submitted",
        values: new Map([
          ["FIRST", "first-value"],
          ["THIRD", "third-value"],
        ]),
      },
    ]);
  });

  it("cancels the whole request with Escape, discarding typed values", () => {
    const { type, results } = dialog(["ONE", "TWO"]);
    type(keys.paste("typed"), keys.escape, keys.enter);
    expect(results).toEqual([{ kind: "cancelled" }]);
  });

  it("keeps newlines inside a paste, such as a private key, but drops a trailing one", () => {
    const { type, results } = dialog(["PRIVATE_KEY"]);
    type(keys.paste("-----BEGIN KEY-----\nabc\n-----END KEY-----\n"), keys.enter);
    expect(results).toEqual([
      {
        kind: "submitted",
        values: new Map([["PRIVATE_KEY", "-----BEGIN KEY-----\nabc\n-----END KEY-----"]]),
      },
    ]);
  });

  it("assembles a paste split across several inputs", () => {
    const { type, results } = dialog(["SPLIT"]);
    type("\x1b[200~split-", "across-", "chunks\x1b[201~", keys.enter);
    expect(results).toEqual([
      { kind: "submitted", values: new Map([["SPLIT", "split-across-chunks"]]) },
    ]);
  });

  it("deletes the last character with Backspace", () => {
    const { type, results } = dialog(["EDITED"]);
    type("a", "b", "c", "🔑", keys.backspace, keys.backspace, keys.enter);
    expect(results).toEqual([{ kind: "submitted", values: new Map([["EDITED", "ab"]]) }]);
  });

  it("fits narrow terminals, abbreviating a long value as a count", () => {
    // Escape-encoded tokens take no columns, so lines break where a real theme's would.
    const { component, type } = dialog(
      ["A_VERY_LONG_SECRET_NAME"],
      "A reason long enough to wrap.",
      escapeTaggedTheme,
    );
    type(keys.paste("x".repeat(200)));
    const lines = component.render(40);
    expectLinesFitWidth(lines, 40);
    expect(lines.map((line) => stripVTControlCharacters(line)).join("\n")).toContain("(200)");
  });
});
