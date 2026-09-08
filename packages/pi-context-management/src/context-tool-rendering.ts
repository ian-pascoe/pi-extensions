import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  getMarkdownTheme,
  keyText,
  truncateHead,
  type AgentToolResult,
  type Theme,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Markdown,
  Spacer,
  Text,
  TruncatedText,
  stripTerminalSequences,
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";

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

interface ContextToolArguments {
  action?: string;
  query?: string;
  name?: string;
  ref?: string;
  handoff?: string;
  content?: string;
  window?: string;
  offset?: number;
  limit?: number;
}

function safeText(text: string): string {
  return (
    stripTerminalSequences(text)
      .replace(/\r\n?/g, "\n")
      // oxlint-disable-next-line eslint/no-control-regex -- Keep tabs/newlines, but never execute terminal controls from tool content.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
  );
}

function field(
  container: Container,
  theme: RenderTheme,
  label: string,
  value: string | number,
): void {
  container.addChild(
    new Text(`${theme.fg("muted", `${label}:`)} ${safeText(String(value))}`, 0, 0),
  );
}

function expandedResult(
  heading: Component,
  theme: RenderTheme,
  args: ContextToolArguments,
): Container {
  const container = new Container();
  container.addChild(heading);
  if (args.name !== undefined) field(container, theme, "Note", args.name);
  if (args.query !== undefined) field(container, theme, "Query", args.query);
  if (args.window !== undefined) field(container, theme, "Window", args.window);
  if (args.offset !== undefined) field(container, theme, "Offset", args.offset);
  if (args.limit !== undefined) field(container, theme, "Limit", args.limit);
  return container;
}

function summary(text: string, expanded: boolean, theme: RenderTheme): Component {
  const key = keyText("app.tools.expand");
  const hint = key ? `${key} to expand` : "expand for details";
  return expanded
    ? new Text(theme.fg("success", text), 0, 0)
    : new TruncatedText(`${theme.fg("success", text)}${theme.fg("dim", ` · ${hint}`)}`);
}

function preview(text: string): string {
  return truncateToWidth(safeText(text).replace(/\s+/g, " "), 32);
}

function windowTarget(args: ContextToolArguments): string {
  return args.window && args.action !== "windows"
    ? ` · ${preview(args.window.split(":").at(-1) ?? "")}`
    : "";
}

function callTarget(args: ContextToolArguments): string {
  const named = args.name ?? args.query;
  return (
    (named !== undefined ? `“${preview(named)}”` : preview(args.ref?.split(":").at(-1) ?? "")) +
    windowTarget(args)
  );
}

/** Cap rendered rows, not source lines, so wrapped text stays bounded in narrow terminals. */
function contentPreview(
  heading: Component,
  content: string,
  expanded: boolean,
  theme: RenderTheme,
): Component {
  const body = new Markdown(safeText(content), 0, 0, getMarkdownTheme());
  const omitted = new TruncatedText(
    theme.fg("dim", "… earlier lines hidden · expand for full text"),
  );
  return {
    render(width) {
      if (width <= 0) return [];
      const lines = body.render(width);
      const visible =
        expanded || lines.length <= 7 ? lines : [...omitted.render(width), ...lines.slice(-6)];
      return [...heading.render(width), ...visible];
    },
    invalidate() {
      heading.invalidate();
      body.invalidate();
      omitted.invalidate();
    },
  };
}

/** Pending calls own the preview until the final result replaces it in Pi's default shell. */
export function renderContextToolCall(
  label: string,
  args: ContextToolArguments,
  theme: RenderTheme,
  isPartial: boolean,
  executionStarted: boolean,
  expanded: boolean,
): Component {
  if (!isPartial) return new Container();
  const action = [preview(args.action ?? ""), callTarget(args)].filter(Boolean).join(" ");
  const content =
    label === "Rollover"
      ? args.handoff
      : label === "Notes" && (args.action === "write" || args.action === "append")
        ? args.content
        : undefined;
  if (Value.Check(Type.String({ minLength: 1 }), content)) {
    const heading = new TruncatedText(
      theme.fg(
        "accent",
        `${label}${action ? ` · ${action}` : ""} · ${executionStarted ? "running…" : "streaming…"}`,
      ),
    );
    return contentPreview(heading, content, expanded, theme);
  }
  return new TruncatedText(
    theme.fg(
      "accent",
      `${label}${action ? ` · ${action}` : ""} · ${executionStarted ? "running…" : "preparing…"}`,
    ),
  );
}

