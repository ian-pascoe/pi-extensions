import { stripVTControlCharacters } from "node:util";
import { initTheme, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager as TuiKeybindingsManager,
  TUI_KEYBINDINGS,
  CURSOR_MARKER,
  stripTerminalSequences,
  TuiMainScreen,
  type Component,
  type Terminal,
} from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  cycleDisplay,
  EditorChooser,
  effectiveWithSource,
  errorText,
  ModelPicker,
  nextCycleValue,
  scopeRow,
  SettingsMenu,
  ValueInput,
  type SettingsMenuTheme,
  type SettingsMenuUi,
} from "../src/settings-menu.js";
import { escapeTaggedTheme, expectLinesFitWidth, readableTags } from "../src/ui-testing.js";

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
    expect(input.render(60).at(-1)).toBe("<error>✗</error> <error>Not a number</error>");
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

describe("cycleDisplay", () => {
  const inEffect = effectiveWithSource("on", "project");

  it("shows what an unset option inherits", () => {
    expect(cycleDisplay({ own: undefined, inEffect, source: "project", scope: "session" })).toBe(
      "inherit (on · project)",
    );
  });

  it("shows the scope's own value, noting an override from another scope", () => {
    expect(cycleDisplay({ own: "off", inEffect, source: "session", scope: "session" })).toBe("off");
    expect(cycleDisplay({ own: "off", inEffect, source: "project", scope: "session" })).toBe(
      "off (overridden: on · project)",
    );
  });
});

/** A terminal that never touches the process TTY. */
class QuietTerminal implements Terminal {
  start(): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(): void {}
  get columns(): number {
    return 100;
  }
  get rows(): number {
    return 40;
  }
  get kittyProtocolActive(): boolean {
    return false;
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  setProgramStatus(): void {}
}

function createUi(): SettingsMenuUi {
  const tui = new TuiMainScreen(new QuietTerminal());
  vi.spyOn(tui, "requestRender").mockImplementation(() => {});
  return {
    tui,
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: Pi exports its KeybindingsManager as a type only; the menu's editor calls only matches(), which this pi-tui manager implements.
    keybindings: new TuiKeybindingsManager(TUI_KEYBINDINGS) as unknown as KeybindingsManager,
    theme: escapeTaggedTheme,
  };
}

class TestMenu extends SettingsMenu {
  readonly changes: string[] = [];
  headlineLines = [
    `Test ${escapeTaggedTheme.fg("accent", "ready")} with a long status line that has to wrap at narrow widths`,
  ];

  constructor(ui: SettingsMenuUi) {
    super("Test settings", ui, () => {});
    this.setList([scopeRow("session", ["session", "global"])], (id, value) => {
      this.changes.push(`${id}=${value}`);
    });
  }
  protected headline(): readonly string[] {
    return this.headlineLines;
  }
  refresh(): void {}
  fail(message: string): void {
    this.run(() => Promise.reject(new Error(message)));
  }
}

describe("SettingsMenu", () => {
  const tags = (line: string | undefined) => readableTags(line ?? "").trimEnd();

  it("frames an accent title, the headline, and Pi's settings list between borders", () => {
    const lines = new TestMenu(createUi()).render(80);
    expect(tags(lines[1])).toBe(" <accent><b>Test settings</b></accent>");
    expect(tags(lines[2])).toContain("Test <accent>ready</accent>");
    expect(tags(lines.at(0))).toMatch(/^<border>─+<\/border>$/);
    expect(tags(lines.at(-1))).toMatch(/^<border>─+<\/border>$/);
    expect(lines.map((line) => stripTerminalSequences(line)).join("\n")).toMatch(
      /→ Scope\s+session/,
    );
  });

  it("fits every line to narrow and wide widths", () => {
    const menu = new TestMenu(createUi());
    for (const width of [40, 120])
      expectLinesFitWidth(menu.render(width), width, { piThemedBody: true });
  });

  it("changes a row with Enter and reports the proposed value", () => {
    const menu = new TestMenu(createUi());
    menu.handleInput(enter);
    expect(menu.changes).toEqual(["scope=global"]);
  });

  it("shows a failed edit with a failure mark, then clears it on the next edit", async () => {
    const menu = new TestMenu(createUi());
    menu.fail("Settings are read-only");
    await menu.settled();
    const lines = menu.render(120);
    expect(lines.map(tags)).toContain(" <error>✗</error> <error>Settings are read-only</error>");
    for (const width of [40, 120])
      expectLinesFitWidth(menu.render(width), width, { piThemedBody: true });
    menu.fail("Second");
    expect(menu.render(120).map(tags).join("\n")).not.toContain("read-only");
  });
});

describe("EditorChooser", () => {
  it("offers Edit... and inherit, and inherits on request", () => {
    const inherit = vi.fn();
    const chooser = new EditorChooser(
      createUi(),
      "Prompt",
      "text",
      () => {},
      inherit,
      () => {},
    );
    const text = screen(chooser).join("\n");
    expect(text).toContain("Edit...");
    chooser.handleInput(down);
    chooser.handleInput(enter);
    expect(inherit).toHaveBeenCalledOnce();
  });

  it("keeps the editor open and shows a failure mark when submit throws", () => {
    const chooser = new EditorChooser(
      createUi(),
      "Prompt",
      "text",
      () => {
        throw new Error("Prompt must not be empty");
      },
      () => {},
      () => {},
    );
    chooser.handleInput(enter);
    chooser.handleInput(enter);
    const lines = chooser.render(120);
    expect(readableTags(lines.at(-1) ?? "").trimEnd()).toBe(
      "<error>✗</error> <error>Prompt must not be empty</error>",
    );
    for (const width of [40, 120])
      expectLinesFitWidth(
        // The focused editor draws Pi's cursor marker, which is not text.
        chooser.render(width).map((line) => line.replace(CURSOR_MARKER, "")),
        width,
        { piThemedBody: true },
      );
  });
});
