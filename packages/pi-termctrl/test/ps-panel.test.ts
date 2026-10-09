import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager as TuiKeybindings,
  setKeybindings,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  escapeTaggedTheme,
  expectLinesFitWidth,
  readableTags,
  taggedTheme,
} from "@ian-pascoe/pi-utils/ui-testing";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { TermctrlPsController, TermctrlPsPanel } from "../src/ps-panel.js";
import { TermctrlRegistry } from "../src/termctrl-registry.js";
import { FakeDriverFactory } from "./fake-driver.js";

const viewport = { cols: 80, rows: 24 };

function jobChild(id: string, output: string, onStop: () => void) {
  return {
    logPath: `/tmp/${id}.log`,
    stop: onStop,
    tail: () => output,
    removeLog: vi.fn(async () => {}),
  };
}

async function populatedRegistry() {
  const drivers = new FakeDriverFactory();
  drivers.onLaunch = (terminal) => {
    terminal.screen = ">>> 1 + 1\n2\n>>> ";
  };
  const registry = TermctrlRegistry.acquire({
    createDriver: drivers.create,
    pollIntervalMs: 60_000,
  });
  await registry.startTerminal("root", {
    command: ["/bin/sh", "-c", "python3"],
    displayCommand: "python3",
    cwd: "/tmp",
    viewport,
    notify: true,
  });
  const job = jobChild("b1", "compiling\nlinking\n", () =>
    queueMicrotask(() => registry.jobExited("b1", { code: null, signal: "SIGKILL" })),
  );
  registry.createJob("child-session", "npm run build", () => job);
  return { drivers, registry, job };
}

function panelFixture(registry: TermctrlRegistry, rows = 30) {
  const tui = {
    terminal: { rows, columns: 120 } satisfies Pick<TUI["terminal"], "rows" | "columns">,
    requestRender: vi.fn<TUI["requestRender"]>(),
  };
  const bindings = new Map([
    ["up", "tui.select.up"],
    ["down", "tui.select.down"],
    ["escape", "tui.select.cancel"],
  ]);
  const keybindings = {
    matches: (data, binding) => bindings.get(data) === binding,
  } satisfies Pick<KeybindingsManager, "matches">;
  const onClose = vi.fn();
  const stopRefresh = vi.fn();
  let refresh: (() => void) | undefined;
  const panel = new TermctrlPsPanel(
    registry,
    "root",
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: The panel uses only checked terminal rows and the typed requestRender mock.
    tui as unknown as TUI,
    // SAFETY: The panel renders only through the fg and bold methods the escape-tagged theme provides.
    escapeTaggedTheme as Theme,
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: The panel reads only the checked input matcher.
    keybindings as unknown as KeybindingsManager,
    onClose,
    (callback) => {
      refresh = callback;
      return stopRefresh;
    },
  );
  return { panel, tui, onClose, stopRefresh, refresh: () => refresh?.() };
}

beforeAll(() => {
  setKeybindings(new TuiKeybindings({ "tui.select.cancel": { defaultKeys: "escape" } }));
});

/** Check the panel fits at 40 and 120 columns, as every rendered line must. */
function expectFits(panel: TermctrlPsPanel) {
  expectLinesFitWidth(panel.render(40), 40);
  expectLinesFitWidth(panel.render(120), 120);
}

