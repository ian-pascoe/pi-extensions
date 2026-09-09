import { Buffer } from "node:buffer";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  ToolExecutionComponent,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type AgentToolResult,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  compositeTuiLine,
  Container,
  stripTerminalSequences,
  Text,
  visibleWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  CodeModeJsonValueSchema,
  isCodeModeJsonObject,
  parseCodeModeJsonValue,
  type CodeModeJsonValue,
} from "./codemode-tool-contract.js";

/** Durable, human-only entries containing tools invoked within one Cell. */
export const CODEMODE_NESTED_TOOLS_ENTRY_TYPE = "pi-codemode:nested-tools";

type NativeToolDefinition = NonNullable<ConstructorParameters<typeof ToolExecutionComponent>[4]>;

const NestedToolResultSchema = Type.Object({
  content: Type.Array(
    Type.Union([
      Type.Object({ type: Type.Literal("text"), text: Type.String() }),
      Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() }),
    ]),
  ),
  details: Type.Optional(CodeModeJsonValueSchema),
  isError: Type.Boolean(),
});
const NestedToolSnapshotSchema = Type.Object({
  callId: Type.String(),
  name: Type.String(),
  outcome: Type.Union([Type.Literal("success"), Type.Literal("failed"), Type.Literal("unknown")]),
  args: Type.Optional(Type.Record(Type.String(), CodeModeJsonValueSchema)),
  argsPreview: Type.Optional(Type.String()),
  result: Type.Optional(NestedToolResultSchema),
  resultPreview: Type.Optional(Type.String()),
  spillPath: Type.Optional(Type.String()),
});

/** Bounded arguments and result retained for one nested tool display. */
export type CodeModeNestedToolSnapshot = Static<typeof NestedToolSnapshotSchema>;

/** Versioned data kept in a custom entry, never in model-facing tool content. */
export const CodeModeNestedToolsTranscriptSchema = Type.Object({
  version: Type.Literal(1),
  ref: Type.Optional(Type.String()),
  sessionId: Type.String(),
  cellOrdinal: Type.Integer({ minimum: 1 }),
  cwd: Type.String(),
  calls: Type.Array(NestedToolSnapshotSchema),
});

const TextSchema = Type.String();

function capturePayload(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: Raw handler data is parsed without evaluating accessors or toJSON.
  value: unknown,
  maxBytes: number,
): { readonly value: CodeModeJsonValue } | { readonly preview: string } {
  const parsed = parseCodeModeJsonValue(value, {
    maxBytes: 8 * 1024 * 1024,
    normalizeUndefinedForJsonTransport: true,
  });
  if (!parsed.ok || parsed.value === undefined) {
    return { preview: "Native replay unavailable: unsafe or unrepresentable captured data" };
  }
  let lines = 1;
  const text = JSON.stringify(
    parsed.value,
    (_key, entry: CodeModeJsonValue) => {
      if (Value.Check(TextSchema, entry)) lines += entry.split("\n").length - 1;
      return entry;
    },
    2,
  );
  if (Buffer.byteLength(text) <= maxBytes && lines <= DEFAULT_MAX_LINES)
    return { value: parsed.value };
  // Leave room for JSON escaping when this text preview is itself persisted.
  const preview = Buffer.from(text)
    .subarray(0, Math.max(0, Math.floor(maxBytes / 2)))
    .toString("utf8")
    .split("\n")
    .slice(0, DEFAULT_MAX_LINES)
    .join("\n");
  return { preview: `[truncated; native replay unavailable]\n${preview}` };
}

