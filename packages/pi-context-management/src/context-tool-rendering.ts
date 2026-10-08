import { Type } from "typebox";
import { Value } from "typebox/value";
import type {
  AgentToolResult,
  MessageRenderOptions,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, stripTerminalSequences, type Component } from "@earendil-works/pi-tui";
import { stripControlCharacters } from "@ian-pascoe/pi-utils";
import {
  COLLAPSED_LINES,
  SEPARATOR,
  appendDurationFooter,
  callDurationFooter,
  clipPlain,
  customMessageBox,
  previewBody,
  toolHeader,
  type DurationContext,
} from "@ian-pascoe/pi-utils/ui";

/** Existing tool result payloads; presentation does not change their serialized form. */
export type ContextToolDetails =
  | { action: string; name: string; saved: boolean }
  | { requested: boolean }
  | {
      notes: Array<{ name: string; ref: string; updatedAt: string; characters: number }>;
      total: number;
      nextOffset: number | null;
    }
  | { windows: Array<{ ref: string; items: number }>; total: number; nextOffset: number | null }
  | {
      items: Array<{ ref: string; type: string; timestamp: string; preview: string }>;
      total: number;
      nextOffset: number | null;
    }
  | {
      matches: Array<{ ref: string; name?: string | undefined; offset: number; preview: string }>;
      nextOffset: number | null;
    }
  | {
      content: string;
      ref: string;
      name?: string;
      offset: number;
      totalCharacters: number;
      nextOffset: number | null;
      resolvedInSession?: string;
      format?: string;
      availability?: string;
    };

type RenderTheme = Pick<Theme, "bold" | "fg">;

/** The custom messages Context Management sends, with their headers. */
export const CONTEXT_MESSAGE_LABELS = {
  "pi-context-prepare": "[context rollover]",
  "pi-context-manual-prepare": "[context rollover: manual]",
  "pi-context-prepare-cancelled": "[context rollover: cancelled]",
} as const;

/** Pi's custom-message look: a `customMessageBg` box, a bold label, and a 10-line Collapsed View. */
export function renderContextMessage(
  label: string,
  message: { content: string | Array<{ type: string; text?: string }> },
  options: MessageRenderOptions,
  theme: Pick<Theme, "bg" | "bold" | "fg">,
): Component {
  const text = Array.isArray(message.content)
    ? message.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n")
    : String(message.content);
  return customMessageBox(theme, { outputPad: options.outputPad, label }, [
    lineBlock(
      previewBody(theme, textLines(text), {
        limit: COLLAPSED_LINES.fallback,
        expanded: options.expanded,
        color: "customMessageText",
      }),
    ),
  ]);
}

/** The registered names of the tools this module presents. */
export type ContextToolName = "context_notes" | "context_history" | "context_rollover";

interface ContextToolArguments {
  action?: string;
  query?: string;
  name?: string;
  ref?: string;
  handoff?: string;
  content?: string;
  window?: string;
  type?: string;
  role?: string;
  offset?: number;
  limit?: number;
}

/** The parts of Pi's render context the call row reads. */
export type ContextToolCallContext = DurationContext & { expanded: boolean };

/** The parts of Pi's render context the result row reads. */
export type ContextToolResultContext = DurationContext & {
  args: ContextToolArguments;
  isError: boolean;
};

function safeText(text: string): string {
  return stripControlCharacters(stripTerminalSequences(text));
}

function field(theme: RenderTheme, label: string, value: string | number): string {
  return theme.fg("muted", `${label}: ${safeText(String(value))}`);
}

function preview(text: string): string {
  return clipPlain(safeText(text).replace(/\s+/g, " "), 32);
}

function rowPreview(text: string): string {
  return clipPlain(safeText(text).replace(/\s+/g, " "), 200);
}

function referenceTail(ref: string): string {
  return preview(ref.split(":").at(-1) ?? ref);
}

function windowTarget(args: ContextToolArguments): string {
  return args.window && args.action !== "windows"
    ? preview(args.window.split(":").at(-1) ?? "")
    : "";
}

function callTarget(args: ContextToolArguments): string {
  const named = args.name ?? args.query;
  const subject =
    named !== undefined ? `“${preview(named)}”` : preview(args.ref?.split(":").at(-1) ?? "");
  return [subject, windowTarget(args)].filter(Boolean).join(SEPARATOR);
}

