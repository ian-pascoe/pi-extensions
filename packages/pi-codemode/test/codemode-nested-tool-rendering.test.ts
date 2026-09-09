import {
  createReadToolDefinition,
  initTheme,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  Text,
  visibleWidth,
  type Component,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, test } from "vitest";
import {
  captureCodeModeNestedToolCall,
  completeCodeModeNestedToolCall,
  renderCodeModeNestedToolsTranscript,
} from "../src/codemode-nested-tool-rendering.js";

const theme: Pick<Theme, "fg" | "bold" | "bg"> = {
  fg: (_color, text) => text,
  bold: (text) => text,
  bg: (_color, text) => text,
};

beforeAll(() => initTheme("dark"));

function renderText(component: Component): string {
  return component
    .render(100)
    .map((line) => stripTerminalSequences(line).trimEnd())
    .join("\n");
}

describe("nested CodeMode Transcript rendering", () => {
  test.each([false, true])(
    "paints the tree gutter with the native row background (isError=%s)",
    (isError) => {
      const call = completeCodeModeNestedToolCall(
        captureCodeModeNestedToolCall("call", "test", {}),
        {
          content: [{ type: "text", text: "saved output" }],
          details: undefined,
        },
        isError,
      );
      const coloredTheme = {
        ...theme,
        bg: (color: string, text: string) =>
          `\u001b[48;5;${color === "toolErrorBg" ? 1 : 2}m${text}\u001b[49m`,
      };
      const component = renderCodeModeNestedToolsTranscript(
        { version: 1, sessionId: "gutter", cellOrdinal: 1, cwd: "/unused", calls: [call] },
        { expanded: false },
        coloredTheme,
        () => undefined,
      );
      const lines = component.render(60);
      expect(lines.some((line) => line.includes(`\u001b[48;5;${isError ? 1 : 2}m└─ `))).toBe(true);
      expect(lines.find((line) => stripTerminalSequences(line).includes("saved output"))).toContain(
        `\u001b[48;5;${isError ? 1 : 2}m   `,
      );
    },
  );

  test("adds tree gutters while preserving native width, image payloads, and click expansion", () => {
    const image = "\u001b_Ga=T,f=100;AAAA\u001b\\";
    const clicks: TuiMouseEvent[] = [];
    const definition: ToolDefinition = {
      name: "native",
      label: "Native",
      description: "Native tree test",
      parameters: Type.Object({}),
      execute: async () => {
        throw new Error("must not execute");
      },
      renderShell: "self",
      renderCall: (_args, _theme, context) => new Text(context.toolCallId, 0, 0),
      renderResult: (_result, _options, _theme, context) => ({
        render: (width) => ["x".repeat(width), ...(context.expanded ? ["expanded"] : []), image],
        invalidate: () => {},
        handleMouse: (event) => {
          clicks.push(event);
          return undefined;
        },
      }),
    };
    const calls = ["first", "second"].map((id) =>
      completeCodeModeNestedToolCall(
        captureCodeModeNestedToolCall(id, "native", {}),
        { content: [], details: undefined },
        false,
      ),
    );
    const component = renderCodeModeNestedToolsTranscript(
      { version: 1, sessionId: "s", cellOrdinal: 1, cwd: "/unused", calls },
      { expanded: false },
      theme,
      () => definition,
    );
    const lines = component.render(40);
    const plain = lines.map(stripTerminalSequences);
    expect(plain).toContain("├─ first" + " ".repeat(32));
    expect(plain).toContain("└─ second" + " ".repeat(31));
    expect(plain).toContain("│  " + "x".repeat(37));
    expect(lines.filter((line) => line.includes("\u001b_G"))).toEqual([image, image]);
    component.handleMouse?.({
      type: "click",
      button: "left",
      x: 5,
      y: 3,
      screenX: 5,
      screenY: 3,
      width: 40,
      height: lines.length,
      shift: false,
      alt: false,
      ctrl: false,
    });
    expect(clicks[0]).toMatchObject({ x: 2, y: 0, width: 37 });
    expect(renderText(component)).toContain("expanded");
    for (const width of [1, 3, 8, 40]) {
      expect(
        component
          .render(width)
          .filter((line) => !line.includes("\u001b_G"))
          .every((line) => visibleWidth(line) <= width),
      ).toBe(true);
    }
  });

  test("captures immutable arguments and native result details for later replay", () => {
    const args = { path: "saved.ts", edits: [{ oldText: "old", newText: "new" }] };
    const result = {
      content: [{ type: "text" as const, text: "done" }],
      details: { diff: "-1 old\n+1 new" },
    };
    const started = captureCodeModeNestedToolCall("call-1", "edit", args);
    const completed = completeCodeModeNestedToolCall(started, result, false);
    args.path = "changed.ts";
    result.details.diff = "changed";
    expect(started.outcome).toBe("unknown");
    expect(completed).toMatchObject({
      outcome: "success",
      args: { path: "saved.ts" },
      result: { details: { diff: "-1 old\n+1 new" }, isError: false },
    });
  });
  test("keeps a bounded preview and explicit native fallback for oversized results", () => {
    const call = completeCodeModeNestedToolCall(
      captureCodeModeNestedToolCall("large-read", "read", { path: "large.txt" }),
      {
        content: [{ type: "text", text: "preview-start " + "x".repeat(80_000) }],
        details: undefined,
      },
      false,
    );
    const output = renderText(
      renderCodeModeNestedToolsTranscript(
        {
          version: 1,
          sessionId: "large",
          cellOrdinal: 1,
          cwd: "/unused",
          calls: [call],
        },
        { expanded: true },
        theme,
        () => undefined,
      ),
    );
    expect(call.result).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(call))).toBeLessThan(52_000);
    expect(output).toContain("preview-start");
    expect(output).toContain("truncated");
    expect(output).toContain("native replay unavailable");
    expect(output).not.toContain("outcome unknown");
  });

  test("contains a broken native renderer without hiding another recorded call", () => {
    const definition: ToolDefinition = {
      name: "broken",
      label: "Broken",
      description: "Broken renderer",
      parameters: Type.Object({}),
      execute: async () => {
        throw new Error("must not execute during replay");
      },
      renderResult: () => ({
        render: () => {
          throw new Error("renderer broke");
        },
        invalidate: () => {},
      }),
    };
    const calls = ["broken", "healthy"].map((name) =>
      completeCodeModeNestedToolCall(
        captureCodeModeNestedToolCall(name, name, {}),
        { content: [{ type: "text", text: `${name} saved output` }], details: undefined },
        false,
      ),
    );
    const component = renderCodeModeNestedToolsTranscript(
      { version: 1, sessionId: "renderer-errors", cellOrdinal: 1, cwd: "/unused", calls },
      { expanded: false },
      theme,
      (name) => (name === "broken" ? definition : undefined),
    );
    expect(renderText(component)).toContain("broken saved output");
    expect(renderText(component)).toContain("healthy saved output");
    expect(renderText(component)).toContain("native renderer failed");
  });

  test("captures only presentation fields without reading unrelated result metadata", () => {
    let metadataReads = 0;
    const result = {
      content: [{ type: "text" as const, text: "retained output" }],
      details: { saved: true },
      get usage(): never {
        metadataReads += 1;
        throw new Error("not presentation data");
      },
    };
    const completed = completeCodeModeNestedToolCall(
      captureCodeModeNestedToolCall("metadata", "custom", {}),
      result,
      false,
    );
    expect(completed.result?.content).toEqual([{ type: "text", text: "retained output" }]);
    expect(metadataReads).toBe(0);
  });

  test("rejects malformed and cyclic saved data without evaluating accessors", () => {
    const cyclic = {};
    Object.defineProperty(cyclic, "loop", { value: cyclic, enumerable: true });
    let getterReads = 0;
    const accessor = {
      get version() {
        getterReads += 1;
        return 1;
      },
    };
    for (const data of [
      null,
      {},
      accessor,
      {
        version: 1,
        sessionId: "invalid",
        cellOrdinal: 1,
        cwd: "/unused",
        calls: [{ name: "read", callId: "cyclic", outcome: "unknown", args: cyclic }],
      },
    ]) {
      expect(
        renderText(
          renderCodeModeNestedToolsTranscript(data, { expanded: true }, theme, () => undefined),
        ),
      ).toContain("invalid saved data");
    }
    expect(getterReads).toBe(0);
  });

  test("inherits missing native slots, honors expansion, and protects saved arguments", () => {
    const definition = createReadToolDefinition("/unused");
    definition.execute = async () => {
      throw new Error("must not execute during replay");
    };
    definition.renderCall = (args, _theme, context) => {
      args.path = "renderer-mutated.txt";
      return new Text(`custom read ${context.toolCallId}`, 0, 0);
    };
    delete definition.renderResult;
    const call = completeCodeModeNestedToolCall(
      captureCodeModeNestedToolCall("read-1", "read", { path: "original.txt" }),
      { content: [{ type: "text", text: "saved native read output" }], details: undefined },
      false,
    );
    const data = { version: 1, sessionId: "expand", cellOrdinal: 1, cwd: "/unused", calls: [call] };
    const collapsed = renderText(
      renderCodeModeNestedToolsTranscript(data, { expanded: false }, theme, () => definition),
    );
    const expanded = renderText(
      renderCodeModeNestedToolsTranscript(data, { expanded: true }, theme, () => definition),
    );
    expect(collapsed).toContain("custom read read-1");
    expect(collapsed).not.toContain("saved native read output");
    expect(expanded).toContain("saved native read output");
    expect(call.args?.path).toBe("original.txt");
  });

  test("keeps unknown and unavailable tools visible in invocation order", () => {
    const unknown = captureCodeModeNestedToolCall("first", "unfinished-edit", {
      path: "first.txt",
    });
    const completed = completeCodeModeNestedToolCall(
      captureCodeModeNestedToolCall("second", "removed-extension", { path: "second.txt" }),
      { content: [{ type: "text", text: "saved second output" }], details: undefined },
      false,
    );
    const output = renderText(
      renderCodeModeNestedToolsTranscript(
        {
          version: 1,
          sessionId: "ordering",
          cellOrdinal: 4,
          cwd: "/unused",
          calls: [unknown, completed],
        },
        { expanded: false },
        theme,
        () => undefined,
      ),
    );
    expect(output).toContain("outcome unknown");
    expect(output).toContain("first.txt");
    expect(output).toContain("saved second output");
    expect(output.indexOf("unfinished-edit")).toBeLessThan(output.indexOf("removed-extension"));
  });

  test("falls back safely for multiline, cyclic, and accessor-bearing arguments or results", () => {
    let getterReads = 0;
    const unsafe = {
      get dangerous() {
        getterReads += 1;
        throw new Error("must not read getter");
      },
    };
    const argumentCall = captureCodeModeNestedToolCall("unsafe", "custom", unsafe);
    expect(argumentCall.argsPreview).toContain("unsafe");
    const longLines = completeCodeModeNestedToolCall(
      captureCodeModeNestedToolCall("lines", "custom", {}),
      { content: [{ type: "text", text: "line\n".repeat(2_001) }], details: unsafe },
      true,
    );
    expect(longLines.resultPreview).toContain("unsafe");
    const linesOnly = completeCodeModeNestedToolCall(
      captureCodeModeNestedToolCall("lines", "custom", {}),
      { content: [{ type: "text", text: "line\n".repeat(2_001) }], details: undefined },
      false,
    );
    expect(linesOnly.resultPreview).toContain("truncated");
    expect(linesOnly.result).toBeUndefined();
    expect(getterReads).toBe(0);
  });

  test("replays the captured native edit diff below its Cell label", () => {
    const data = JSON.parse(
      JSON.stringify({
        version: 1,
        sessionId: "session-alpha",
        cellOrdinal: 3,
        cwd: "/not-a-live-workspace",
        calls: [
          {
            callId: "edit-1",
            name: "edit",
            args: { path: "example.ts", edits: [{ oldText: "old", newText: "new" }] },
            outcome: "success",
            result: {
              content: [{ type: "text", text: "Successfully replaced 1 block(s)" }],
              details: { diff: "-1 old\n+1 new", firstChangedLine: 1 },
              isError: false,
            },
          },
        ],
      }),
    );

    const output = renderText(
      renderCodeModeNestedToolsTranscript(data, { expanded: false }, theme, () => undefined),
    );
    expect(output).toContain("Session session-alpha · Cell 3");
    expect(output).toContain("edit");
    expect(output).toContain("example.ts");
    expect(output).toMatch(/└─ .*edit/);
    expect(output).toContain("-1 old");
    expect(output).toContain("+1 new");
    expect(output).not.toContain("Successfully replaced");
  });
});