/** Snapshot supplied arguments without retaining mutable handler or guest references. */
export function captureCodeModeNestedToolCall(
  callId: string,
  name: string,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: Raw tool inputs enter through the descriptor-safe CodeMode JSON parser.
  input: unknown,
): CodeModeNestedToolSnapshot {
  const call: CodeModeNestedToolSnapshot = { callId, name, outcome: "unknown" };
  const captured = capturePayload(input, DEFAULT_MAX_BYTES / 2);
  if ("value" in captured && isCodeModeJsonObject(captured.value)) {
    call.args = captured.value;
  } else {
    call.argsPreview =
      "preview" in captured
        ? captured.preview
        : "Native replay unavailable: arguments are not an object";
  }
  return call;
}

/** Project only native display fields without invoking accessors or unrelated result metadata. */
export function codeModeNestedToolResultData(result: AgentToolResult<unknown>) {
  const presentation = {};
  for (const key of ["content", "details"]) {
    const descriptor = Object.getOwnPropertyDescriptor(result, key);
    if (descriptor !== undefined) Object.defineProperty(presentation, key, descriptor);
  }
  return presentation;
}

/** Retain the finalized handler result for human replay, independently of guest translation. */
export function completeCodeModeNestedToolCall(
  call: CodeModeNestedToolSnapshot,
  result: AgentToolResult<unknown>,
  isError: boolean,
): CodeModeNestedToolSnapshot {
  const completed: CodeModeNestedToolSnapshot = {
    ...call,
    outcome: isError ? "failed" : "success",
  };
  try {
    const captured = capturePayload(
      codeModeNestedToolResultData(result),
      DEFAULT_MAX_BYTES - Buffer.byteLength(JSON.stringify(call)) - 512,
    );
    if ("value" in captured && isCodeModeJsonObject(captured.value)) {
      const candidate = { ...captured.value, isError };
      if (Value.Check(NestedToolResultSchema, candidate)) {
        completed.result = { content: candidate.content, isError };
        if (candidate.details !== undefined) completed.result.details = candidate.details;
        return completed;
      }
    }
    completed.resultPreview =
      "preview" in captured
        ? captured.preview
        : "Native replay unavailable: unsupported result content";
  } catch {
    completed.resultPreview = "Native replay unavailable: unsafe captured result";
  }
  return completed;
}

