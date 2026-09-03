import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import type { CodeModeRuntime, CodeModeTimerHandle } from "./codemode-runtime.js";
import type {
  CodeModeObservedSession,
  CodeModeObserverSnapshot,
  CodeModeUnexpectedFailure,
} from "./codemode-session-coordinator.js";
import {
  boundedCodeModeElapsedMs,
  formatCodeModeDuration,
  shortestUniqueCodeModeSessionPrefix,
} from "./codemode-session-coordinator.js";

const CODEMODE_OBSERVER_UI_KEY = "codemode-observer";
const CODEMODE_OBSERVER_ROW_LIMIT = 8;
const CODEMODE_OBSERVER_TOOL_NAME_LIMIT = 3;
const CODEMODE_OBSERVER_TOOL_NAME_WIDTH = 32;
const CODEMODE_OBSERVER_REFRESH_MS = 1_000;
const CODEMODE_OBSERVER_COOLDOWN_MS = 10_000;
const CODEMODE_OBSERVER_SEPARATOR_TEXT = "  ·  ";
const CODEMODE_OBSERVER_COMPACT_SEPARATOR_TEXT = " · ";
const CODEMODE_OBSERVER_ELLIPSIS = "…";

/** Theme operations used by the read-only CodeMode Observer widget. */
export type CodeModeObserverWidgetTheme = Pick<Theme, "bold" | "fg">;

/** Explicit clock and timer capabilities owned by the CodeMode Observer UI controller. */
export type CodeModeObserverUiRuntime = Pick<
  CodeModeRuntime,
  "now" | "setTimeout" | "clearTimeout"
>;

type CodeModeObserverWidgetTui = Pick<TUI, "requestRender">;
type CodeModeObserverWidgetFactory = (
  tui: CodeModeObserverWidgetTui,
  theme: CodeModeObserverWidgetTheme,
) => Component;

/** Minimal TUI surface accepted structurally from one Pi ExtensionContext. */
export type CodeModeObserverUiContext = {
  readonly mode: ExtensionContext["mode"];
  readonly ui: {
    readonly notify: (message: string, level: "info" | "warning" | "error") => void;
    readonly setWidget: (
      key: string,
      widget: CodeModeObserverWidgetFactory | undefined,
      options?: { readonly placement: "aboveEditor" },
    ) => void;
  };
};

/** One responsive CodeMode Observer row with lifecycle-specific detail. */
export type CodeModeObserverRow = {
  /** Shortest unique Session prefix among currently visible Observer rows. */
  readonly sessionPrefix: string;
} & (
  | {
      readonly state: "running";
      /** One-based Cell Ordinal within the Session. */
      readonly cellOrdinal: number;
      /** Current Cell duration in parent wall-clock milliseconds. */
      readonly elapsedMs: number;
      /** At most three sanitized active registered-tool names. */
      readonly activeToolNames: readonly string[];
      /** Exact active nested-call count, including omitted names. */
      readonly activeToolCount: number;
    }
  /** Idle Session summary retained only during relevant Observer activity. */
  | { readonly state: "idle"; readonly cellCount: number }
  | {
      readonly state: "failed" | "cancelled" | "reclaimed" | "timed_out";
      /** Most recent one-based Cell Ordinal, or Session Cell count when no final Cell exists. */
      readonly cellOrdinal: number;
    }
);

/** Bounded read-only projection rendered by the CodeMode Observer widget. */
export type CodeModeObserverView = {
  /** Exact count of Sessions with a running Cell. */
  readonly runningCount: number;
  /** Exact non-terminal Session count represented by the current snapshot. */
  readonly liveCount: number;
  /** At most eight responsive Observer rows. */
  readonly rows: readonly CodeModeObserverRow[];
  /** Relevant Sessions omitted after the eight-row cap. */
  readonly overflowCount: number;
};

type CodeModeObserverState = CodeModeObserverRow["state"];
type CodeModeObserverStatePresentation = {
  readonly symbol: string;
  readonly label: string;
  readonly color: ThemeColor;
};

const CODEMODE_OBSERVER_STATE_PRESENTATION = {
  running: { symbol: "◉", label: "running", color: "accent" },
  idle: { symbol: "○", label: "idle", color: "muted" },
  failed: { symbol: "×", label: "failed", color: "error" },
  cancelled: { symbol: "■", label: "cancelled", color: "warning" },
  reclaimed: { symbol: "■", label: "reclaimed", color: "warning" },
  timed_out: { symbol: "!", label: "timed out", color: "error" },
} satisfies Record<CodeModeObserverState, CodeModeObserverStatePresentation>;

