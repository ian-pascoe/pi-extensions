import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { McpServerStatus } from "./mcp-host.js";
import { sanitizeMcpPresentationText } from "./mcp-presentation.js";

const MCP_OBSERVER_STATUS_KEY = "pi-mcp";

/** Minimal TUI context used by the read-only MCP Observer UI. */
export type McpObserverUiContext = {
  readonly mode: "json" | "print" | "rpc" | "tui";
  readonly ui: {
    readonly notify: (message: string, level: "error" | "warning") => void;
    readonly setStatus: (key: string, status: string | undefined) => void;
    readonly theme: Pick<Theme, "fg">;
  };
};

/** One bounded MCP Attention Notice for an actionable Host condition. */
export type McpAttentionNotice =
  | {
      readonly action: "/mcp status";
      readonly cause: string;
      readonly condition: "invalid_settings";
      readonly level: "warning";
    }
  | {
      readonly action: `/mcp auth ${string}`;
      readonly cause: string;
      readonly condition: "needs_auth" | "needs_client_registration";
      readonly level: "warning";
      readonly serverId: string;
    }
  | {
      readonly action: `/mcp reconnect ${string}`;
      readonly cause: string;
      readonly condition: "failed";
      readonly level: "error";
      readonly serverId: string;
    };

/** One footer status row with its required theme role. */
export type McpObserverFooter = {
  readonly color: "dim" | "error" | "warning";
  readonly text: string;
};

/** Read-only MCP Observer Snapshot derived from copied Host status. */
export type McpObserverSnapshot = {
  readonly footer?: McpObserverFooter;
  readonly notices: readonly McpAttentionNotice[];
};

function actionableNotice(
  serverId: string,
  status: McpServerStatus,
): McpAttentionNotice | undefined {
  const commandServerId = sanitizeMcpPresentationText(serverId).replace(/\s+/g, " ").trim();
  const commandArgument = /^[A-Za-z0-9._-]+$/u.test(commandServerId)
    ? commandServerId
    : JSON.stringify(commandServerId);
  switch (status.state) {
    case "needs_auth":
      return {
        action: `/mcp auth ${commandArgument}`,
        cause: status.error,
        condition: "needs_auth",
        level: "warning",
        serverId,
      };
    case "needs_client_registration":
      return {
        action: `/mcp auth ${commandArgument}`,
        cause: status.error,
        condition: "needs_client_registration",
        level: "warning",
        serverId,
      };
    case "failed":
      return {
        action: `/mcp reconnect ${commandArgument}`,
        cause: status.error,
        condition: "failed",
        level: "error",
        serverId,
      };
    default:
      return undefined;
  }
}

/** Project copied MCP Host status into the bounded, read-only MCP Observer Snapshot. */
export function buildMcpObserverSnapshot(
  statuses: ReadonlyMap<string, McpServerStatus>,
  invalidSettings: readonly string[] = [],
): McpObserverSnapshot {
  const entries = [...statuses].sort(([left], [right]) => left.localeCompare(right));
  const enabled = entries.filter(([, status]) => status.state !== "disabled");
  const connected = enabled.filter(([, status]) => status.state === "connected").length;
  const counts = new Map<string, number>();
  for (const [, status] of enabled) {
    if (status.state !== "connected") counts.set(status.state, (counts.get(status.state) ?? 0) + 1);
  }
  const stateLabels = [
    ["connecting", "connecting"],
    ["retrying", "retrying"],
    ["needs_auth", "authentication"],
    ["needs_client_registration", "registration"],
    ["failed", "failed"],
  ] as const;
  const degraded = stateLabels
    .flatMap(([state, label]) => {
      const count = counts.get(state);
      return count === undefined ? [] : [`${label} ${count}`];
    })
    .join(" · ");
  const footer =
    enabled.length === 0
      ? undefined
      : degraded.length === 0
        ? { color: "dim" as const, text: `MCP ${connected}/${enabled.length}` }
        : {
            color: counts.has("failed") ? ("error" as const) : ("warning" as const),
            text: `MCP ${connected}/${enabled.length} · ${degraded}`,
          };
  const notices = entries.flatMap(([serverId, status]) => {
    const notice = actionableNotice(serverId, status);
    return notice === undefined ? [] : [notice];
  });
  if (invalidSettings.length > 0) {
    notices.unshift({
      action: "/mcp status",
      cause: invalidSettings.join("\n"),
      condition: "invalid_settings",
      level: "warning",
    });
  }
  return footer === undefined ? { notices } : { footer, notices };
}

/** Own TUI-only MCP footer status and deduplicated MCP Attention Notices for one session. */
export class McpObserverUiController {
  private disposed = false;
  private readonly activeNoticeKeys = new Set<string>();

  /** Build a controller with the session's exact-value redactor. */
  constructor(
    private readonly context: McpObserverUiContext,
    private readonly redact: (value: string) => string,
  ) {}

  /** Render a copied Host status map without changing MCP Host state or sending protocol requests. */
  update(
    statuses: ReadonlyMap<string, McpServerStatus>,
    invalidSettings: readonly string[] = [],
  ): void {
    if (this.disposed || this.context.mode !== "tui") return;
    const snapshot = buildMcpObserverSnapshot(statuses, invalidSettings);
    this.setFooter(snapshot.footer);
    const nextNoticeKeys = new Set<string>();
    for (const notice of snapshot.notices) {
      const safeCause = sanitizeMcpPresentationText(this.redact(notice.cause)).trim();
      const cause = truncateToWidth(safeCause.replace(/\s+/g, " "), 240, "…");
      const key = `${notice.condition === "invalid_settings" ? "settings" : notice.serverId}\0${notice.action}\0${safeCause}`;
      nextNoticeKeys.add(key);
      if (this.activeNoticeKeys.has(key)) continue;
      const subject =
        notice.condition === "invalid_settings"
          ? "MCP settings need attention"
          : `MCP Server ${sanitizeMcpPresentationText(notice.serverId).replace(/\s+/g, " ").trim()} ${notice.condition === "failed" ? "failed" : notice.condition === "needs_auth" ? "needs authentication" : "needs client registration"}`;
      this.notify(`${subject}: ${cause}\nRun ${notice.action}`, notice.level);
    }
    this.activeNoticeKeys.clear();
    for (const key of nextNoticeKeys) this.activeNoticeKeys.add(key);
  }

  /** Clear the footer before Host teardown; repeated disposal is safe. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.activeNoticeKeys.clear();
    if (this.context.mode === "tui") this.setFooter(undefined);
  }

  private setFooter(footer: McpObserverFooter | undefined): void {
    try {
      this.context.ui.setStatus(
        MCP_OBSERVER_STATUS_KEY,
        footer === undefined ? undefined : this.context.ui.theme.fg(footer.color, footer.text),
      );
    } catch {
      // Observer rendering failures must not affect MCP Host lifecycle.
    }
  }

  private notify(message: string, level: "error" | "warning"): void {
    try {
      this.context.ui.notify(message, level);
    } catch {
      // Observer rendering failures must not affect MCP Host lifecycle.
    }
  }
}