/** The panel's lines at a real width, with theme tokens decoded to readable tags. */
function view(panel: TermctrlPsPanel, width: number): string[] {
  return panel.render(width).map((line) => readableTags(line).trimEnd());
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

afterEach(async () => {
  await TermctrlRegistry.teardownForTests();
});

describe("TermctrlPsPanel", () => {
  test("shows an empty state", () => {
    const registry = TermctrlRegistry.acquire({ createDriver: new FakeDriverFactory().create });
    const { panel } = panelFixture(registry);
    expectFits(panel);
    const lines = view(panel, 120);
    const text = lines.join("\n");
    expect(text).toContain(
      "<accent><b>Terminals and Background jobs</b></accent><dim> · </dim><muted>0 running</muted>",
    );
    expect(text).toContain("<muted>Nothing is running.</muted>");
    expect(text).toContain(
      "<dim>↑↓</dim><muted> navigate</muted>  <dim>k</dim><muted> stop</muted>  <dim>x</dim><muted> remove exited</muted>  <dim>escape</dim><muted> close</muted>",
    );
  });

  test("is framed by Pi's selector borders, not a drawn box", () => {
    const registry = TermctrlRegistry.acquire({ createDriver: new FakeDriverFactory().create });
    const { panel } = panelFixture(registry);
    const lines = view(panel, 30);
    const border = `<border>${"─".repeat(30)}</border>`;
    expect(lines[0]).toBe(border);
    expect(lines.at(-1)).toBe(border);
    expect(lines.join("")).not.toMatch(/[╭╮╰╯│]/u);
  });

  test("renders every entry with kind, owner, state and age, and previews the Terminal screen", async () => {
    const { registry } = await populatedRegistry();
    const { panel } = panelFixture(registry);
    await flush();
    expectFits(panel);
    const lines = view(panel, 120);
    const text = lines.join("\n");
    expect(text).toMatch(
      /<accent>→ <\/accent><accent>●<\/accent> <accent>term {2}t1 {4}root {3}running {2}\s+\d+ms {2}python3<\/accent>/u,
    );
    expect(text).toMatch(
      /  <accent>●<\/accent> <text>job {3}b1 {4}child {2}running {2}\s+\d+ms {2}npm run build<\/text>/u,
    );
    expect(text).toContain("<dim>t1 screen</dim>");
    expect(text).toContain("<text>>>> 1 + 1</text>");
    expect(text).toContain("<text>2</text>");
  });

  test("drops the owner and age columns at narrow widths and stays within the width", async () => {
    const { registry } = await populatedRegistry();
    const { panel } = panelFixture(registry);
    const lines = view(panel, 40);
    expectFits(panel);
    const text = lines.join("\n");
    expect(text).toContain("t1    running    python3");
    expect(text).not.toContain("root");
  });

  test("previews a Background job's log tail after moving the selection", async () => {
    const { registry } = await populatedRegistry();
    const { panel, tui } = panelFixture(registry);
    panel.handleInput("down");
    expect(tui.requestRender).toHaveBeenCalled();
    const text = view(panel, 100).join("\n");
    expect(text).toContain("<accent>→ </accent>");
    expect(text).toMatch(/<accent>job {3}b1/u);
    expect(text).toContain("<dim>b1 log tail</dim>");
    expect(text).toContain("compiling");
    expect(text).toContain("linking");
  });

  test("k stops the selected entry and x removes it once exited", async () => {
    const { registry, job } = await populatedRegistry();
    const { panel } = panelFixture(registry);
    panel.handleInput("down");
    panel.handleInput("x");
    expect(view(panel, 100).join("\n")).toContain(
      "<warning>b1 is running; press k to stop it first.</warning>",
    );

    panel.handleInput("k");
    await vi.waitFor(() => expect(registry.get("b1")?.state).toBe("exited"));
    await flush();
    expect(view(panel, 100).join("\n")).toContain("<warning>Stopped b1.</warning>");
    // An entry a signal ended carries the stopped mark, shown by the selected row.
    expect(view(panel, 100).join("\n")).toMatch(
      /<muted>■<\/muted> <accent>job {3}b1 {4}child {2}SIGKILL/u,
    );

    panel.handleInput("x");
    await vi.waitFor(() => expect(registry.get("b1")).toBeUndefined());
    expect(job.removeLog).toHaveBeenCalledOnce();
    await flush();
    expect(view(panel, 100).join("\n")).toContain("Removed b1.");
  });

  test("esc closes the panel and clears its refresh timer once", async () => {
    const { registry } = await populatedRegistry();
    const { panel, onClose, stopRefresh } = panelFixture(registry);
    panel.handleInput("escape");
    panel.close();
    panel.dispose();
    expect(onClose).toHaveBeenCalledOnce();
    expect(stopRefresh).toHaveBeenCalledOnce();
  });

  test("the refresh timer picks up new entries", async () => {
    const registry = TermctrlRegistry.acquire({ createDriver: new FakeDriverFactory().create });
    const { panel, refresh, tui } = panelFixture(registry);
    registry.createJob("root", "sleep 5", (id) => jobChild(id, "", () => {}));
    refresh();
    expect(tui.requestRender).toHaveBeenCalled();
    expect(view(panel, 80).join("\n")).toContain("b1");
  });
});

describe("TermctrlPsController", () => {
  function controllerContext(mode: "tui" | "rpc") {
    const setStatus = vi.fn<ExtensionContext["ui"]["setStatus"]>();
    const notify = vi.fn<ExtensionContext["ui"]["notify"]>();
    const custom = vi.fn<ExtensionContext["ui"]["custom"]>();
    const context = {
      mode,
      hasUI: true,
      ui: { setStatus, notify, custom, theme: taggedTheme },
      sessionManager: { getSessionId: () => "root" },
    };
    return {
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: The controller reads only mode, hasUI, these three UI methods and the session id.
      context: context as unknown as ExtensionContext,
      setStatus,
      notify,
      custom,
    };
  }

  test("keeps the footer count, and clears it on shutdown but not on reload", async () => {
    const { registry } = await populatedRegistry();
    const { context, setStatus } = controllerContext("tui");
    const controller = new TermctrlPsController(registry, context);
    expect(setStatus).toHaveBeenLastCalledWith(
      "termctrl",
      "<accent>●</accent> <dim>termctrl</dim> 2 running",
    );
    registry.jobExited("b1", { code: 0, signal: null });
    expect(setStatus).toHaveBeenLastCalledWith(
      "termctrl",
      "<accent>●</accent> <dim>termctrl</dim> 1 running",
    );

    controller.dispose(false);
    setStatus.mockClear();
    registry.terminalExited("t1", { code: 0, signal: null }, "", true, null);
    expect(setStatus).not.toHaveBeenCalled();

    const second = new TermctrlPsController(registry, context);
    expect(setStatus).toHaveBeenLastCalledWith("termctrl", undefined);
    second.dispose(true);
    expect(setStatus).toHaveBeenLastCalledWith("termctrl", undefined);
  });

  test("opens one overlay and disposes its panel and timer on reload", async () => {
    const { registry } = await populatedRegistry();
    const { context, custom } = controllerContext("tui");
    custom.mockImplementation(
      (factory) =>
        new Promise((resolve) => {
          const tui = { terminal: { rows: 30, columns: 100 }, requestRender: vi.fn() };
          const theme = {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          };
          const keybindings = { matches: () => false };
          void factory(
            // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: The panel uses only checked terminal rows and requestRender.
            tui as unknown as TUI,
            // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: The panel renders only through fg and bold.
            theme as unknown as Theme,
            // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: The panel reads only the input matcher.
            keybindings as unknown as KeybindingsManager,
            resolve,
          );
        }),
    );
    const stopRefresh = vi.fn();
    const controller = new TermctrlPsController(registry, context, () => stopRefresh);
    const opened = controller.open();
    expect(controller.open()).toBe(opened);
    expect(custom).toHaveBeenCalledOnce();
    expect(custom.mock.calls[0]?.[1]).toMatchObject({
      overlay: true,
      overlayOptions: { anchor: "center", width: "90%", maxHeight: "90%", margin: 1 },
    });
    expect(stopRefresh).not.toHaveBeenCalled();
    controller.dispose(false);
    await opened;
    expect(stopRefresh).toHaveBeenCalledOnce();
  });

  test("RPC gets a summary notification instead of an overlay", async () => {
    const { registry } = await populatedRegistry();
    const { context, notify, custom } = controllerContext("rpc");
    await new TermctrlPsController(registry, context).open();
    expect(custom).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("t1 running python3\nb1 running npm run build", "info");
  });
});