function sanitizeCodeModeObserverText(value: string): string {
  return (
    stripTerminalSequences(value)
      .replaceAll("\r\n", " ")
      .replaceAll("\r", " ")
      .replaceAll("\n", " ")
      .replaceAll("\t", " ")
      .replace(/\s+/g, " ")
      .trim()
      // oxlint-disable-next-line eslint/no-control-regex -- SAFETY: Observer text must remove terminal C0/C1 controls after preserving ordinary spacing above.
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
  );
}

function boundedCodeModeObserverText(value: string, width: number): string {
  return truncateToWidth(sanitizeCodeModeObserverText(value), width, CODEMODE_OBSERVER_ELLIPSIS);
}

function shortestUniqueCodeModeSessionPrefixes(
  sessions: readonly CodeModeObservedSession[],
): string[] {
  const identifiers = sessions.map((session) => {
    const safe = sanitizeCodeModeObserverText(session.sessionId);
    return safe.length === 0 ? "unknown" : safe;
  });
  return identifiers.map((identifier, index) =>
    shortestUniqueCodeModeSessionPrefix(
      identifier,
      identifiers.filter((_candidate, candidateIndex) => candidateIndex !== index),
    ),
  );
}

function codeModeTerminalObserverState(
  session: CodeModeObservedSession,
): Extract<CodeModeObserverState, "failed" | "cancelled" | "reclaimed" | "timed_out"> {
  if (session.terminal_error_code === "cancellation" || session.last_cell?.state === "cancelled") {
    return "cancelled";
  }
  if (session.terminal_error_code === "eviction") return "reclaimed";
  if (session.terminal_error_code === "timeout" || session.last_cell?.state === "timed_out") {
    return "timed_out";
  }
  return "failed";
}

function projectCodeModeObserverRow(
  session: CodeModeObservedSession,
  sessionPrefix: string,
  nowMs: number,
): CodeModeObserverRow {
  if (session.lifecycle === "running" && session.current_cell !== undefined) {
    const activeToolNames = [
      ...new Set(
        session.current_cell.active_tool_names
          .map((name) => boundedCodeModeObserverText(name, CODEMODE_OBSERVER_TOOL_NAME_WIDTH))
          .filter(Boolean),
      ),
    ].slice(0, CODEMODE_OBSERVER_TOOL_NAME_LIMIT);
    return {
      sessionPrefix,
      state: "running",
      cellOrdinal: session.current_cell.ordinal,
      elapsedMs: boundedCodeModeElapsedMs(session.current_cell.started_at_ms, nowMs),
      activeToolNames,
      activeToolCount: Math.max(session.current_cell.active_tool_count, activeToolNames.length),
    };
  }
  if (session.lifecycle === "idle") {
    return { sessionPrefix, state: "idle", cellCount: session.cell_count };
  }
  return {
    sessionPrefix,
    state: codeModeTerminalObserverState(session),
    cellOrdinal: session.last_cell?.ordinal ?? session.cell_count,
  };
}

/** Project immutable coordinator facts into the sorted, eight-row CodeMode Observer view. */
export function buildCodeModeObserverView(
  snapshot: CodeModeObserverSnapshot,
  nowMs: number,
): CodeModeObserverView {
  const visibleSessions = snapshot.sessions.filter(
    (session) =>
      session.lifecycle !== "terminal" ||
      nowMs - session.last_activity_at_ms < CODEMODE_OBSERVER_COOLDOWN_MS,
  );
  const prefixes = shortestUniqueCodeModeSessionPrefixes(visibleSessions);
  const candidates = visibleSessions
    .map((session, index) => ({
      session,
      sessionPrefix: prefixes[index] ?? "unknown",
      inputOrder: index,
    }))
    .sort(
      (left, right) =>
        Number(right.session.lifecycle === "running") -
          Number(left.session.lifecycle === "running") ||
        right.session.last_activity_at_ms - left.session.last_activity_at_ms ||
        left.inputOrder - right.inputOrder,
    );
  const rows = candidates
    .slice(0, CODEMODE_OBSERVER_ROW_LIMIT)
    .map(({ session, sessionPrefix }) => projectCodeModeObserverRow(session, sessionPrefix, nowMs));
  return {
    runningCount: visibleSessions.filter((session) => session.lifecycle === "running").length,
    liveCount: visibleSessions.filter((session) => session.lifecycle !== "terminal").length,
    rows,
    overflowCount: Math.max(0, candidates.length - rows.length),
  };
}

