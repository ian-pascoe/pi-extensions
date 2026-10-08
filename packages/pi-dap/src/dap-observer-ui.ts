import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import {
  joinInline,
  noticeText,
  SEPARATOR,
  statusMark,
  widgetLines,
  type StatusKind,
} from "@ian-pascoe/pi-utils/ui";
import type { DapSessionResult, DapSessionSnapshot } from "./dap-session.js";
import type { DapToolParameters } from "./dap-tool-contract.js";
import { workspaceRelativeDapPath } from "./dap-tool-rendering.js";
import type { DapToolObserver } from "./dap-tool.js";

const DAP_OBSERVER_UI_KEY = "pi-dap";
const DAP_OBSERVER_REFRESH_MS = 1_000;
const DAP_OBSERVER_TERMINAL_COOLDOWN_MS = 10_000;

/** Theme operations used by the one-line Pi DAP Observer widget. */
export type DapObserverWidgetTheme = Pick<Theme, "bold" | "fg">;

/** Projected values rendered by the non-authoritative Observer widget. */
export interface DapObserverWidgetView {
  /** Current observed lifecycle state; idle has no widget view. */
  readonly state: "launching" | "running" | "stopped" | "terminated";
  readonly adapterId?: string;
  readonly profileId?: string;
  readonly stopReason?: string;
  /** Current stopped Stack Frame location, falling back to the explicitly launched program. */
  readonly path?: string;
  /** Milliseconds since launch, frozen when termination is observed. */
  readonly elapsedMs?: number;
  readonly exitCode?: number;
}

/** Narrow Pi context needed to mount and notify the Observer UI. */
export interface DapObserverUiContext {
  readonly mode: "tui" | "rpc" | "json" | "print";
  readonly cwd: string;
  readonly ui: Pick<ExtensionUIContext, "notify" | "setWidget">;
}

/** The Status Mark for a Debug Session state: a clean exit is done, a non-zero exit failed. */
function dapObserverMark(view: DapObserverWidgetView): StatusKind {
  switch (view.state) {
    case "launching":
    case "running":
      return "active";
    case "stopped":
      return "stopped";
    case "terminated":
      return view.exitCode === undefined || view.exitCode === 0 ? "done" : "failed";
  }
}

function dapObserverReason(view: DapObserverWidgetView): string | undefined {
  if (view.state === "stopped") return view.stopReason;
  if (view.state === "terminated" && view.exitCode !== undefined) return `exit ${view.exitCode}`;
  return undefined;
}

