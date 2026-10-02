import { stripVTControlCharacters } from "node:util";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { initTheme, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager as TuiKeybindingsManager,
  TUI_KEYBINDINGS,
  TuiMainScreen,
  type Terminal,
} from "@earendil-works/pi-tui";
import {
  AdvisorSettingsMenu,
  type AdvisorMenuHost,
  type AdvisorMenuView,
  type AdvisorScopedOptions,
} from "../src/advisor-menu.js";
import type { AdvisorRenderTheme } from "../src/advisor-rendering.js";
import type {
  AdvisorChange,
  AdvisorOptions,
  AdvisorSettingScope,
  AdvisorSettingSource,
} from "../src/advisor-settings.js";

const keys = {
  up: "\x1b[A",
  down: "\x1b[B",
  enter: "\r",
  escape: "\x1b",
  backspace: "\x7f",
};

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
}

const defaults = {
  enabled: false,
  includeSubagents: false,
  prompt: "Default review prompt.",
  allowedTools: ["read", "grep"],
  catchUpThreshold: 3,
  reviewTimeoutMs: 120_000,
  maxToolCalls: 8,
  maxCorrectiveTurns: 1,
  maxFindingsPerReview: 4,
} satisfies AdvisorOptions;

/** In-memory scoped settings with the same precedence as the extension. */
function createHost({ paused = false, failWith }: { paused?: boolean; failWith?: string } = {}) {
  const authored: AdvisorScopedOptions = {
    session: {},
    project: {},
    global: {},
  };
  const applied: Array<{ scope: AdvisorSettingScope; change: AdvisorChange }> = [];
  const state = { paused, resumed: 0 };
  const host: AdvisorMenuHost = {
    view(): AdvisorMenuView {
      const settings: AdvisorOptions = { ...defaults };
      const sources: Record<string, AdvisorSettingSource> = {};
      for (const scope of ["global", "project", "session"] as const) {
        Object.assign(settings, authored[scope]);
        for (const key of Object.keys(authored[scope])) sources[key] = scope;
      }
      return {
        headline: [state.paused ? "Advisor paused: Deadline exceeded" : "Advisor armed"],
        paused: state.paused,
        scopes: ["session", "project", "global"],
        settings,
        sources,
        authored,
        models: ["anthropic/claude-sonnet", "openai/gpt"],
        tools: ["read", "grep", "find", "lsp_diagnostics"],
      };
    },
    async apply(scope, change) {
      if (failWith) throw new Error(failWith);
      applied.push({ scope, change });
      if (change.action === "inherit") delete authored[scope][change.key];
      else Object.assign(authored[scope], change.patch);
    },
    async resume() {
      state.resumed++;
      state.paused = false;
    },
  };
  return { host, applied, authored, state };
}

function createMenu(options: Parameters<typeof createHost>[0] = {}) {
  const fixture = createHost(options);
  const tui = new TuiMainScreen(new QuietTerminal());
  vi.spyOn(tui, "requestRender").mockImplementation(() => {});
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: Pi exports its KeybindingsManager as a type only; the editor calls only matches(), which this pi-tui manager implements.
  const keybindings = new TuiKeybindingsManager(TUI_KEYBINDINGS) as unknown as KeybindingsManager;
  const done = vi.fn();
  const menu = new AdvisorSettingsMenu(fixture.host, { tui, keybindings, theme: plainTheme }, done);
  const screen = () =>
    menu
      .render(100)
      .map((line) => stripVTControlCharacters(line).trimEnd())
      .join("\n");
  const selected = () =>
    menu
      .render(100)
      .map((line) => stripVTControlCharacters(line))
      .find((line) => line.trimStart().startsWith("→"));
  const press = (...inputs: string[]) => {
    for (const input of inputs) menu.handleInput(input);
  };
  const type = (text: string) => press(...text.split(""));
  /** Move the cursor to the row whose label starts with `label`. */
  const goTo = (label: string) => {
    for (let step = 0; step < 20; step++) {
      if (selected()?.replace("→", "").trimStart().startsWith(label)) return;
      press(keys.down);
    }
    throw new Error(`No menu row ${label}`);
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { ...fixture, menu, done, screen, selected, press, type, goTo, settle };
}

const plainTheme: AdvisorRenderTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};

beforeAll(() => initTheme("dark"));