function formatCodeModeObserverToolActivity(
  row: Extract<CodeModeObserverRow, { state: "running" }>,
): string | undefined {
  if (row.activeToolCount === 0) return undefined;
  if (row.activeToolNames.length === 0) {
    return `${row.activeToolCount} tool${row.activeToolCount === 1 ? "" : "s"}`;
  }
  const omitted = Math.max(0, row.activeToolCount - row.activeToolNames.length);
  return `${row.activeToolNames.join(", ")}${omitted === 0 ? "" : ` +${omitted}`}`;
}

function codeModeObserverRowDetail(row: CodeModeObserverRow): string {
  return row.state === "idle"
    ? `${row.cellCount} Cell${row.cellCount === 1 ? "" : "s"}`
    : `Cell ${row.cellOrdinal}`;
}

function renderCodeModeObserverRow(
  row: CodeModeObserverRow,
  width: number,
  theme: CodeModeObserverWidgetTheme,
): string {
  const presentation = CODEMODE_OBSERVER_STATE_PRESENTATION[row.state];
  const identity = `  ${theme.fg(presentation.color, presentation.symbol)} ${theme.bold(row.sessionPrefix)}`;
  const status = theme.fg(presentation.color, presentation.label);
  const detail = theme.fg("muted", codeModeObserverRowDetail(row));
  const duration =
    row.state === "running" ? theme.fg("muted", formatCodeModeDuration(row.elapsedMs)) : undefined;
  const toolActivity =
    row.state === "running" ? formatCodeModeObserverToolActivity(row) : undefined;
  const themedToolActivity =
    toolActivity === undefined ? undefined : theme.fg("muted", toolActivity);
  const separator = theme.fg("dim", CODEMODE_OBSERVER_SEPARATOR_TEXT);
  const candidates = [
    [identity, status, detail, duration, themedToolActivity],
    [identity, status, detail, duration],
    [identity, status, detail],
    [identity, status],
  ].map((parts) => parts.filter((part): part is string => part !== undefined));
  for (const parts of candidates) {
    const line = parts.join(separator);
    if (visibleWidth(line) <= width) return line;
  }

  const compactSeparator = theme.fg("dim", CODEMODE_OBSERVER_COMPACT_SEPARATOR_TEXT);
  const compactIdentity = `${theme.fg(presentation.color, presentation.symbol)} ${theme.bold(row.sessionPrefix)}`;
  const compact = [compactIdentity, status].join(compactSeparator);
  if (visibleWidth(compact) <= width) return compact;
  return truncateToWidth(compact, width, CODEMODE_OBSERVER_ELLIPSIS);
}

