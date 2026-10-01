import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test, vi } from "vitest";
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
  const theme = {
    fg: (_color, text) => text,
    bold: (text) => text,
  } satisfies Pick<Theme, "fg" | "bold">;
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
    // SAFETY: The panel renders only through the checked fg and bold theme methods.
    theme as Theme,
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

const flush = () => new Promise((resolve) => setImmediate(resolve));

afterEach(async () => {
  await TermctrlRegistry.teardownForTests();
});

describe("TermctrlPsPanel", () => {
  test("shows an empty state", () => {
    const registry = TermctrlRegistry.acquire({ createDriver: new FakeDriverFactory().create });
    const { panel } = panelFixture(registry);
    const lines = panel.render(80);
    expect(lines.join("\n")).toContain("Terminals and Background jobs · 0 running");
    expect(lines.join("\n")).toContain("Nothing is running.");
    expect(lines.join("\n")).toContain("↑↓ select · k stop · x remove exited · esc close");
  });

  test("renders every entry with kind, owner, state and age, and previews the Terminal screen", async () => {
    const { registry } = await populatedRegistry();
    const { panel } = panelFixture(registry);
    await flush();
    const lines = panel.render(100);
    expect(lines.every((line) => visibleWidth(line) === 100)).toBe(true);
    const text = lines.join("\n");
    expect(text).toMatch(/> term {2}t1 {4}root {3}running {2}\s+\d+ms {2}python3/u);
    expect(text).toMatch(/ {3}job {3}b1 {4}child {2}running {2}\s+\d+ms {2}npm run build/u);
    expect(text).toContain("t1 screen");
    expect(text).toContain(">>> 1 + 1\n".split("\n")[0] ?? "");
    expect(text).toContain("│ 2 ");
  });

  test("drops the owner and age columns at narrow widths and stays within the width", async () => {
    const { registry } = await populatedRegistry();
    const { panel } = panelFixture(registry);
    const lines = panel.render(40);
    expect(lines.every((line) => visibleWidth(line) === 40)).toBe(true);
    const text = lines.join("\n");
    expect(text).toContain("> t1    running    python3");
    expect(text).not.toContain("root");
  });

  test("previews a Background job's log tail after moving the selection", async () => {
    const { registry } = await populatedRegistry();
    const { panel, tui } = panelFixture(registry);
    panel.handleInput("down");
    expect(tui.requestRender).toHaveBeenCalled();
    const text = panel.render(100).join("\n");
    expect(text).toContain("> job   b1");
    expect(text).toContain("b1 log tail");
    expect(text).toContain("compiling");
    expect(text).toContain("linking");
  });

  test("k stops the selected entry and x removes it once exited", async () => {
    const { registry, job } = await populatedRegistry();
    const { panel } = panelFixture(registry);
    panel.handleInput("down");
    panel.handleInput("x");
    expect(panel.render(100).join("\n")).toContain("b1 is running; press k to stop it first.");

    panel.handleInput("k");
    await vi.waitFor(() => expect(registry.get("b1")?.state).toBe("exited"));
    await flush();
    expect(panel.render(100).join("\n")).toContain("Stopped b1.");
    expect(panel.render(100).join("\n")).toMatch(/b1 {4}child {2}SIGKILL/u);

    panel.handleInput("x");
    await vi.waitFor(() => expect(registry.get("b1")).toBeUndefined());
    expect(job.removeLog).toHaveBeenCalledOnce();
    await flush();
    expect(panel.render(100).join("\n")).toContain("Removed b1.");
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
    expect(panel.render(80).join("\n")).toContain("b1");
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
      ui: { setStatus, notify, custom },
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
    expect(setStatus).toHaveBeenLastCalledWith("termctrl", "2 running");
    registry.jobExited("b1", { code: 0, signal: null });
    expect(setStatus).toHaveBeenLastCalledWith("termctrl", "1 running");

    controller.dispose(false);
    setStatus.mockClear();
    registry.terminalExited("t1", { code: 0, signal: null }, "", true);
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