function formatDapObserverDuration(elapsedMs: number | undefined): string | undefined {
  if (elapsedMs === undefined) return undefined;
  const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** The widget header's muted counts, richest first: profile and duration, profile, none. */
function dapObserverCountOptions(view: DapObserverWidgetView): string[] {
  const profile =
    view.adapterId === undefined && view.profileId === undefined
      ? undefined
      : `${view.adapterId ?? "?"}/${view.profileId ?? "?"}`;
  const duration = formatDapObserverDuration(view.elapsedMs);
  const options = [[profile, duration], [profile], []].map((parts) =>
    parts.filter((part) => part !== undefined).join(SEPARATOR),
  );
  return [...new Set(options)];
}

/** The widget row's text, richest first: reason and path, reason, state alone. */
function dapObserverRowOptions(
  view: DapObserverWidgetView,
  theme: DapObserverWidgetTheme,
): string[] {
  const state = `${statusMark(theme, dapObserverMark(view))} ${view.state}`;
  const reasonText = dapObserverReason(view);
  const reason = reasonText === undefined ? undefined : theme.fg("dim", reasonText);
  const path = view.path === undefined ? undefined : theme.fg("muted", view.path);
  return [joinInline(theme, [state, reason, path]), joinInline(theme, [state, reason]), state];
}

/**
 * Render the Observer widget in the shared layout. Detail drops right to left as the terminal
 * narrows (duration, path, profile, reason) and every line stays within the width.
 */
export function renderDapObserverWidgetLines(
  view: DapObserverWidgetView,
  width: number,
  theme: DapObserverWidgetTheme,
): string[] {
  if (width <= 0) return [];
  const layouts = dapObserverCountOptions(view).map((counts) =>
    widgetLines(
      theme,
      counts === "" ? { title: "DAP", rows: [] } : { title: "DAP", counts, rows: [] },
    ),
  );
  const header = layouts.find(
    (lines) => (lines[0] ?? "") !== "" && visibleWidth(lines[0] ?? "") <= width,
  );
  const rows = dapObserverRowOptions(view, theme);
  const row = rows.find((candidate) => visibleWidth(candidate) <= width);
  return [
    header?.[0] ?? truncateToWidth(layouts.at(-1)?.[0] ?? "", width, "..."),
    row ?? truncateToWidth(rows.at(-1) ?? "", width, "..."),
  ];
}

class DapObserverWidgetComponent implements Component {
  constructor(
    private view: DapObserverWidgetView,
    private readonly tui: TUI,
    private readonly theme: DapObserverWidgetTheme,
  ) {}

  update(view: DapObserverWidgetView): void {
    this.view = view;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    return renderDapObserverWidgetLines(this.view, width, this.theme);
  }

  invalidate(): void {}
}

/** Own one TUI-only Observer snapshot, widget, refresh interval, cooldown, and cleanup. */
export class DapObserverUiController implements DapToolObserver {
  private activeToolCalls = 0;
  private disposed = false;
  private launchStartedAt: number | undefined;
  private terminalElapsedMs: number | undefined;
  private launchedProgram: string | undefined;
  private sourceLocation: string | undefined;
  private snapshot: DapSessionSnapshot = { state: "idle" };
  private currentView: DapObserverWidgetView | undefined;
  private widgetComponent: DapObserverWidgetComponent | undefined;
  private widgetMounted = false;
  private refreshInterval: ReturnType<typeof setInterval> | undefined;
  private cooldownTimeout: ReturnType<typeof setTimeout> | undefined;

  /** Construct an inert Observer UI; the first launch tool call mounts its widget. */
  constructor(private readonly context: DapObserverUiContext) {}

  /** Record tool activity without dispatching any Debug Adapter operation. */
  onToolStart(parameters: DapToolParameters): void {
    if (this.disposed) return;
    this.activeToolCalls++;
    if (parameters.operation !== "launch") return;
    this.clearCooldown();
    this.launchStartedAt = Date.now();
    this.terminalElapsedMs = undefined;
    this.launchedProgram =
      parameters.program === undefined
        ? undefined
        : workspaceRelativeDapPath(this.context.cwd, parameters.program);
    this.sourceLocation = undefined;
    this.snapshot = { state: "launching", adapterId: "?", profileId: parameters.profile ?? "?" };
    this.ensureRefreshInterval();
    this.refreshWidget();
  }

  /** Learn source location only from a successful result already returned by the tool. */
  onToolSuccess(_parameters: DapToolParameters, result: DapSessionResult): void {
    if (this.disposed) return;
    this.activeToolCalls = Math.max(0, this.activeToolCalls - 1);
    if (this.snapshot.state === "stopped") {
      const frame = result.stop?.topFrame ?? result.stackFrames?.[0];
      const source = frame?.source?.path ?? frame?.source?.name;
      if (frame !== undefined && source !== undefined) {
        this.sourceLocation = `${workspaceRelativeDapPath(this.context.cwd, source)}:${frame.line}`;
      }
    }
    this.refreshWidget();
  }

  /** Complete failed tool activity while leaving model-facing failure behavior unchanged. */
  onToolFailure(parameters: DapToolParameters, _error: Error): void {
    if (this.disposed) return;
    this.activeToolCalls = Math.max(0, this.activeToolCalls - 1);
    if (parameters.operation === "launch" && this.snapshot.state === "launching") {
      this.snapshot = { state: "idle" };
      this.clearRefreshInterval();
      this.hideWidget();
    }
  }

  /** Project one actual Debug Session lifecycle transition into the Observer snapshot. */
  onSessionSnapshot(snapshot: DapSessionSnapshot): void {
    if (this.disposed) return;
    if (snapshot.state !== "stopped" || this.snapshot.state !== "stopped") {
      this.sourceLocation = undefined;
    }
    this.snapshot = snapshot;
    if (snapshot.state === "idle") {
      this.clearRefreshInterval();
      this.clearCooldown();
      this.hideWidget();
      return;
    }
    if (snapshot.state === "terminated") {
      this.terminalElapsedMs =
        this.launchStartedAt === undefined ? undefined : Date.now() - this.launchStartedAt;
      this.clearRefreshInterval();
      this.refreshWidget();
      this.ensureCooldown();
      return;
    }
    this.clearCooldown();
    this.ensureRefreshInterval();
    this.refreshWidget();
  }

  /** Notify only an actionable asynchronous failure not represented by an active tool result. */
  onUnexpectedFailure(error: Error): void {
    if (this.disposed || this.activeToolCalls > 0) return;
    this.context.ui.notify(noticeText("DAP", error.message.replace(/^Pi DAP:\s*/u, "")), "error");
  }

  /** Dispose timers and the widget immediately; repeated disposal is inert. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearRefreshInterval();
    this.clearCooldown();
    this.hideWidget();
  }

  private observerWidgetView(): DapObserverWidgetView | undefined {
    if (this.snapshot.state === "idle") return undefined;
    const elapsedMs =
      this.snapshot.state === "terminated"
        ? this.terminalElapsedMs
        : this.launchStartedAt === undefined
          ? undefined
          : Date.now() - this.launchStartedAt;
    const path = this.sourceLocation ?? this.launchedProgram;
    let view: DapObserverWidgetView = { state: this.snapshot.state };
    if ("adapterId" in this.snapshot) view = { ...view, adapterId: this.snapshot.adapterId };
    if ("profileId" in this.snapshot) view = { ...view, profileId: this.snapshot.profileId };
    if (this.snapshot.state === "stopped") {
      view = { ...view, stopReason: this.snapshot.stopReason };
    }
    if (this.snapshot.state === "terminated" && this.snapshot.exitCode !== undefined) {
      view = { ...view, exitCode: this.snapshot.exitCode };
    }
    if (path !== undefined) view = { ...view, path };
    if (elapsedMs !== undefined) view = { ...view, elapsedMs };
    return view;
  }

  private refreshWidget(): void {
    if (this.context.mode !== "tui") return;
    const view = this.observerWidgetView();
    this.currentView = view;
    if (view === undefined) {
      this.hideWidget();
      return;
    }
    if (this.widgetMounted) {
      this.widgetComponent?.update(view);
      return;
    }
    this.context.ui.setWidget(
      DAP_OBSERVER_UI_KEY,
      (tui, theme) => {
        this.widgetComponent = new DapObserverWidgetComponent(this.currentView ?? view, tui, theme);
        return this.widgetComponent;
      },
      { placement: "aboveEditor" },
    );
    this.widgetMounted = true;
  }

  private hideWidget(): void {
    if (this.context.mode !== "tui" || !this.widgetMounted) return;
    this.context.ui.setWidget(DAP_OBSERVER_UI_KEY, undefined);
    this.widgetMounted = false;
    this.widgetComponent = undefined;
  }

  private ensureRefreshInterval(): void {
    if (this.context.mode !== "tui" || this.refreshInterval !== undefined) return;
    this.refreshInterval = setInterval(() => this.refreshWidget(), DAP_OBSERVER_REFRESH_MS);
    this.refreshInterval.unref?.();
  }

  private clearRefreshInterval(): void {
    if (this.refreshInterval === undefined) return;
    clearInterval(this.refreshInterval);
    this.refreshInterval = undefined;
  }

  private ensureCooldown(): void {
    if (this.context.mode !== "tui") return;
    this.clearCooldown();
    this.cooldownTimeout = setTimeout(() => {
      this.cooldownTimeout = undefined;
      this.hideWidget();
    }, DAP_OBSERVER_TERMINAL_COOLDOWN_MS);
    this.cooldownTimeout.unref?.();
  }

  private clearCooldown(): void {
    if (this.cooldownTimeout === undefined) return;
    clearTimeout(this.cooldownTimeout);
    this.cooldownTimeout = undefined;
  }
}
