import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type OverlayHandle,
  type TUI,
} from "@earendil-works/pi-tui";
import { formatDuration } from "./exit-notification.js";
import type { TermctrlEntry, TermctrlRegistry } from "./termctrl-registry.js";

const REFRESH_MS = 1_000;
const MARGIN = 1;
/** Narrower than this, the owner and age columns are dropped. */
const WIDE_COLUMNS = 60;
const STATUS_KEY = "termctrl";

/** Starts the periodic refresh and returns its cancel function. Tests substitute fake timers. */
export type StartRefresh = (refresh: () => void) => () => void;

function startRefreshInterval(refresh: () => void): () => void {
  const interval = setInterval(refresh, REFRESH_MS);
  interval.unref?.();
  return () => clearInterval(interval);
}

function stateLabel(entry: TermctrlEntry): string {
  if (entry.state === "running") return "running";
  if (entry.exit?.signal !== null && entry.exit?.signal !== undefined) return entry.exit.signal;
  const code = entry.exit?.code;
  return code === null || code === undefined ? "exited" : `exit ${code}`;
}

function ageOf(entry: TermctrlEntry, now: number): string {
  return formatDuration((entry.exitedAt ?? now) - entry.startedAt);
}

function singleLine(text: string): string {
  return text.replaceAll(/\s+/gu, " ").trim();
}

/** The live `/ps` overlay: every entry in the process, a preview of the selected one, and stop keys. */
export class TermctrlPsPanel implements Component {
  private entries: readonly TermctrlEntry[] = [];
  private selectedId: string | undefined;
  private preview = "";
  private previewPending = false;
  private notice = "";
  private disposed = false;
  private readonly stopRefresh: () => void;

  constructor(
    private readonly registry: TermctrlRegistry,
    private readonly viewerOwner: string,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly onClose: () => void,
    startRefresh: StartRefresh = startRefreshInterval,
  ) {
    this.refresh();
    this.stopRefresh = startRefresh(() => {
      this.refresh();
      this.tui.requestRender();
    });
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.close();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up")) this.move(-1);
    else if (this.keybindings.matches(data, "tui.select.down")) this.move(1);
    else if (matchesKey(data, "k")) this.stopSelected();
    else if (matchesKey(data, "x")) this.removeSelected();
    else return;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const height = Math.max(
      1,
      Math.min(Math.floor(this.tui.terminal.rows * 0.9), this.tui.terminal.rows - 2 * MARGIN),
    );
    if (width < 8 || height < 6) {
      return [truncateToWidth("Esc close · Enlarge terminal", width, "…")];
    }
    const inner = width - 4;
    const now = Date.now();
    const running = this.entries.filter((entry) => entry.state === "running").length;
    const header = [
      this.theme.bold(`Terminals and Background jobs · ${running} running`),
      this.theme.fg("warning", this.notice),
    ];
    const help = [this.theme.fg("dim", "↑↓ select · k stop · x remove exited · esc close")];
    const listHeight = Math.max(
      1,
      Math.min(this.entries.length || 1, Math.floor((height - 6) / 2)),
    );
    const rows =
      this.entries.length === 0
        ? [this.theme.fg("muted", "Nothing is running.")]
        : this.visibleRows(listHeight).map((entry) => this.row(entry, inner, now));
    const previewHeight = Math.max(0, height - 2 - header.length - rows.length - help.length - 1);
    const previewLines = this.previewLines(previewHeight);
    const body = [
      ...header,
      ...rows,
      this.theme.fg("border", "─".repeat(inner)),
      ...previewLines,
      ...help,
    ];
    const border = (text: string) => this.theme.fg("border", text);
    const framed = body.map((line) => {
      const content = truncateToWidth(line, inner, "…");
      return `${border("│")} ${content}${" ".repeat(Math.max(0, inner - visibleWidth(content)))} ${border("│")}`;
    });
    return [border(`╭${"─".repeat(width - 2)}╮`), ...framed, border(`╰${"─".repeat(width - 2)}╯`)];
  }

  invalidate(): void {}

  /** Release the refresh timer exactly once. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopRefresh();
  }

  /** Close the overlay and release its timer. */
  close(): void {
    if (this.disposed) return;
    this.dispose();
    this.onClose();
  }

  private visibleRows(limit: number): readonly TermctrlEntry[] {
    const selected = Math.max(
      0,
      this.entries.findIndex((entry) => entry.id === this.selectedId),
    );
    const start = Math.min(
      Math.max(0, selected - limit + 1),
      Math.max(0, this.entries.length - limit),
    );
    return this.entries.slice(start, start + limit);
  }

  private row(entry: TermctrlEntry, width: number, now: number): string {
    const selected = entry.id === this.selectedId;
    const kind = entry.kind === "terminal" ? "term" : "job ";
    const owner = entry.owner === this.viewerOwner ? "root " : "child";
    const columns =
      width >= WIDE_COLUMNS
        ? [
            kind,
            entry.id.padEnd(4),
            owner,
            stateLabel(entry).padEnd(9),
            ageOf(entry, now).padStart(6),
          ]
        : [entry.id.padEnd(4), stateLabel(entry).padEnd(9)];
    const line = `${selected ? ">" : " "} ${columns.join("  ")}  ${singleLine(entry.command)}`;
    const styled = selected
      ? this.theme.fg("accent", line)
      : entry.state === "exited"
        ? this.theme.fg("muted", line)
        : line;
    return truncateToWidth(styled, width, "…");
  }