/** Present tool data without altering the agent-facing result or claiming checkpoint completion. */
export function renderContextToolResult(
  result: AgentToolResult<ContextToolDetails | undefined>,
  options: ToolRenderResultOptions,
  theme: RenderTheme,
  label: "Notes" | "History" | "Rollover",
  args: ContextToolArguments,
  isError: boolean,
): Component {
  // The call slot already shows partial progress; do not duplicate it in the result slot.
  if (options.isPartial) return new Container();
  if (isError || result.details == null) {
    const output = safeText(
      result.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n"),
    );
    const status = isError ? "failed" : "result details unavailable";
    const action = [preview(args.action ?? ""), callTarget(args)].filter(Boolean).join(" ");
    const heading = `${label}${action ? ` · ${action}` : ""} · ${status}`;
    const color = isError ? "error" : "muted";
    if (!options.expanded)
      return new TruncatedText(
        theme.fg(
          color,
          `${heading}${output ? ` · ${output.split("\n").find((line) => line.trim()) ?? ""}` : ""}`,
        ),
      );
    const bounded = truncateHead(output);
    return new Text(
      theme.fg(
        color,
        `${heading}\n${bounded.content}${bounded.truncated ? "\n… Transcript output truncated" : ""}`,
      ),
      0,
      0,
    );
  }
  if ("saved" in result.details) {
    const { action, name } = result.details;
    const outcome = action === "delete" ? "deleted" : action === "append" ? "appended" : "saved";
    const heading = theme.fg("success", `Notes · ${outcome} “${safeText(name)}”`);
    if (!options.expanded) {
      const title = new TruncatedText(heading);
      return action !== "delete" && args.content !== undefined
        ? contentPreview(title, args.content || "(empty Note)", false, theme)
        : title;
    }
    const container = expandedResult(new Text(heading, 0, 0), theme, args);
    if (action !== "delete" && args.content !== undefined) {
      container.addChild(new Spacer(1));
      container.addChild(
        new Markdown(safeText(args.content) || "(empty Note)", 0, 0, getMarkdownTheme()),
      );
    }
    return container;
  }
  const details = result.details;
  if ("requested" in details) {
    const heading = summary("Rollover · requested · Handoff saved", options.expanded, theme);
    if (!options.expanded) return contentPreview(heading, args.handoff ?? "", false, theme);
    const container = new Container();
    container.addChild(heading);
    container.addChild(new Text("Checkpoint commit follows the complete tool batch.", 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(new Markdown(safeText(args.handoff ?? ""), 0, 0, getMarkdownTheme()));
    return container;
  }
  if ("matches" in details) {
    const heading = summary(
      `${label} · search “${preview(args.query ?? "")}”${windowTarget(args)} · ${details.matches.length} ${details.matches.length === 1 ? "match" : "matches"}${details.nextOffset === null ? "" : " · more"}`,
      options.expanded,
      theme,
    );
    if (!options.expanded) return heading;
    const container = expandedResult(heading, theme, args);
    for (const match of details.matches) {
      container.addChild(new Spacer(1));
      if (match.name) field(container, theme, "Note", match.name);
      field(container, theme, "Reference", match.ref);
      field(container, theme, "Offset", `${match.offset} UTF-16 units`);
      container.addChild(new Text(safeText(match.preview), 0, 0));
    }
    field(container, theme, "Next offset", details.nextOffset ?? "none");
    return container;
  }
  if ("windows" in details || "items" in details) {
    const rows = "windows" in details ? details.windows : details.items;
    const action = "windows" in details ? "windows" : "list";
    const noun = "windows" in details ? "Context Windows" : "entries";
    const heading = summary(
      `History · ${action}${windowTarget(args)} · ${rows.length} of ${details.total} ${noun}${details.nextOffset === null ? "" : " · more"}`,
      options.expanded,
      theme,
    );
    if (!options.expanded) return heading;
    const container = expandedResult(heading, theme, args);
    for (const row of rows) {
      container.addChild(new Spacer(1));
      container.addChild(
        new Text(
          theme.bold(
            "items" in row
              ? `${row.items} entries`
              : `${safeText(row.type)} · ${safeText(row.timestamp)}`,
          ),
          0,
          0,
        ),
      );
      field(container, theme, "Reference", row.ref);
      if ("preview" in row) container.addChild(new Text(safeText(row.preview), 0, 0));
    }
    field(container, theme, "Next offset", details.nextOffset ?? "none");
    return container;
  }
  if ("notes" in details) {
    const heading = summary(
      `Notes · list · ${details.notes.length} of ${details.total} Notes${details.nextOffset === null ? "" : " · more"}`,
      options.expanded,
      theme,
    );
    if (!options.expanded) return heading;
    const container = expandedResult(heading, theme, args);
    for (const note of details.notes) {
      container.addChild(new Spacer(1));
      container.addChild(
        new Text(theme.bold(`${safeText(note.name)} · ${note.characters} UTF-16 units`), 0, 0),
      );
      field(container, theme, "Updated", note.updatedAt);
      field(container, theme, "Reference", note.ref);
    }
    field(container, theme, "Next offset", details.nextOffset ?? "none");
    return container;
  }
  if ("content" in details) {
    const heading = summary(
      `${label} · read ${label === "Notes" ? `“${preview(details.name ?? "")}”` : preview(details.ref.split(":").at(-1) ?? details.ref)}${details.nextOffset === null ? "" : " · more"}`,
      options.expanded,
      theme,
    );
    if (!options.expanded) return heading;
    const container = expandedResult(heading, theme, args);
    field(container, theme, "Reference", details.ref);
    if (details.resolvedInSession)
      field(container, theme, "Resolved in session", details.resolvedInSession);
    if (details.format) field(container, theme, "Format", details.format);
    if (details.availability) field(container, theme, "Availability", details.availability);
    field(
      container,
      theme,
      "Range",
      `${details.offset}–${details.offset + details.content.length} of ${details.totalCharacters} UTF-16 units`,
    );
    field(container, theme, "Next offset", details.nextOffset ?? "none");
    container.addChild(new Spacer(1));
    container.addChild(
      label === "Notes"
        ? new Markdown(safeText(details.content) || "(empty Note)", 0, 0, getMarkdownTheme())
        : new Text(safeText(details.content) || "(empty slice)", 0, 0),
    );
    return container;
  }
  return new Container();
}