/** Render ANSI-safe CodeMode Observer widget lines using right-to-left detail degradation. */
export function renderCodeModeObserverWidgetLines(
  view: CodeModeObserverView,
  width: number,
  theme: CodeModeObserverWidgetTheme,
): string[] {
  if (width <= 0) return [];
  const separator = theme.fg("dim", CODEMODE_OBSERVER_SEPARATOR_TEXT);
  const header = [
    theme.fg("toolTitle", theme.bold("CodeMode")),
    view.liveCount > 0 ? theme.fg("muted", `${view.liveCount} live`) : undefined,
    view.runningCount > 0 ? theme.fg("accent", `${view.runningCount} running`) : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(separator);
  const lines = [
    truncateToWidth(header, width, CODEMODE_OBSERVER_ELLIPSIS),
    ...view.rows.map((row) => renderCodeModeObserverRow(row, width, theme)),
  ];
  if (view.overflowCount > 0) {
    lines.push(
      truncateToWidth(
        theme.fg("dim", `  … +${view.overflowCount} more`),
        width,
        CODEMODE_OBSERVER_ELLIPSIS,
      ),
    );
  }
  return lines;
}

class CodeModeObserverWidgetComponent implements Component {
  constructor(
    private view: CodeModeObserverView,
    private readonly tui: CodeModeObserverWidgetTui,
    private readonly theme: CodeModeObserverWidgetTheme,
  ) {}

  update(view: CodeModeObserverView): void {
    this.view = view;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    return renderCodeModeObserverWidgetLines(this.view, width, this.theme);
  }

  invalidate(): void {}
}

/** Own the TUI-only CodeMode Observer widget, refresh, cooldown, and cleanup. */
export class CodeModeObserverUiController {
  private disposed = false;
  private widgetMounted = false;
  private latestSnapshot: CodeModeObserverSnapshot = { sessions: [] };
  private currentView: CodeModeObserverView = {
    runningCount: 0,
    liveCount: 0,
    rows: [],
    overflowCount: 0,
  };
  private widgetComponent: CodeModeObserverWidgetComponent | undefined;
  private refreshTimer: CodeModeTimerHandle | undefined;
  private cooldownTimer: CodeModeTimerHandle | undefined;
  private readonly notifiedUnexpectedFailures = new Set<string>();

  /** Creates an inert non-TUI controller or a live TUI observer using explicit time capabilities. */
  constructor(
    private readonly context: CodeModeObserverUiContext,
    private readonly runtime: CodeModeObserverUiRuntime,
  ) {}

  /** Apply one immutable coordinator snapshot immediately without controlling any Session. */
  onSnapshotChange(snapshot: CodeModeObserverSnapshot): void {
    if (this.disposed || this.context.mode !== "tui") return;
    this.latestSnapshot = snapshot;
    this.currentView = buildCodeModeObserverView(snapshot, this.runtime.now());
    this.applyCurrentView();
  }

  /** Notify once when an idle CodeMode worker fails without an active Transcript result. */
  onUnexpectedFailure(failure: CodeModeUnexpectedFailure): void {
    if (
      this.disposed ||
      this.context.mode !== "tui" ||
      this.notifiedUnexpectedFailures.has(failure.sessionId)
    ) {
      return;
    }
    this.notifiedUnexpectedFailures.add(failure.sessionId);
    const safeSessionId = boundedCodeModeObserverText(failure.sessionId, 256) || "unknown";
    const safeMessage = boundedCodeModeObserverText(failure.message, 1_024) || "worker stopped";
    try {
      this.context.ui.notify(
        `CodeMode Session ${safeSessionId} stopped unexpectedly: ${safeMessage}`,
        "error",
      );
    } catch {
      // A non-authoritative notification failure cannot alter CodeMode lifecycle.
    }
  }

  /** Clear all CodeMode Observer timers and TUI surfaces; repeated calls do nothing. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearRefreshTimer();
    this.clearCooldownTimer();
    if (this.context.mode === "tui") {
      this.clearWidget();
    }
    this.widgetMounted = false;
    this.widgetComponent = undefined;
  }

  private applyCurrentView(): void {
    if (this.currentView.rows.length === 0) {
      this.clearRefreshTimer();
      this.clearCooldownTimer();
      this.hideWidget();
      return;
    }
    this.showWidget();
    if (this.currentView.runningCount > 0) {
      this.clearCooldownTimer();
      this.ensureRefreshTimer();
      return;
    }
    this.clearRefreshTimer();
    this.ensureCooldownTimer();
  }

  private showWidget(): void {
    if (this.widgetMounted) {
      try {
        this.widgetComponent?.update(this.currentView);
      } catch {
        // A non-authoritative redraw failure cannot alter CodeMode lifecycle.
      }
      return;
    }
    try {
      this.context.ui.setWidget(
        CODEMODE_OBSERVER_UI_KEY,
        (tui, theme) => {
          this.widgetComponent = new CodeModeObserverWidgetComponent(this.currentView, tui, theme);
          return this.widgetComponent;
        },
        { placement: "aboveEditor" },
      );
      this.widgetMounted = true;
    } catch {
      this.widgetComponent = undefined;
    }
  }

  private hideWidget(): void {
    if (!this.widgetMounted) return;
    this.clearWidget();
  }

  private clearWidget(): void {
    try {
      this.context.ui.setWidget(CODEMODE_OBSERVER_UI_KEY, undefined);
    } catch {
      // A non-authoritative widget cleanup failure cannot alter CodeMode cleanup.
    } finally {
      this.widgetMounted = false;
      this.widgetComponent = undefined;
    }
  }

  private ensureRefreshTimer(): void {
    if (this.refreshTimer !== undefined) return;
    this.refreshTimer = this.runtime.setTimeout(() => {
      this.refreshTimer = undefined;
      if (this.disposed || this.context.mode !== "tui") return;
      this.currentView = buildCodeModeObserverView(this.latestSnapshot, this.runtime.now());
      if (this.currentView.runningCount === 0) return;
      this.showWidget();
      this.ensureRefreshTimer();
    }, CODEMODE_OBSERVER_REFRESH_MS);
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer === undefined) return;
    this.runtime.clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  private ensureCooldownTimer(): void {
    this.clearCooldownTimer();
    this.cooldownTimer = this.runtime.setTimeout(() => {
      this.cooldownTimer = undefined;
      if (!this.disposed) this.hideWidget();
    }, CODEMODE_OBSERVER_COOLDOWN_MS);
  }

  private clearCooldownTimer(): void {
    if (this.cooldownTimer === undefined) return;
    this.runtime.clearTimeout(this.cooldownTimer);
    this.cooldownTimer = undefined;
  }
}
