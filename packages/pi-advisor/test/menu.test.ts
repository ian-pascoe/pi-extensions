import { beforeAll, describe, expect, it, vi } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  AdvisorSettingsMenu,
  type AdvisorMenuHost,
  type AdvisorMenuView,
  type AdvisorScopedOptions,
} from "../src/advisor-menu.js";
import type { AdvisorRenderTheme } from "../src/advisor-rendering.js";
import { createMenuTui, keys, menuDriver } from "./fixtures/menu-ui.js";
import type {
  AdvisorChange,
  AdvisorOptions,
  AdvisorSettingScope,
  AdvisorSettingSource,
} from "../src/advisor-settings.js";

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
  const { tui, keybindings } = createMenuTui();
  const done = vi.fn();
  const menu = new AdvisorSettingsMenu(fixture.host, { tui, keybindings, theme: plainTheme }, done);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { ...fixture, menu, done, settle, ...menuDriver(() => menu) };
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
    expect(text).toMatch(/enabled\s+inherit \(off · default\)/);
    expect(text).toMatch(/thinkingLevel\s+inherit \(observed agent\)/);
    expect(text).toMatch(/model\s+inherit/);
    expect(text).toMatch(/allowedTools\s+read, grep/);
    expect(text).toMatch(/reviewTimeoutMs\s+120s/);
    expect(text).not.toContain("Resume");
  });

  it("cycles the selected scope's own value through inherit, on, and off", async () => {
    const { goTo, press, applied, screen, menu } = createMenu();
    const row = () =>
      screen()
        .split("\n")
        .find((line) => line.includes("enabled"))
        ?.trim()
        .replace(/\s+/g, " ");
    goTo("enabled");
    const seen = [row()];
    for (let step = 0; step < 4; step++) {
      press(keys.enter);
      await menu.settled();
      seen.push(row());
    }
    expect(seen).toEqual([
      "→ enabled inherit (off · default)",
      "→ enabled on",
      "→ enabled off",
      "→ enabled inherit (off · default)",
      "→ enabled on",
    ]);
    expect(applied).toEqual([
      { scope: "session", change: { action: "set", key: "enabled", patch: { enabled: true } } },
      { scope: "session", change: { action: "set", key: "enabled", patch: { enabled: false } } },
      { scope: "session", change: { action: "inherit", key: "enabled" } },
      { scope: "session", change: { action: "set", key: "enabled", patch: { enabled: true } } },
    ]);
  });

  it("reaches every session value when another scope sets the option", async () => {
    const { goTo, press, authored, screen, menu } = createMenu();
    authored.project.enabled = true;
    menu.refresh();
    const row = () =>
      screen()
        .split("\n")
        .find((line) => line.includes("enabled"))
        ?.trim()
        .replace(/\s+/g, " ");
    goTo("enabled");
    const seen = [row()];
    for (let step = 0; step < 3; step++) {
      press(keys.enter);
      await menu.settled();
      seen.push(row());
    }
    expect(seen).toEqual([
      "→ enabled inherit (on · project)",
      "→ enabled on",
      "→ enabled off",
      "→ enabled inherit (on · project)",
    ]);
  });

  it("shows when a higher-precedence scope overrides the edited value", async () => {
    const { goTo, press, authored, screen, menu } = createMenu();
    authored.global.enabled = true;
    authored.session.enabled = false;
    menu.refresh();
    goTo("Scope");
    press(keys.enter, keys.enter);
    expect(screen()).toMatch(/enabled\s+on \(overridden: off · session\)/);
  });

  it("cycles thinking level from inherit through every level", async () => {
    const { goTo, press, applied, menu } = createMenu();
    goTo("thinkingLevel");
    for (let step = 0; step < 8; step++) {
      press(keys.enter);
      await menu.settled();
    }
    expect(applied.map(({ change }) => change)).toEqual([
      ...["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((thinkingLevel) => ({
        action: "set",
        key: "thinkingLevel",
        patch: { thinkingLevel },
      })),
      { action: "inherit", key: "thinkingLevel" },
    ]);
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

  it("keeps an open submenu when the Advisor pauses, then offers Resume", async () => {
    const { goTo, press, type, applied, state, menu, screen, settle } = createMenu();
    goTo("maxToolCalls");
    press(keys.enter);
    state.paused = true;
    menu.refresh();
    expect(screen()).toContain("a number, or inherit");
    type("5");
    press(keys.enter);
    await settle();
    expect(applied.map(({ change }) => change)).toEqual([
      { action: "set", key: "maxToolCalls", patch: { maxToolCalls: 5 } },
    ]);
    expect(screen()).toContain("Resume");
  });

  it("applies quick successive tool toggles in order, each on the previous result", async () => {
    const { goTo, press, applied, host, screen } = createMenu();
    const apply = host.apply.bind(host);
    host.apply = async (scope, change) => {
      // A real write resolves later; the second toggle must not read stale settings.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await apply(scope, change);
    };
    goTo("allowedTools");
    press(keys.enter);
    const toRow = (name: string) => {
      for (let step = 0; step < 10; step++) {
        if (
          screen()
            .split("\n")
            .some((line) => new RegExp(`→\\s*${name}\\b`).test(line))
        )
          return;
        press(keys.down);
      }
    };
    toRow("find");
    press(keys.enter);
    toRow("lsp_diagnostics");
    press(keys.enter);
    await vi.waitFor(() => expect(applied).toHaveLength(2));
    expect(applied.map(({ change }) => change)).toEqual([
      { action: "set", key: "allowedTools", patch: { allowedTools: ["read", "grep", "find"] } },
      {
        action: "set",
        key: "allowedTools",
        patch: { allowedTools: ["read", "grep", "find", "lsp_diagnostics"] },
      },
    ]);
  });

  it("keeps the prompt editor open with an inline error for an empty prompt", async () => {
    const { goTo, press, applied, screen, settle } = createMenu();
    goTo("prompt");
    press(keys.enter, keys.enter);
    for (let index = 0; index < "Default review prompt.".length; index++) press(keys.backspace);
    press(keys.enter);
    await settle();
    expect(applied).toEqual([]);
    expect(screen()).toContain("Advisor Prompt");
    expect(screen()).toMatch(/✖ .*prompt/i);
  });

  it("settles only after every started edit has been applied", async () => {
    const release = Promise.withResolvers<void>();
    const { goTo, press, applied, host, menu } = createMenu();
    const apply = host.apply.bind(host);
    host.apply = async (scope, change) => {
      await release.promise;
      await apply(scope, change);
    };
    goTo("enabled");
    press(keys.enter);
    let settled = false;
    void menu.settled().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release.resolve();
    await menu.settled();
    expect(applied).toHaveLength(1);
  });

  it("closes on Escape", () => {
    const { press, done } = createMenu();
    press(keys.escape);
    expect(done).toHaveBeenCalledOnce();
  });
});