/** Reconstruct native tool rows from captured data without invoking any tool handlers. */
export function renderCodeModeNestedToolsTranscript(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: Persisted custom-entry data is validated before rendering.
  savedData: unknown,
  options: { readonly expanded: boolean; readonly outputPad?: number },
  theme: Pick<Theme, "fg" | "bold" | "bg">,
  getToolDefinition: (name: string) => NativeToolDefinition | undefined,
  requestRender: () => void = () => {},
): Component {
  const parsed = parseCodeModeJsonValue(savedData);
  const data = parsed.ok ? parsed.value : undefined;
  if (!Value.Check(CodeModeNestedToolsTranscriptSchema, data)) {
    return new Text("CodeMode nested tool display unavailable: invalid saved data", 0, 0);
  }
  const definitions = new Map<string, NativeToolDefinition>(
    [
      createBashToolDefinition(data.cwd),
      createEditToolDefinition(data.cwd),
      createFindToolDefinition(data.cwd),
      createGrepToolDefinition(data.cwd),
      createLsToolDefinition(data.cwd),
      createPowerShellToolDefinition(data.cwd),
      createReadToolDefinition(data.cwd),
      createWriteToolDefinition(data.cwd),
    ].map((definition) => [definition.name, definition]),
  );
  const container = new Container();
  container.addChild(
    new Text(
      theme.fg("muted", `Session ${data.sessionId} · Cell ${data.cellOrdinal}`),
      options.outputPad ?? 0,
      0,
    ),
  );
  // SAFETY: Pi 0.85.1 ToolExecutionComponent only uses ui.requestRender; this adapter cannot control a terminal.
  const ui = { requestRender } as TUI;
  for (const [callIndex, call] of data.calls.entries()) {
    const builtin = definitions.get(call.name);
    const registered = getToolDefinition(call.name);
    let definition = registered ?? builtin;
    if (definition !== undefined && builtin !== undefined) {
      definition = { ...definition };
      if (definition.renderCall === undefined && builtin.renderCall !== undefined) {
        definition.renderCall = builtin.renderCall;
      }
      if (definition.renderResult === undefined && builtin.renderResult !== undefined) {
        definition.renderResult = builtin.renderResult;
      }
      const renderCall = builtin.renderCall;
      if (
        call.name === "edit" &&
        renderCall !== undefined &&
        definition.renderCall === renderCall
      ) {
        // Replay uses the recorded diff, never a preview computed from today's filesystem.
        definition.renderCall = (...[args, nativeTheme, context]: Parameters<typeof renderCall>) =>
          renderCall(args, nativeTheme, { ...context, argsComplete: false });
      }
    }
    let result = call.result;
    if (
      call.outcome === "unknown" ||
      call.argsPreview !== undefined ||
      call.resultPreview !== undefined ||
      result === undefined
    ) {
      definition = {};
      const output = [
        call.outcome === "unknown" ? "outcome unknown" : `Outcome: ${call.outcome}`,
        call.spillPath === undefined ? "" : `Full output (live session): ${call.spillPath}`,
        call.argsPreview ?? JSON.stringify(call.args ?? {}, undefined, 2),
        call.resultPreview ?? (result === undefined ? "" : JSON.stringify(result, undefined, 2)),
      ]
        .filter(Boolean)
        .join("\n");
      result = { content: [{ type: "text", text: output }], isError: call.outcome !== "success" };
    }
    const row = new ToolExecutionComponent(
      call.name,
      call.callId,
      call.args ?? {},
      {},
      definition,
      ui,
      data.cwd,
    );
    row.updateResult(result);
    row.markExecutionStarted();
    row.setArgsComplete();
    row.setExpanded(options.expanded);
    let displayed = row;
    const fallback = (): ToolExecutionComponent => {
      const component = new ToolExecutionComponent(
        call.name,
        call.callId,
        call.args ?? {},
        {},
        {},
        ui,
        data.cwd,
      );
      component.updateResult({
        ...result,
        content: [{ type: "text", text: "[native renderer failed; fallback]" }, ...result.content],
      });
      component.setExpanded(options.expanded);
      return component;
    };
    container.addChild({
      render: (width) => {
        if (width <= 0) return [];
        const gutter = width > 3 ? 3 : 0;
        let lines: string[];
        try {
          lines = displayed.render(width - gutter);
        } catch {
          displayed = fallback();
          lines = displayed.render(width - gutter);
        }
        const branchLine = lines.findIndex(
          (line) => stripTerminalSequences(line).trim().length > 0,
        );
        const last = callIndex === data.calls.length - 1;
        return lines.map((line, index) => {
          const prefix =
            gutter === 0
              ? ""
              : index === branchLine
                ? last
                  ? "└─ "
                  : "├─ "
                : !last || index < branchLine
                  ? "│  "
                  : "   ";
          // Pi's compositor clips text by columns and leaves terminal image payloads untouched.
          const background = result.isError ? "toolErrorBg" : "toolSuccessBg";
          const gutterText = theme.bg(background, theme.fg("dim", prefix));
          // Paint padding here; the compositor's default padding has no background.
          const padding = theme.bg(
            background,
            " ".repeat(Math.max(0, width - gutter - visibleWidth(line))),
          );
          return compositeTuiLine(line, gutterText + line + padding, 0, width, width);
        });
      },
      invalidate: () => {
        try {
          displayed.invalidate();
        } catch {
          displayed = fallback();
        }
      },
      handleMouse: (event) => {
        const gutter = event.width > 3 ? 3 : 0;
        if (event.x < gutter) return undefined;
        try {
          return displayed.handleMouse({
            ...event,
            x: event.x - gutter,
            width: event.width - gutter,
          });
        } catch {
          displayed = fallback();
          return { handled: true, render: true };
        }
      },
    });
  }
  return container;
}