/** Arguments one per line, like Pi's generic header, for the Expanded View. */
function argumentLines(theme: RenderTheme, args: ContextToolArguments): string[] {
  const entries: Array<[string, string | number | undefined]> = [
    ["action", args.action],
    ["name", args.name],
    ["query", args.query],
    ["ref", args.ref],
    ["window", args.window],
    ["type", args.type],
    ["role", args.role],
    ["offset", args.offset],
    ["limit", args.limit],
  ];
  return entries.flatMap(([key, value]) => (value === undefined ? [] : [field(theme, key, value)]));
}

function textLines(text: string): string[] {
  return safeText(text).split("\n");
}

function lineBlock(lines: readonly string[]): Component {
  return new Text(lines.join("\n"), 0, 0);
}

/** The written Note or Handoff that a call carries, shown as the call's own body like Pi's write. */
function callContent(name: ContextToolName, args: ContextToolArguments): string | undefined {
  const content =
    name === "context_rollover"
      ? args.handoff
      : args.action === "write" || args.action === "append"
        ? args.content
        : undefined;
  return Value.Check(Type.String({ minLength: 1 }), content) ? content : undefined;
}

/** The call row stays after completion; it owns the live `Elapsed` footer until a result exists. */
export function renderContextToolCall(
  name: ContextToolName,
  args: ContextToolArguments,
  theme: RenderTheme,
  context: ContextToolCallContext,
): Component {
  const container = new Container();
  const action = args.action === undefined ? undefined : preview(args.action);
  container.addChild(
    new Text(toolHeader(theme, name, action || undefined, callTarget(args) || undefined), 0, 0),
  );
  if (context.expanded) {
    const lines = argumentLines(theme, args);
    if (lines.length > 0) container.addChild(lineBlock(lines));
  }
  const content = callContent(name, args);
  if (content !== undefined) {
    container.addChild(
      lineBlock(
        previewBody(theme, textLines(content), {
          limit: COLLAPSED_LINES.fallback,
          expanded: context.expanded,
        }),
      ),
    );
  }
  container.addChild(callDurationFooter(theme, context));
  return container;
}

function more(theme: RenderTheme, nextOffset: number | null, shown?: string): string[] {
  if (nextOffset === null) return [];
  return [theme.fg("muted", [shown, `next offset ${nextOffset}`].filter(Boolean).join(SEPARATOR))];
}

/** Rows in the Collapsed View, or their detail blocks in the Expanded View. */
function rowsBody(
  theme: RenderTheme,
  options: ToolRenderResultOptions,
  limit: number,
  collapsed: readonly string[],
  expanded: readonly string[],
  empty: string,
  trailer: readonly string[],
): string[] {
  if (collapsed.length === 0) return [theme.fg("muted", empty)];
  const body = options.expanded
    ? [...expanded]
    : previewBody(theme, collapsed, { limit, expanded: false });
  return [...body, ...trailer];
}

function errorLines(
  result: AgentToolResult<unknown>,
  name: ContextToolName,
  isError: boolean,
): string[] {
  const output = result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  const text = safeText(output).trimEnd();
  if (text) return text.split("\n");
  return [isError ? `${name} failed` : "Result details unavailable"];
}

