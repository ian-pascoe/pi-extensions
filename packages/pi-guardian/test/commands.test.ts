import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  initTheme,
  type ExtensionUIContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { expectLinesFitWidth } from "@ian-pascoe/pi-utils/ui-testing";
import {
  assessment,
  confirmedRejection,
  createGuardianHarness,
  reply,
  toolCalls,
} from "./fixtures/guardian-harness.js";
import { createMenuTui, keys, menuDriver } from "./fixtures/menu-ui.js";

beforeAll(() => initTheme("dark"));

interface ShownMenu {
  component: Component | undefined;
  theme: Theme | undefined;
}

/** A TUI host whose `custom` shows the component to the test instead of a terminal. */
function menuUi() {
  const { tui, keybindings } = createMenuTui();
  const shown: ShownMenu = { component: undefined, theme: undefined };
  const ui: Partial<ExtensionUIContext> = {
    custom<T>(
      factory: (
        tui: TUI,
        theme: Theme,
        keybindings: KeybindingsManager,
        done: (result: T) => void,
      ) => Component | Promise<Component>,
    ): Promise<T> {
      return new Promise<T>((resolve) => {
        const finish = (result: T) => {
          shown.component = undefined;
          resolve(result);
        };
        if (!shown.theme) throw new Error("Expected the bound UI theme");
        void Promise.resolve(factory(tui, shown.theme, keybindings, finish)).then((component) => {
          shown.component = component;
        });
      });
    },
  };
  return { ui, shown, ...menuDriver(() => shown.component) };
}

describe("/guardian command", () => {
  it("records status with effective settings, sources, and review totals", async () => {
    const harness = await createGuardianHarness({
      guardianSettings: { model: "guardian-test/reviewer" },
    });
    harness.responses.push(
      toolCalls(["deploy", { target: "a" }, "call-1"]),
      toolCalls(["deploy", { target: "b" }, "call-2"]),
      reply("Ok."),
    );
    harness.guardianReplies.push(
      assessment("low", "high", "Requested."),
      ...confirmedRejection("critical", "unknown", "Not requested."),
    );
    await harness.session.prompt("Deploy a.");
    await harness.session.prompt("/guardian status");
    const status = harness.entries("pi-guardian-status").at(-1);
    expect(status).toMatchObject({
      state: "enabled",
      followsRoot: null,
      settings: { enabled: true, model: "guardian-test/reviewer", thinkingLevel: "low" },
      sources: { model: "global", enabled: "global" },
      // The Rejection's Escalation Pass adds its cost to the same review.
      totals: {
        reviews: 2,
        allowed: 1,
        rejected: 1,
        failed: 0,
        overrides: 0,
        escalated: 1,
        escalatedBy: { rejected: 1 },
        cost: 0.0033,
      },
      error: null,
    });
  });

  it("changes one Tool Policy entry at the session scope", async () => {
    const harness = await createGuardianHarness({
      guardianSettings: { model: "guardian-test/reviewer", tools: { lookup: "review" } },
    });
    await harness.session.prompt("/guardian tool deploy deny");
    expect(harness.entries("pi-guardian-settings").at(-1)).toEqual({
      version: 1,
      overrides: { tools: { deploy: "deny" } },
    });
    await harness.session.prompt("/guardian tool lookup default");
    harness.responses.push(
      toolCalls(["deploy", { target: "a" }, "call-1"], ["lookup", { query: "q" }, "call-2"]),
      reply("Ok."),
    );
    await harness.session.prompt("Go.");
    // deploy is denied; lookup's global entry was reset to its annotation (read-only: allowed).
    expect(harness.executed).toEqual(["lookup:q"]);
    expect(harness.reviews).toHaveLength(0);
    expect(harness.entries("pi-guardian-status").at(-1)).toMatchObject({
      changes: [
        { scope: "session", key: "tools", options: { tools: { deploy: "deny", lookup: null } } },
      ],
      settings: { tools: { deploy: "deny" } },
    });
    await harness.session.prompt("/guardian tool deploy inherit");
    await harness.session.prompt("/guardian tool lookup inherit");
    expect(harness.entries("pi-guardian-settings").at(-1)).toEqual({ version: 1, overrides: {} });
  });

  it("reports invalid commands in the status entry", async () => {
    const harness = await createGuardianHarness();
    await harness.session.prompt('/guardian set onDeny "sometimes"');
    expect(harness.entries("pi-guardian-status").at(-1)).toMatchObject({
      error: expect.stringMatching(/Invalid session Guardian settings/),
    });
  });
});

describe("/guardian settings menu", () => {
  it("cycles a setting at the selected scope and records one status entry on close", async () => {
    const host = menuUi();
    const harness = await createGuardianHarness({ ui: host.ui, mode: "tui" });
    host.shown.theme = harness.session.extensionRunner?.getUIContext().theme;
    const command = harness.session.prompt("/guardian");
    await vi.waitFor(() => expect(host.shown.component).toBeDefined());
    expect(host.screen()).toContain("Guardian settings");
    expect(host.screen()).toContain("Scope");
    for (const width of [40, 120]) {
      expectLinesFitWidth(host.shown.component?.render(width) ?? [], width, {
        piThemedBody: true,
      });
    }
    host.goTo("onDeny");
    host.press(keys.enter);
    await vi.waitFor(() =>
      expect(harness.entries("pi-guardian-settings").at(-1)).toEqual({
        version: 1,
        overrides: { onDeny: "block" },
      }),
    );
    host.press(keys.escape);
    await command;
    expect(harness.entries("pi-guardian-status")).toMatchObject([
      { changes: [{ scope: "session", key: "onDeny", options: { onDeny: "block" } }] },
    ]);
  });

  it("picks a classifier model for the First Pass", async () => {
    const host = menuUi();
    const harness = await createGuardianHarness({ ui: host.ui, mode: "tui" });
    host.shown.theme = harness.session.extensionRunner?.getUIContext().theme;
    const command = harness.session.prompt("/guardian");
    await vi.waitFor(() => expect(host.shown.component).toBeDefined());
    host.goTo("classifierModel");
    host.press(keys.enter);
    // Only classifier models are offered, after inherit and off.
    expect(host.screen()).toContain("guardian-test/judge");
    expect(host.screen()).not.toContain("guardian-test/reviewer");
    host.type("tiny-judge");
    host.press(keys.enter);
    await vi.waitFor(() =>
      expect(harness.entries("pi-guardian-settings").at(-1)).toEqual({
        version: 1,
        overrides: { classifierModel: "guardian-test/tiny-judge" },
      }),
    );
    host.press(keys.escape);
    await command;
  });
});