describe("Advisor settings menu", () => {
  it("shows the live headline, the scope, and every setting with its effective value", () => {
    const { screen } = createMenu();
    const text = screen();
    expect(text).toContain("Advisor armed");
    expect(text).toMatch(/Scope\s+session/);
    expect(text).toMatch(/enabled\s+off/);
    expect(text).toMatch(/model\s+inherit/);
    expect(text).toMatch(/allowedTools\s+read, grep/);
    expect(text).toMatch(/reviewTimeoutMs\s+120s/);
    expect(text).not.toContain("Resume");
  });

  it("cycles a boolean at the selected scope and shows its source", async () => {
    const { goTo, press, applied, screen, settle } = createMenu();
    goTo("enabled");
    press(keys.enter);
    await settle();
    expect(applied).toEqual([
      { scope: "session", change: { action: "set", key: "enabled", patch: { enabled: true } } },
    ]);
    expect(screen()).toMatch(/enabled \[session\]\s+on/);
  });

  it("offers inherit only when the selected scope has its own value", async () => {
    const { goTo, press, applied, settle } = createMenu();
    goTo("enabled");
    press(keys.enter);
    await settle();
    press(keys.enter);
    await settle();
    press(keys.enter);
    await settle();
    expect(applied.map(({ change }) => change)).toEqual([
      { action: "set", key: "enabled", patch: { enabled: true } },
      { action: "set", key: "enabled", patch: { enabled: false } },
      { action: "inherit", key: "enabled" },
    ]);
    // Nothing is authored now, so the next step skips the no-op inherit.
    press(keys.enter);
    await settle();
    expect(applied.at(-1)?.change).toEqual({
      action: "set",
      key: "enabled",
      patch: { enabled: true },
    });
  });

  it("writes edits to the scope chosen in the Scope row", async () => {
    const { goTo, press, applied, settle } = createMenu();
    goTo("Scope");
    press(keys.enter, keys.enter);
    goTo("includeSubagents");
    press(keys.enter);
    await settle();
    expect(applied).toEqual([
      {
        scope: "global",
        change: { action: "set", key: "includeSubagents", patch: { includeSubagents: true } },
      },
    ]);
  });

  it("validates numeric input inline and converts the review deadline from seconds", async () => {
    const { goTo, press, type, applied, screen, settle } = createMenu();
    goTo("maxFindingsPerReview");
    press(keys.enter);
    type("99");
    press(keys.enter);
    await settle();
    expect(applied).toEqual([]);
    expect(screen()).toMatch(/maxFindingsPerReview/);
    expect(screen()).toMatch(/must be|Expected|less/i);
    press(keys.backspace, keys.backspace);
    type("6");
    press(keys.enter);
    await settle();
    goTo("reviewTimeoutMs");
    press(keys.enter);
    type("90");
    press(keys.enter);
    await settle();
    expect(applied.map(({ change }) => change)).toEqual([
      { action: "set", key: "maxFindingsPerReview", patch: { maxFindingsPerReview: 6 } },
      { action: "set", key: "reviewTimeoutMs", patch: { reviewTimeoutMs: 90_000 } },
    ]);
  });

  it("accepts off for the catch-up threshold and inherit for any numeric setting", async () => {
    const { goTo, press, type, applied, settle } = createMenu();
    goTo("catchUpThreshold");
    press(keys.enter);
    type("off");
    press(keys.enter);
    await settle();
    goTo("catchUpThreshold");
    press(keys.enter);
    type("inherit");
    press(keys.enter);
    await settle();
    expect(applied.map(({ change }) => change)).toEqual([
      { action: "set", key: "catchUpThreshold", patch: { catchUpThreshold: "off" } },
      { action: "inherit", key: "catchUpThreshold" },
    ]);
  });

  it("picks a model from a searchable list", async () => {
    const { goTo, press, type, applied, settle } = createMenu();
    goTo("model");
    press(keys.enter);
    type("gpt");
    press(keys.enter);
    await settle();
    expect(applied.map(({ change }) => change)).toEqual([
      { action: "set", key: "model", patch: { model: "openai/gpt" } },
    ]);
  });

  it("toggles granted tools and marks configured names that are unavailable", async () => {
    const { goTo, press, applied, authored, menu, screen, settle } = createMenu();
    authored.session.allowedTools = ["read", "missing_tool"];
    menu.refresh();
    goTo("allowedTools");
    press(keys.enter);
    expect(screen()).toMatch(/missing_tool \(unavailable\)\s+on/);
    for (let step = 0; step < 10; step++) {
      if (
        screen()
          .split("\n")
          .some((line) => /→\s*grep/.test(line))
      )
        break;
      press(keys.down);
    }
    press(keys.enter);
    await settle();
    expect(applied.map(({ change }) => change)).toEqual([
      {
        action: "set",
        key: "allowedTools",
        patch: { allowedTools: ["read", "missing_tool", "grep"] },
      },
    ]);
  });

  it("edits the prompt in Pi's editor component and can inherit it", async () => {
    const { goTo, press, type, applied, screen, settle } = createMenu();
    goTo("prompt");
    press(keys.enter);
    expect(screen()).toContain("Edit");
    press(keys.enter);
    expect(screen()).toContain("Default review prompt.");
    type(" Be terse.");
    press(keys.enter);
    await settle();
    goTo("prompt");
    press(keys.enter, keys.down, keys.enter);
    await settle();
    expect(applied.map(({ change }) => change)).toEqual([
      {
        action: "set",
        key: "prompt",
        patch: { prompt: "Default review prompt. Be terse." },
      },
      { action: "inherit", key: "prompt" },
    ]);
  });

  it("offers Resume only while paused", async () => {
    const { goTo, press, state, screen, settle } = createMenu({ paused: true });
    expect(screen()).toContain("Advisor paused: Deadline exceeded");
    goTo("Resume");
    press(keys.enter);
    await settle();
    expect(state.resumed).toBe(1);
    expect(screen()).not.toContain("Resume");
  });

  it("shows a failed edit inline and keeps the menu open", async () => {
    const { goTo, press, done, screen, settle } = createMenu({
      failWith: "Advisor project settings require a trusted project",
    });
    goTo("enabled");
    press(keys.enter);
    await settle();
    expect(screen()).toContain("Advisor project settings require a trusted project");
    expect(done).not.toHaveBeenCalled();
  });

  it("closes on Escape", () => {
    const { press, done } = createMenu();
    press(keys.escape);
    expect(done).toHaveBeenCalledOnce();
  });
});