function detailBody(
  details: Exclude<ContextToolDetails, { saved: boolean } | { requested: boolean }>,
  theme: RenderTheme,
  options: ToolRenderResultOptions,
): string[] {
  const { expanded } = options;
  if ("matches" in details) {
    const collapsed = details.matches.map((match) =>
      [
        match.name ? safeText(match.name) : undefined,
        `offset ${match.offset}`,
        rowPreview(match.preview),
      ]
        .filter(Boolean)
        .join(SEPARATOR),
    );
    const detailed = details.matches.flatMap((match, index) => [
      ...(index > 0 ? [""] : []),
      ...(match.name ? [field(theme, "Note", match.name)] : []),
      field(theme, "Reference", match.ref),
      field(theme, "Offset", `${match.offset} UTF-16 units`),
      theme.fg("toolOutput", safeText(match.preview)),
    ]);
    return rowsBody(theme, options, COLLAPSED_LINES.fallback, collapsed, detailed, "No matches", [
      ...(expanded ? [field(theme, "Next offset", details.nextOffset ?? "none")] : []),
      ...(expanded ? [] : more(theme, details.nextOffset)),
    ]);
  }
  if ("windows" in details || "items" in details) {
    const total = details.total;
    const rows = "windows" in details ? details.windows : details.items;
    const collapsed = rows.map((row) =>
      "items" in row
        ? [referenceTail(row.ref), `${row.items} entries`].join(SEPARATOR)
        : [referenceTail(row.ref), safeText(row.type), rowPreview(row.preview)].join(SEPARATOR),
    );
    const detailed = rows.flatMap((row, index) => [
      ...(index > 0 ? [""] : []),
      theme.fg(
        "toolOutput",
        "items" in row
          ? `${row.items} entries`
          : `${safeText(row.type)}${SEPARATOR}${safeText(row.timestamp)}`,
      ),
      field(theme, "Reference", row.ref),
      ...("preview" in row ? [theme.fg("toolOutput", safeText(row.preview))] : []),
    ]);
    return rowsBody(
      theme,
      options,
      COLLAPSED_LINES.fallback,
      collapsed,
      detailed,
      "windows" in details ? "No Context Windows" : "No entries",
      expanded
        ? [
            field(theme, "Showing", `${rows.length} of ${total}`),
            field(theme, "Next offset", details.nextOffset ?? "none"),
          ]
        : more(theme, details.nextOffset, `${rows.length} of ${total}`),
    );
  }
  if ("notes" in details) {
    const { notes, total } = details;
    const detailed = notes.flatMap((note, index) => [
      ...(index > 0 ? [""] : []),
      theme.fg("toolOutput", `${safeText(note.name)}${SEPARATOR}${note.characters} UTF-16 units`),
      field(theme, "Updated", note.updatedAt),
      field(theme, "Reference", note.ref),
    ]);
    return rowsBody(
      theme,
      options,
      COLLAPSED_LINES.list,
      notes.map((note) => safeText(note.name)),
      detailed,
      "No Notes",
      expanded
        ? [
            field(theme, "Showing", `${notes.length} of ${total}`),
            field(theme, "Next offset", details.nextOffset ?? "none"),
          ]
        : more(theme, details.nextOffset, `${notes.length} of ${total}`),
    );
  }
  // A successful read is header only, like Pi's read; the content appears when expanded.
  if (!expanded) return [];
  const content = safeText(details.content);
  return [
    field(theme, "Reference", details.ref),
    ...(details.resolvedInSession
      ? [field(theme, "Resolved in session", details.resolvedInSession)]
      : []),
    ...(details.format ? [field(theme, "Format", details.format)] : []),
    ...(details.availability ? [field(theme, "Availability", details.availability)] : []),
    field(
      theme,
      "Range",
      `${details.offset}–${details.offset + details.content.length} of ${details.totalCharacters} UTF-16 units`,
    ),
    field(theme, "Next offset", details.nextOffset ?? "none"),
    "",
    ...previewBody(theme, (content || "(empty)").split("\n"), {
      limit: COLLAPSED_LINES.fallback,
      expanded: true,
    }),
  ];
}

/** Present tool data without altering the agent-facing result or claiming checkpoint completion. */
export function renderContextToolResult(
  result: AgentToolResult<ContextToolDetails | undefined>,
  options: ToolRenderResultOptions,
  theme: RenderTheme,
  name: ContextToolName,
  context: ContextToolResultContext,
): Component {
  const container = new Container();
  // The call row already carries the header; Pi shows only the footer while no result exists.
  if (options.isPartial) {
    appendDurationFooter(container, theme, context, { isPartial: true });
    return container;
  }
  const { details } = result;
  if (context.isError || details == null) {
    container.addChild(
      lineBlock(
        previewBody(theme, errorLines(result, name, context.isError), {
          limit: COLLAPSED_LINES.fallback,
          expanded: options.expanded,
          color: context.isError ? "error" : "muted",
        }),
      ),
    );
    appendDurationFooter(container, theme, context, { isPartial: false });
    return container;
  }
  // Notes saved or a Rollover requested: the call row shows the content and the background the outcome.
  if (!("saved" in details) && !("requested" in details)) {
    const lines = detailBody(details, theme, options);
    if (lines.length > 0) container.addChild(lineBlock(lines));
  }
  appendDurationFooter(container, theme, context, { isPartial: false });
  return container;
}
