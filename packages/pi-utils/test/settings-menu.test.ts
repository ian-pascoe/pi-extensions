import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  errorText,
  ModelPicker,
  nextCycleValue,
  ValueInput,
  type SettingsMenuTheme,
} from "../src/settings-menu.js";

const enter = "\r";
const escape = "\x1b";
const down = "\x1b[B";
const taggedTheme: SettingsMenuTheme = {
  fg: (color, text) => `<${color}>${text}</${color}>`,
  bold: (text) => `<b>${text}</b>`,
};

beforeAll(() => initTheme("dark"));

function screen(component: Component): string[] {
  return component.render(60).map((line) => stripVTControlCharacters(line).trimEnd());
}

function type(component: Component, text: string): void {
  for (const character of text) component.handleInput?.(character);
}

describe("errorText", () => {
  it("returns an Error's message and stringifies anything else", () => {
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorText("plain")).toBe("plain");
    expect(errorText(42)).toBe("42");
  });
});

describe("nextCycleValue", () => {
  const values = ["inherit", "on", "off"] as const;

  it("advances and wraps", () => {
    expect(nextCycleValue(values, "inherit")).toBe("on");
    expect(nextCycleValue(values, "on")).toBe("off");
    expect(nextCycleValue(values, "off")).toBe("inherit");
  });

  it("starts at the first value for a current value outside the cycle", () => {
    expect(nextCycleValue(values, "inherit (on · global)")).toBe("inherit");
  });

  it("has no next value for an empty cycle", () => {
    expect(nextCycleValue([], "on")).toBeUndefined();
  });
});

describe("ValueInput", () => {
  function createInput(submit: (text: string) => void = () => {}) {
    const cancel = vi.fn();
    const input = new ValueInput("limit", "a number, or inherit", taggedTheme, submit, cancel);
    return { input, cancel };
  }

  it("renders the bold title, the field, and the dim hint", () => {
    const { input } = createInput();
    const lines = input.render(60);
    expect(lines[0]).toBe("<b>limit</b>");
    expect(lines.at(-1)).toBe("<dim>a number, or inherit</dim>");
  });

  it("submits the typed text", () => {
    const submit = vi.fn();
    const { input } = createInput(submit);
    type(input, "12");
    input.handleInput(enter);
    expect(submit).toHaveBeenCalledWith("12");
  });

  it("shows a thrown message until the next keystroke", () => {
    const { input } = createInput(() => {
      throw new Error("Not a number");
    });
    type(input, "x");
    input.handleInput(enter);
    expect(input.render(60).at(-1)).toBe("<error>✖ Not a number</error>");
    type(input, "y");
    expect(input.render(60).at(-1)).toBe("<dim>a number, or inherit</dim>");
  });

  it("cancels on escape", () => {
    const { input, cancel } = createInput();
    input.handleInput(escape);
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("ModelPicker", () => {
  const models = ["anthropic/claude-sonnet", "openai/gpt", "openai/o-mini"];

  function createPicker() {
    const choose = vi.fn();
    const cancel = vi.fn();
    return { picker: new ModelPicker(models, choose, cancel), choose, cancel };
  }

  it("lists inherit first, then every model", () => {
    const { picker } = createPicker();
    const text = screen(picker).join("\n");
    expect(text.indexOf("inherit")).toBeGreaterThanOrEqual(0);
    for (const model of models) {
      expect(text.indexOf(model)).toBeGreaterThan(text.indexOf("inherit"));
    }
  });

  it("chooses the highlighted entry", () => {
    const { picker, choose } = createPicker();
    picker.handleInput(enter);
    expect(choose).toHaveBeenLastCalledWith("inherit");
    picker.handleInput(down);
    picker.handleInput(enter);
    expect(choose).toHaveBeenLastCalledWith("anthropic/claude-sonnet");
  });

  it("fuzzy-filters the list as the user types", () => {
    const { picker, choose } = createPicker();
    type(picker, "omini");
    const text = screen(picker).join("\n");
    expect(text).toContain("openai/o-mini");
    expect(text).not.toContain("anthropic/claude-sonnet");
    picker.handleInput(enter);
    expect(choose).toHaveBeenCalledWith("openai/o-mini");
  });

  it("cancels on escape", () => {
    const { picker, cancel } = createPicker();
    picker.handleInput(escape);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