  private previewLines(height: number): string[] {
    if (height <= 0) return [];
    const selected = this.entries.find((entry) => entry.id === this.selectedId);
    if (selected === undefined) return [];
    const title = this.theme.fg(
      "dim",
      selected.kind === "terminal" ? `${selected.id} screen` : `${selected.id} log tail`,
    );
    const text = this.preview.replace(/\n+$/u, "");
    const lines = text === "" ? [this.theme.fg("muted", "(no output yet)")] : text.split("\n");
    return [title, ...lines.slice(-(height - 1))];
  }

  private refresh(): void {
    this.entries = this.registry.entries();
    if (!this.entries.some((entry) => entry.id === this.selectedId)) {
      this.selectedId = this.entries[0]?.id;
    }
    this.refreshPreview();
  }

  private refreshPreview(): void {
    const entry = this.entries.find((candidate) => candidate.id === this.selectedId);
    if (entry === undefined) {
      this.preview = "";
      return;
    }
    if (entry.kind === "job") {
      this.preview = entry.child.tail();
      return;
    }
    if (entry.state === "exited") {
      this.preview = entry.finalScreen ?? entry.lastScreen ?? "";
      return;
    }
    if (this.previewPending) return;
    this.previewPending = true;
    const id = entry.id;
    entry.handle.snapshot().then(
      (snapshot) => {
        this.previewPending = false;
        if (this.disposed || this.selectedId !== id) return;
        this.preview = snapshot.screen;
        this.tui.requestRender();
      },
      () => {
        this.previewPending = false;
      },
    );
  }

  private move(delta: number): void {
    if (this.entries.length === 0) return;
    const current = this.entries.findIndex((entry) => entry.id === this.selectedId);
    const next = Math.max(0, Math.min(this.entries.length - 1, current + delta));
    this.selectedId = this.entries[next]?.id;
    this.preview = "";
    this.refreshPreview();
  }

  private stopSelected(): void {
    const entry = this.entries.find((candidate) => candidate.id === this.selectedId);
    if (entry === undefined || entry.state !== "running") return;
    this.notice = `Stopping ${entry.id}…`;
    void this.registry.stopByUser(entry.id).then(() => {
      if (this.disposed) return;
      this.notice = `Stopped ${entry.id}.`;
      this.refresh();
      this.tui.requestRender();
    });
  }

  private removeSelected(): void {
    const entry = this.entries.find((candidate) => candidate.id === this.selectedId);
    if (entry === undefined) return;
    if (entry.state === "running") {
      this.notice = `${entry.id} is running; press k to stop it first.`;
      return;
    }
    void this.registry.remove(entry.id).then(() => {
      if (this.disposed) return;
      this.notice = `Removed ${entry.id}.`;
      this.refresh();
      this.tui.requestRender();
    });
  }
}

/** Opens one `/ps` overlay per session and keeps the footer's running count. */
export class TermctrlPsController {
  private panel: TermctrlPsPanel | undefined;
  private pending: Promise<void> | undefined;
  private handle: OverlayHandle | undefined;
  private readonly stopFooter: () => void;

  constructor(
    private readonly registry: TermctrlRegistry,
    private readonly context: ExtensionContext,
    private readonly startRefresh: StartRefresh = startRefreshInterval,
  ) {
    const update = () => {
      const running = registry.runningCount();
      context.ui.setStatus(STATUS_KEY, running > 0 ? `${running} running` : undefined);
    };
    this.stopFooter = context.hasUI ? registry.onChange(update) : () => {};
    if (context.hasUI) update();
  }

  /** Open or focus the overlay. RPC receives a one-line summary; other modes stay silent. */
  open(): Promise<void> {
    if (this.pending !== undefined) {
      this.handle?.focus();
      return this.pending;
    }
    if (this.context.mode === "rpc") {
      const entries = this.registry.entries();
      const summary =
        entries.length === 0
          ? "Nothing is running."
          : entries
              .map((entry) => `${entry.id} ${stateLabel(entry)} ${singleLine(entry.command)}`)
              .join("\n");
      this.context.ui.notify(summary, "info");
      return Promise.resolve();
    }
    if (this.context.mode !== "tui") return Promise.resolve();
    const viewer = this.context.sessionManager.getSessionId();
    this.pending = this.context.ui
      .custom<void>(
        (tui, theme, keybindings, done) => {
          this.panel = new TermctrlPsPanel(
            this.registry,
            viewer,
            tui,
            theme,
            keybindings,
            () => done(undefined),
            this.startRefresh,
          );
          return this.panel;
        },
        {
          overlay: true,
          overlayOptions: { anchor: "center", width: "90%", maxHeight: "90%", margin: MARGIN },
          onHandle: (handle) => {
            this.handle = handle;
          },
        },
      )
      .catch(() => {
        this.context.ui.notify("The /ps view failed.", "error");
      })
      .finally(() => {
        this.panel?.dispose();
        this.panel = undefined;
        this.pending = undefined;
        this.handle = undefined;
      });
    return this.pending;
  }

  /** Close the overlay and stop updating the footer. Called on every shutdown, including reload. */
  dispose(clearFooter: boolean): void {
    this.panel?.close();
    this.panel = undefined;
    this.stopFooter();
    if (clearFooter && this.context.hasUI) this.context.ui.setStatus(STATUS_KEY, undefined);
  }
}
