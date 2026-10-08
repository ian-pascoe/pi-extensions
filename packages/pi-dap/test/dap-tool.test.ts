import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { afterEach, describe, expect, test, vi } from "vitest";
import type {
  DapEvaluateInput,
  DapLaunchInput,
  DapSessionResult,
  DapSessionSnapshot,
  DapSetBreakpointsInput,
  DapStackInput,
  DapVariablesInput,
} from "../src/dap-session.js";
import { DapProtocolClientError } from "../src/dap-protocol-client.js";
import { DapSessionError } from "../src/dap-session.js";
import { expectDapToolOutput } from "./dap-tool-output.js";
import { createDapSessionFiles } from "../src/dap-session-files.js";
import {
  DAP_OPERATIONS,
  DapToolResultDetailsSchema,
  type DapOperation,
  type DapToolCallArguments,
  type DapToolRenderDetails,
} from "../src/dap-tool-contract.js";
import { createDapToolDefinitions, type DapToolRuntime } from "../src/dap-tool.js";
import { TROUBLESHOOTING_HINT } from "../src/troubleshooting-skill.js";

const temporaryDirectories: string[] = [];

/** Arguments of any one DAP tool, as a model or hook may supply them. */
type DapToolInput = Omit<DapToolCallArguments, "operation">;

/** The execution surface every `dap_<operation>` tool shares. */
interface ExecutableDapTool {
  readonly name: string;
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Mirrors Pi's raw-argument hook, which the tool parses.
  readonly prepareArguments?: (input: unknown) => DapToolInput;
  execute(
    toolCallId: string,
    input: DapToolInput,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<DapToolRenderDetails | undefined> | undefined,
    context: ExtensionToolContext,
  ): Promise<AgentToolResult<DapToolRenderDetails | undefined>>;
}

function dapTool(
  getRuntime: () => DapToolRuntime | undefined,
  operation: DapOperation,
): ExecutableDapTool {
  const tool: ExecutableDapTool | undefined = createDapToolDefinitions(getRuntime).find(
    ({ name }) => name === `dap_${operation}`,
  );
  if (tool === undefined) throw new Error(`Missing dap_${operation}`);
  // Every executed result, including state failures and cancelled waits, must satisfy the
  // tool's declared outputSchema, because codemode hands scripts exactly that value.
  return {
    ...tool,
    async execute(toolCallId, input, signal, onUpdate, context) {
      const result = await tool.execute(toolCallId, input, signal, onUpdate, context);
      expectDapToolOutput(operation, result);
      return result;
    },
  };
}

type RecordedDapInput =
  | DapEvaluateInput
  | DapLaunchInput
  | DapSetBreakpointsInput
  | DapStackInput
  | DapVariablesInput;

interface RecordedCall {
  input?: RecordedDapInput;
  readonly name: string;
  signal?: AbortSignal;
}

class RecordingDapSession {
  readonly calls: RecordedCall[] = [];
  wait: Promise<void> | undefined;
  result: DapSessionResult = {
    snapshot: { state: "idle" },
    output: "",
    discardedOutputBytes: 0,
    desiredBreakpoints: [],
  };

  private async record(
    name: string,
    input?: RecordedDapInput,
    signal?: AbortSignal,
  ): Promise<DapSessionResult> {
    const call: RecordedCall = { name };
    if (input !== undefined) call.input = input;
    if (signal !== undefined) call.signal = signal;
    this.calls.push(call);
    await this.wait;
    return this.result;
  }

  launch(input: DapLaunchInput = {}, signal?: AbortSignal): Promise<DapSessionResult> {
    return this.record("launch", input, signal);
  }

  setBreakpoints(input: DapSetBreakpointsInput, signal?: AbortSignal): Promise<DapSessionResult> {
    return this.record("setBreakpoints", input, signal);
  }

  continue(signal?: AbortSignal): Promise<DapSessionResult> {
    return this.record("continue", undefined, signal);
  }

  next(signal?: AbortSignal): Promise<DapSessionResult> {
    return this.record("next", undefined, signal);
  }

  stepIn(signal?: AbortSignal): Promise<DapSessionResult> {
    return this.record("stepIn", undefined, signal);
  }

  stepOut(signal?: AbortSignal): Promise<DapSessionResult> {
    return this.record("stepOut", undefined, signal);
  }

  pause(signal?: AbortSignal): Promise<DapSessionResult> {
    return this.record("pause", undefined, signal);
  }

  stack(input: DapStackInput = {}, signal?: AbortSignal): Promise<DapSessionResult> {
    return this.record("stack", input, signal);
  }

  variables(input: DapVariablesInput, signal?: AbortSignal): Promise<DapSessionResult> {
    return this.record("variables", input, signal);
  }

  evaluate(input: DapEvaluateInput, signal?: AbortSignal): Promise<DapSessionResult> {
    return this.record("evaluate", input, signal);
  }

  status(): DapSessionResult {
    this.calls.push({ name: "status" });
    return this.result;
  }

  snapshot(): DapSessionSnapshot {
    return this.result.snapshot;
  }

  stop(): Promise<DapSessionResult> {
    return this.record("stop");
  }
}

async function createToolFixture(): Promise<{
  readonly context: ExtensionToolContext;
  readonly cwd: string;
  readonly runtime: DapToolRuntime;
  readonly session: RecordingDapSession;
}> {
  const cwd = await mkdtemp(resolve(tmpdir(), "pi-dap-tool-"));
  temporaryDirectories.push(cwd);
  const session = new RecordingDapSession();
  const sessionFiles = await createDapSessionFiles(cwd);
  // SAFETY: Tool execution only observes cwd; this fixture supplies that complete public surface.
  const context = { cwd } as ExtensionToolContext;
  return { context, cwd, runtime: { session, sessionFiles }, session };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("DAP tools", () => {
  test("return complete script-facing results beside bounded Observer UI details", async () => {
    const fixture = await createToolFixture();
    const longValue = "x".repeat(1_000);
    const output = "line\n".repeat(20_000);
    fixture.session.result = {
      snapshot: {
        state: "stopped",
        adapterId: "node",
        profileId: "node",
        stopReason: "breakpoint",
        threadId: 3,
      },
      output,
      discardedOutputBytes: 4,
      desiredBreakpoints: [
        { filePath: "/workspace/app.ts", breakpoints: [{ line: 2, condition: "ready" }] },
      ],
      variableGroups: [
        {
          scope: { name: "Locals", variablesReference: 5, expensive: false },
          variables: Array.from({ length: 25 }, (_, index) => ({
            name: `value-${index}`,
            value: longValue,
            type: "string",
            evaluateName: `value${index}`,
            variablesReference: 0,
          })),
        },
      ],
    };
    const result = await dapTool(() => fixture.runtime, "variables").execute(
      "variables",
      { frame_id: 1 },
      undefined,
      undefined,
      fixture.context,
    );
    expect(result.structuredContent).toEqual({
      state: "stopped",
      adapter_id: "node",
      profile_id: "node",
      stop_reason: "breakpoint",
      thread_id: 3,
      output,
      output_discarded_bytes: 4,
      scopes: [
        {
          name: "Locals",
          variables_reference: 5,
          expensive: false,
          variables: Array.from({ length: 25 }, (_, index) => ({
            name: `value-${index}`,
            value: longValue,
            type: "string",
            evaluate_name: `value${index}`,
            variables_reference: 0,
          })),
        },
      ],
    });
    // The model-facing text is truncated and the Observer UI rows are bounded; scripts lose nothing.
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Result Spill") });
    expect(result.details).toMatchObject({
      output_truncated: true,
      presentation: { omitted_count: 6 },
    });
  });

  test("project every operation-specific result into its typed output", async () => {
    const fixture = await createToolFixture();
    await writeFile(resolve(fixture.cwd, "app.ts"), "");
    const base = {
      snapshot: { state: "stopped", adapterId: "a", profileId: "p", stopReason: "step" },
      output: "",
      discardedOutputBytes: 0,
      desiredBreakpoints: [],
    } satisfies DapSessionResult;
    const cases: readonly [DapOperation, DapToolInput, DapSessionResult, object][] = [
      [
        "set_breakpoints",
        { file_path: "app.ts", breakpoints: [{ line: 4 }] },
        {
          ...base,
          breakpoints: [
            {
              id: 1,
              verified: true,
              line: 4,
              column: 2,
              source: { name: "app.ts", path: "/w/app.ts" },
            },
            { verified: false, message: "not loaded" },
          ],
        },
        {
          desired_breakpoints: [],
          breakpoints: [
            {
              id: 1,
              verified: true,
              line: 4,
              column: 2,
              source_name: "app.ts",
              source_path: "/w/app.ts",
            },
            { verified: false, message: "not loaded" },
          ],
        },
      ],
      [
        "stack",
        {},
        {
          ...base,
          stackFrames: [{ id: 7, name: "main", line: 3, column: 1, source: { path: "/w/app.ts" } }],
          totalFrames: 9,
        },
        {
          stack_frames: [{ id: 7, name: "main", line: 3, column: 1, source_path: "/w/app.ts" }],
          total_frames: 9,
        },
      ],
      [
        "variables",
        { variables_reference: 4 },
        { ...base, variables: [{ name: "a", value: "1", variablesReference: 0 }] },
        { variables: [{ name: "a", value: "1", variables_reference: 0 }] },
      ],
      [
        "evaluate",
        { expression: "a + 1" },
        { ...base, evaluation: { result: "2", type: "number", variablesReference: 0 } },
        { evaluation: { result: "2", type: "number", variables_reference: 0 } },
      ],
    ];
    for (const [operation, input, sessionResult, expected] of cases) {
      fixture.session.result = sessionResult;
      const result = await dapTool(() => fixture.runtime, operation).execute(
        operation,
        input,
        undefined,
        undefined,
        fixture.context,
      );
      expect(result.structuredContent).toEqual({
        state: "stopped",
        adapter_id: "a",
        profile_id: "p",
        stop_reason: "step",
        output: "",
        output_discarded_bytes: 0,
        ...expected,
      });
    }
  });

  test("structured results carry desired_breakpoints only for set_breakpoints, launch, and status", async () => {
    const fixture = await createToolFixture();
    fixture.session.result = {
      snapshot: { state: "stopped", adapterId: "a", profileId: "p", stopReason: "step" },
      output: "",
      discardedOutputBytes: 0,
      desiredBreakpoints: [
        { filePath: "/w/app.ts", breakpoints: [{ line: 2, condition: "ready" }] },
      ],
      stackFrames: [],
      variables: [],
    };
    const inputs = {
      launch: {},
      set_breakpoints: { file_path: "/w/app.ts", breakpoints: [{ line: 2, condition: "ready" }] },
      continue: {},
      next: {},
      step_in: {},
      step_out: {},
      pause: {},
      stack: {},
      variables: { variables_reference: 1 },
      evaluate: { expression: "x" },
      status: {},
      stop: {},
    } satisfies Record<DapOperation, DapToolInput>;
    const carriers: DapOperation[] = [];
    for (const operation of DAP_OPERATIONS) {
      const result = await dapTool(() => fixture.runtime, operation).execute(
        operation,
        inputs[operation],
        undefined,
        undefined,
        fixture.context,
      );
      if (Object.keys(result.structuredContent ?? {}).includes("desired_breakpoints")) {
        carriers.push(operation);
        expect(result.structuredContent).toMatchObject({
          desired_breakpoints: [
            { file_path: "/w/app.ts", breakpoints: [{ line: 2, condition: "ready" }] },
          ],
        });
      }
    }
    expect(carriers).toEqual(["launch", "set_breakpoints", "status"]);
  });

  describe("compact text results", () => {
    const stoppedSnapshot = {
      state: "stopped",
      adapterId: "node",
      profileId: "node",
      stopReason: "breakpoint",
      threadId: 1,
    } as const;

    async function textOf(
      operation: DapOperation,
      input: DapToolInput,
      result: Partial<DapSessionResult>,
    ): Promise<string> {
      const fixture = await createToolFixture();
      fixture.session.result = {
        snapshot: { state: "idle" },
        output: "",
        discardedOutputBytes: 0,
        desiredBreakpoints: [],
        ...result,
      };
      const executed = await dapTool(() => fixture.runtime, operation).execute(
        operation,
        input,
        undefined,
        undefined,
        fixture.context,
      );
      return executed.content.map((item) => (item.type === "text" ? item.text : "")).join("");
    }

    test("a stop names the top frame's file, line, and function, why it stopped, and the Breakpoints hit", async () => {
      const fixture = await createToolFixture();
      fixture.session.result = {
        snapshot: stoppedSnapshot,
        output: "hello\n",
        discardedOutputBytes: 0,
        desiredBreakpoints: [{ filePath: `${fixture.cwd}/app.js`, breakpoints: [{ line: 3 }] }],
        stop: {
          description: "Paused on breakpoint",
          hitBreakpointIds: [4],
          topFrame: {
            id: 12,
            name: "add",
            line: 3,
            column: 5,
            source: { name: "app.js", path: `${fixture.cwd}/app.js` },
          },
        },
      };

      const result = await dapTool(() => fixture.runtime, "continue").execute(
        "continue",
        {},
        undefined,
        undefined,
        fixture.context,
      );

      expect(result.content).toEqual([
        {
          type: "text",
          text: "stopped (breakpoint) at app.js:3:5 in add · thread 1\ndescription: Paused on breakpoint\nhit breakpoint ids: 4\n\nDebuggee output:\nhello\n",
        },
      ]);
      expect(result.structuredContent).toMatchObject({
        state: "stopped",
        stop_reason: "breakpoint",
        thread_id: 1,
        stop_description: "Paused on breakpoint",
        hit_breakpoint_ids: [4],
        top_frame: {
          id: 12,
          name: "add",
          line: 3,
          column: 5,
          source_name: "app.js",
          source_path: `${fixture.cwd}/app.js`,
        },
      });
      expect(result.structuredContent).not.toHaveProperty("desired_breakpoints");
    });

    test("a stop without a readable top frame still reports its reason", async () => {
      await expect(textOf("next", {}, { snapshot: stoppedSnapshot })).resolves.toBe(
        "stopped (breakpoint) · thread 1",
      );
    });

    test("an unexpanded expensive scope is listed with its reference to expand", async () => {
      const fixture = await createToolFixture();
      fixture.session.result = {
        snapshot: stoppedSnapshot,
        output: "",
        discardedOutputBytes: 0,
        desiredBreakpoints: [],
        variableGroups: [
          {
            scope: { name: "Local", variablesReference: 5, expensive: false },
            variables: [{ name: "a", value: "1", variablesReference: 0 }],
          },
          { scope: { name: "Global", variablesReference: 6, expensive: true } },
        ],
      };

      const result = await dapTool(() => fixture.runtime, "variables").execute(
        "variables",
        { frame_id: 1 },
        undefined,
        undefined,
        fixture.context,
      );

      expect(result.content).toEqual([
        {
          type: "text",
          text: [
            "Scope Local [variables_reference 5]: 1 variable",
            "  a = 1",
            "Scope Global [variables_reference 6] (expensive, not expanded; pass its variables_reference to expand)",
          ].join("\n"),
        },
      ]);
      expect(result.structuredContent).toMatchObject({
        scopes: [
          { name: "Local", variables: [{ name: "a", value: "1" }] },
          { name: "Global", variables_reference: 6, expensive: true },
        ],
      });
      expect(result.structuredContent).toMatchObject({
        scopes: [expect.anything(), expect.not.objectContaining({ variables: expect.anything() })],
      });
    });

    test("text over the limit is cut at line boundaries and is never empty", async () => {
      const fixture = await createToolFixture();
      const tool = dapTool(() => fixture.runtime, "status");
      const running = { state: "running", adapterId: "node", profileId: "node" } as const;

      // 5,000 lines of 20 bytes: the visible part is the first whole lines up to Pi's line limit.
      const manyLines = "0123456789abcdefghi\n".repeat(5_000);
      fixture.session.result = {
        snapshot: running,
        output: manyLines,
        discardedOutputBytes: 0,
        desiredBreakpoints: [],
      };
      const cutByLines = await tool.execute("lines", {}, undefined, undefined, fixture.context);
      const linesText = cutByLines.content[0]?.type === "text" ? cutByLines.content[0].text : "";
      const visibleLines = linesText.split("\n\n[Pi DAP: output truncated")[0] ?? "";
      expect(visibleLines.startsWith("running\n\nDebuggee output:\n0123456789abcdefghi")).toBe(
        true,
      );
      expect(
        visibleLines
          .split("\n")
          .every(
            (line) => line === "" || /^(running|Debuggee output:|0123456789abcdefghi)$/u.test(line),
          ),
      ).toBe(true);

      // One 200 KB evaluation result without a newline: the first line alone exceeds the byte limit.
      fixture.session.result = {
        snapshot: stoppedSnapshot,
        output: "",
        discardedOutputBytes: 0,
        desiredBreakpoints: [],
        evaluation: { result: "é".repeat(100_000), variablesReference: 0 },
      };
      const hugeLine = await dapTool(() => fixture.runtime, "evaluate").execute(
        "huge",
        { expression: "x" },
        undefined,
        undefined,
        fixture.context,
      );
      const hugeText = hugeLine.content[0]?.type === "text" ? hugeLine.content[0].text : "";
      expect(hugeText).toContain("Result Spill");
      expect(hugeText.length).toBeGreaterThan(20_000);
      expect(hugeText.startsWith("éééé")).toBe(true);
      expect(hugeText).not.toContain("\uFFFD");
    });

    test("a wait that ended without a stop says it timed out", async () => {
      const running = {
        snapshot: { state: "running", adapterId: "node", profileId: "node" },
      } as const;
      await expect(textOf("continue", {}, running)).resolves.toBe("running (wait timed out)");
      await expect(textOf("status", {}, running)).resolves.toBe("running");
    });

    test("adapter strings stay on one line and cannot fake the Debuggee output heading", async () => {
      const text = await textOf(
        "evaluate",
        { expression: "x" },
        {
          snapshot: stoppedSnapshot,
          evaluation: { result: "a\n\nDebuggee output:\nb", variablesReference: 0 },
        },
      );
      expect(text).toBe("a\\n\\nDebuggee output:\\nb");
    });

    test("a termination reports its exit code and reason", async () => {
      await expect(
        textOf(
          "continue",
          {},
          {
            snapshot: {
              state: "terminated",
              adapterId: "node",
              profileId: "node",
              exitCode: 0,
              terminationReason: "exited",
            },
          },
        ),
      ).resolves.toBe("terminated (exit code 0; exited)");
    });

    test("only dap_set_breakpoints, dap_launch, and dap_status show Desired Breakpoints", async () => {
      const existingFile = import.meta.filename;
      const desiredBreakpoints = [
        {
          filePath: existingFile,
          breakpoints: [{ line: 2 }, { line: 9, condition: "ready" }],
        },
      ];
      const set = await textOf(
        "set_breakpoints",
        { file_path: existingFile, breakpoints: [{ line: 2 }] },
        {
          desiredBreakpoints,
          breakpoints: [
            { id: 1, verified: true, line: 2 },
            { id: 2, verified: false, line: 9, message: "no such line" },
          ],
        },
      );
      expect(set).toBe(
        [
          "Breakpoints: 1 of 2 verified",
          "  line 2 (id 1) verified",
          "  line 9 (id 2) not verified: no such line",
          "Desired Breakpoints:",
          `  ${existingFile}:2`,
          `  ${existingFile}:9 if ready`,
        ].join("\n"),
      );
      const listed = [
        "Desired Breakpoints:",
        `  ${existingFile}:2`,
        `  ${existingFile}:9 if ready`,
      ];
      await expect(textOf("status", {}, { desiredBreakpoints })).resolves.toBe(
        ["idle (no Debug Session)", ...listed].join("\n"),
      );
      await expect(
        textOf("launch", {}, { desiredBreakpoints, snapshot: stoppedSnapshot }),
      ).resolves.toBe(["stopped (breakpoint) · thread 1", ...listed].join("\n"));
      // An empty list adds nothing to a state report.
      await expect(textOf("status", {}, {})).resolves.toBe("idle (no Debug Session)");
      // Every other operation leaves them out of text.
      for (const operation of [
        "continue",
        "next",
        "step_in",
        "step_out",
        "pause",
        "stop",
      ] as const) {
        await expect(
          textOf(operation, {}, { desiredBreakpoints, snapshot: stoppedSnapshot }),
        ).resolves.toBe("stopped (breakpoint) · thread 1");
      }
      expect(
        await textOf("set_breakpoints", { file_path: existingFile, breakpoints: [] }, {}),
      ).toBe(
        "Saved; breakpoints apply to the next launch (no active Debug Session).\nDesired Breakpoints: none",
      );
    });

    test("refused child sessions are named in the text, with what to do, and in structuredContent", async () => {
      const rejectedChildSessions = [
        {
          type: "pwa-node",
          name: "forks.js [42]",
          targetId: "t-1",
          message:
            'Pi DAP refused child session pwa-node "forks.js [42]" (target t-1): child debugging is unsupported, so breakpoints in it will not bind. The child runs without a debugger.',
        },
      ];
      const running = { snapshot: { state: "running", adapterId: "n", profileId: "p" } } as const;
      const text = await textOf("launch", {}, { ...running, rejectedChildSessions });
      expect(text).toBe(
        [
          "running (wait timed out)",
          `Warning: ${rejectedChildSessions[0]?.message}`,
          "To debug that code, launch it directly as the program; for child processes, launch_arguments { autoAttachChildProcesses: false } stops the adapter attaching them.",
        ].join("\n"),
      );
      await expect(textOf("status", {}, { ...running })).resolves.toBe("running");

      const fixture = await createToolFixture();
      fixture.session.result = {
        ...running,
        output: "",
        discardedOutputBytes: 0,
        desiredBreakpoints: [],
        rejectedChildSessions,
      };
      for (const operation of [
        "launch",
        "continue",
        "next",
        "step_in",
        "step_out",
        "pause",
        "status",
      ] as const) {
        const result = await dapTool(() => fixture.runtime, operation).execute(
          operation,
          {},
          undefined,
          undefined,
          fixture.context,
        );
        expectDapToolOutput(operation, result);
        expect(result.structuredContent).toMatchObject({
          rejected_child_sessions: [
            {
              type: "pwa-node",
              name: "forks.js [42]",
              target_id: "t-1",
              message: rejectedChildSessions[0]?.message,
            },
          ],
        });
      }
      const many = Array.from({ length: 7 }, (_, index) => ({
        message: `refused ${index}`,
      }));
      const manyText = await textOf("status", {}, { ...running, rejectedChildSessions: many });
      expect(manyText).toContain("Warning: refused 4\n");
      expect(manyText).not.toContain("refused 5");
      expect(manyText).toContain("Warning: 2 more child sessions refused");
    });

    test("stack, variables, and evaluate are one line per row and never raw JSON", async () => {
      const stack = await textOf(
        "stack",
        {},
        {
          snapshot: stoppedSnapshot,
          stackFrames: [
            { id: 12, name: "add", line: 3, column: 5, source: { path: "/elsewhere/app.js" } },
            { id: 13, name: "main", line: 9, column: 1 },
          ],
          totalFrames: 5,
        },
      );
      expect(stack).toBe(
        "Stack: 2 of 5 frames\n  frame 12: add at /elsewhere/app.js:3:5\n  frame 13: main at 9:1",
      );
      const variables = await textOf(
        "variables",
        { frame_id: 12 },
        {
          snapshot: stoppedSnapshot,
          variableGroups: [
            {
              scope: { name: "Local", variablesReference: 5, expensive: false },
              variables: [
                { name: "a", value: "1", type: "number", variablesReference: 0 },
                { name: "obj", value: "Object", variablesReference: 8 },
              ],
            },
          ],
        },
      );
      expect(variables).toBe(
        "Scope Local [variables_reference 5]: 2 variables\n  a: number = 1\n  obj = Object [variables_reference 8]",
      );
      const evaluation = await textOf(
        "evaluate",
        { expression: "a + 1" },
        {
          snapshot: stoppedSnapshot,
          evaluation: { result: "2", type: "number", variablesReference: 0 },
        },
      );
      expect(evaluation).toBe("2 (number)");
      for (const text of [stack, variables, evaluation]) expect(text).not.toMatch(/[{}"]/u);
    });
  });

  test("preserves exact ordinary, Debuggee output, and Result Spill text", async () => {
    const fixture = await createToolFixture();
    const tool = dapTool(() => fixture.runtime, "status");
    const ordinary = await tool.execute("ordinary", {}, undefined, undefined, fixture.context);
    expect(ordinary.content).toEqual([
      {
        type: "text",
        text: "idle (no Debug Session)",
      },
    ]);

    fixture.session.result = {
      snapshot: { state: "running", adapterId: "node", profileId: "node" },
      output: "debuggee\u001b[31m output\n",
      discardedOutputBytes: 7,
      desiredBreakpoints: [],
    };
    const withOutput = await tool.execute("output", {}, undefined, undefined, fixture.context);
    expect(withOutput.content).toEqual([
      {
        type: "text",
        text: "running\n\nDebuggee output (7 older bytes discarded):\ndebuggee\u001b[31m output\n",
      },
    ]);

    const oversizedOutput = "line\n".repeat(20_000);
    fixture.session.result = {
      snapshot: { state: "running", adapterId: "node", profileId: "node" },
      output: oversizedOutput,
      discardedOutputBytes: 0,
      desiredBreakpoints: [],
    };
    const raw = `running\n\nDebuggee output:\n${oversizedOutput}`;
    const truncation = truncateHead(raw, {
      maxBytes: DEFAULT_MAX_BYTES,
      maxLines: DEFAULT_MAX_LINES,
    });
    const spilled = await tool.execute("spilled", {}, undefined, undefined, fixture.context);
    if (spilled.details === undefined || "kind" in spilled.details) {
      throw new Error("Expected final DAP result details");
    }
    expect(spilled.content).toEqual([
      {
        type: "text",
        text: `${truncation.content}\n\n[Pi DAP: output truncated; complete Result Spill: ${spilled.details.spill_path}]`,
      },
    ]);
  });

  test("publishes immediate one-second progress only for execution waits and clears its timer", async () => {
    vi.useFakeTimers();
    const fixture = await createToolFixture();
    let release: () => void = () => undefined;
    fixture.session.wait = new Promise<void>((resolveWait) => {
      release = resolveWait;
    });
    const onUpdate = vi.fn();
    const execution = dapTool(() => fixture.runtime, "continue").execute(
      "continue",
      {},
      undefined,
      onUpdate,
      fixture.context,
    );
    expect(onUpdate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onUpdate).toHaveBeenCalledTimes(3);
    expect(onUpdate.mock.calls.map(([update]) => update.details)).toEqual([
      { kind: "progress", operation: "continue", elapsed_ms: 0 },
      { kind: "progress", operation: "continue", elapsed_ms: 1_000 },
      { kind: "progress", operation: "continue", elapsed_ms: 2_000 },
    ]);
    release();
    await execution;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onUpdate).toHaveBeenCalledTimes(3);

    fixture.session.wait = undefined;
    onUpdate.mockClear();
    await dapTool(() => fixture.runtime, "status").execute(
      "status",
      {},
      undefined,
      onUpdate,
      fixture.context,
    );
    expect(onUpdate).not.toHaveBeenCalled();
  });

  test("marks a cancelled execution wait in its text and structured result", async () => {
    const fixture = await createToolFixture();
    fixture.session.result = {
      snapshot: { state: "running", adapterId: "node", profileId: "node" },
      output: "",
      discardedOutputBytes: 0,
      desiredBreakpoints: [],
    };
    const controller = new AbortController();
    controller.abort();
    const result = await dapTool(() => fixture.runtime, "continue").execute(
      "cancelled",
      {},
      controller.signal,
      undefined,
      fixture.context,
    );
    expect(result.content).toEqual([
      {
        type: "text",
        text: "running (wait cancelled)",
      },
    ]);
    expect(result.details).toMatchObject({
      presentation: { kind: "execution_wait", operation: "continue", cancelled: true },
    });
    expect(result.structuredContent).toMatchObject({
      state: "running",
      execution_wait_cancelled: true,
    });
  });

  test("bounds presentation rows and values without bounding the raw result", async () => {
    const fixture = await createToolFixture();
    const longValue = "x".repeat(1_000);
    fixture.session.result = {
      snapshot: {
        state: "stopped",
        adapterId: "node",
        profileId: "node",
        stopReason: "breakpoint",
      },
      output: "",
      discardedOutputBytes: 0,
      desiredBreakpoints: [],
      variables: Array.from({ length: 25 }, (_, index) => ({
        name: `value-${index}`,
        value: longValue,
        variablesReference: 0,
      })),
    };
    const result = await dapTool(() => fixture.runtime, "variables").execute(
      "variables",
      { variables_reference: 1 },
      undefined,
      undefined,
      fixture.context,
    );
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining(longValue) });
    expect(result.details).toMatchObject({
      presentation: {
        kind: "variables",
        rows: expect.arrayContaining([expect.objectContaining({ value: `${"x".repeat(499)}…` })]),
        omitted_count: 5,
      },
    });
    if (
      result.details === undefined ||
      "kind" in result.details ||
      result.details.presentation?.kind !== "variables"
    ) {
      throw new Error("Expected variables presentation details");
    }
    expect(result.details.presentation.rows).toHaveLength(20);
  });

  test("rejects invalid arguments during preparation and execution before runtime or observers", async () => {
    const fixture = await createToolFixture();
    const observer = {
      onToolStart: vi.fn(),
      onToolSuccess: vi.fn(),
      onToolFailure: vi.fn(),
    };
    const getRuntime = vi.fn(() => ({ ...fixture.runtime, observer }));
    const cases: readonly [DapOperation, DapToolInput][] = [
      ["set_breakpoints", { file_path: "a.ts" }],
      ["set_breakpoints", { breakpoints: [] }],
      ["set_breakpoints", { file_path: "a.ts", breakpoints: [{ line: 0 }] }],
      ["evaluate", {}],
      ["variables", {}],
      ["variables", { frame_id: 0, variables_reference: 1 }],
      ["variables", { frame_id: -1 }],
      ["stack", { count: 0 }],
      // Fields of another operation are unknown to this tool.
      ["status", { expression: "x" }],
      ["continue", { thread_id: 0 }],
      ["launch", { file_path: "a.ts" }],
    ];
    for (const [operation, input] of cases) {
      const tool = dapTool(getRuntime, operation);
      expect(tool.prepareArguments).toBeTypeOf("function");
      expect(() => tool.prepareArguments?.(input)).toThrow("Pi DAP: invalid tool arguments");
      await expect(
        tool.execute("invalid", input, undefined, undefined, fixture.context),
      ).rejects.toThrow("Pi DAP: invalid tool arguments");
    }
    expect(getRuntime).not.toHaveBeenCalled();
    expect(observer.onToolStart).not.toHaveBeenCalled();
    expect(observer.onToolSuccess).not.toHaveBeenCalled();
    expect(observer.onToolFailure).not.toHaveBeenCalled();
    expect(fixture.session.calls).toEqual([]);
  });

  test("names what is wrong with invalid arguments instead of a bare parse failure", async () => {
    const fixture = await createToolFixture();
    const cases: readonly [DapOperation, DapToolInput, RegExp][] = [
      // Both selectors given: the strict ingress contract rejects it and says which field.
      [
        "variables",
        { frame_id: 0, variables_reference: 1 },
        /\/variables_reference is not allowed$/u,
      ],
      ["variables", {}, /arguments must have required properties frame_id$/u],
      ["evaluate", {}, /arguments must have required properties expression$/u],
      ["stack", { count: 0 }, /\/count must be >= 1$/u],
      ["status", { expression: "x" }, /\/expression is not allowed$/u],
    ];
    for (const [operation, input, reason] of cases) {
      const tool = dapTool(() => fixture.runtime, operation);
      expect(() => tool.prepareArguments?.(input), `${operation} ${JSON.stringify(input)}`).toThrow(
        reason,
      );
    }
  });

  test("never emits a field outside the tool's output schema", async () => {
    const fixture = await createToolFixture();
    // A session result carrying every optional field, as a misbehaving or newer Debug Session might.
    fixture.session.result = {
      snapshot: {
        state: "stopped",
        adapterId: "a",
        profileId: "p",
        stopReason: "step",
        threadId: 1,
      },
      output: "out",
      discardedOutputBytes: 1,
      desiredBreakpoints: [{ filePath: "/w/a.ts", breakpoints: [{ line: 1 }] }],
      breakpoints: [{ verified: true }],
      stackFrames: [{ id: 1, name: "main", line: 1, column: 1 }],
      totalFrames: 1,
      variableGroups: [
        {
          scope: { name: "Local", variablesReference: 2, expensive: false },
          variables: [{ name: "a", value: "1", variablesReference: 0 }],
        },
      ],
      variables: [{ name: "a", value: "1", variablesReference: 0 }],
      evaluation: { result: "1", variablesReference: 0 },
    };
    const inputs: readonly [DapOperation, DapToolInput][] = [
      ["launch", {}],
      ["set_breakpoints", { file_path: "a.ts", breakpoints: [] }],
      ["continue", {}],
      ["next", {}],
      ["step_in", {}],
      ["step_out", {}],
      ["pause", {}],
      ["stack", {}],
      ["variables", { frame_id: 1 }],
      ["evaluate", { expression: "a" }],
      ["status", {}],
      ["stop", {}],
    ];
    const expectedData = (operation: DapOperation): string[] => {
      switch (operation) {
        case "set_breakpoints":
          return ["breakpoints"];
        case "stack":
          return ["stack_frames", "total_frames"];
        case "variables":
          return ["scopes", "variables"];
        case "evaluate":
          return ["evaluation"];
        default:
          return [];
      }
    };
    for (const [operation, input] of inputs) {
      // dapTool asserts the output schema; here also check which data fields each tool keeps.
      const result = await dapTool(() => fixture.runtime, operation).execute(
        operation,
        input,
        undefined,
        undefined,
        fixture.context,
      );
      const data = Object.keys(result.structuredContent ?? {}).filter((key) =>
        [
          "breakpoints",
          "stack_frames",
          "total_frames",
          "scopes",
          "variables",
          "evaluation",
        ].includes(key),
      );
      expect(data, operation).toEqual(expectedData(operation));
    }
  });

  describe("dap_set_breakpoints for a source file that does not exist", () => {
    async function setBreakpoints(
      fixture: Awaited<ReturnType<typeof createToolFixture>>,
      input: DapToolInput,
    ) {
      return dapTool(() => fixture.runtime, "set_breakpoints").execute(
        "set-breakpoints",
        input,
        undefined,
        undefined,
        fixture.context,
      );
    }

    test("keeps the Desired Breakpoints and warns the model that they will not bind", async () => {
      const fixture = await createToolFixture();
      const missing = resolve(fixture.cwd, "src/missing.ts");
      const result = await setBreakpoints(fixture, {
        file_path: "src/missing.ts",
        breakpoints: [{ line: 3 }],
      });
      const warning = `file not found: ${missing}; breakpoints will not bind until it exists`;
      expect(fixture.session.calls).toEqual([
        {
          name: "setBreakpoints",
          input: { filePath: missing, breakpoints: [{ line: 3 }] },
        },
      ]);
      expect(result.isError).toBeUndefined();
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining(warning) });
      expect(result.structuredContent).toMatchObject({ warnings: [warning] });
    });

    test("does not warn when the file exists", async () => {
      const fixture = await createToolFixture();
      await writeFile(resolve(fixture.cwd, "app.ts"), "");
      const result = await setBreakpoints(fixture, {
        file_path: "app.ts",
        breakpoints: [{ line: 1 }],
      });
      expect(result.content[0]).toMatchObject({
        text: expect.not.stringContaining("file not found"),
      });
      expect(result.structuredContent).not.toHaveProperty("warnings");
    });

    test("warns that a directory is not a file", async () => {
      const fixture = await createToolFixture();
      await mkdir(resolve(fixture.cwd, "src"));
      const result = await setBreakpoints(fixture, {
        file_path: "src",
        breakpoints: [{ line: 1 }],
      });
      const warning = `not a file: ${resolve(fixture.cwd, "src")}; breakpoints will not bind`;
      expect(fixture.session.calls).toHaveLength(1);
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining(warning) });
      expect(result.structuredContent).toMatchObject({ warnings: [warning] });
    });

    test("does not warn when clearing its breakpoints", async () => {
      const fixture = await createToolFixture();
      const result = await setBreakpoints(fixture, {
        file_path: "src/missing.ts",
        breakpoints: [],
      });
      expect(result.content[0]).toMatchObject({
        text: expect.not.stringContaining("file not found"),
      });
      expect(result.structuredContent).not.toHaveProperty("warnings");
    });
  });

  test("dispatches all operations, maps paths, forwards cancellation, and validates details", async () => {
    const fixture = await createToolFixture();
    const controller = new AbortController();
    const observer = {
      onToolStart: vi.fn(),
      onToolSuccess: vi.fn(),
      onToolFailure: vi.fn(),
    };
    const runtime = { ...fixture.runtime, observer };
    const inputs: readonly [DapOperation, DapToolInput][] = [
      [
        "launch",
        {
          profile: "node",
          program: "src/app.ts",
          args: ["one"],
          cwd: "runtime",
          launch_arguments: { autoAttachChildProcesses: false, env: { A: "1" } },
        },
      ],
      [
        "set_breakpoints",
        { file_path: "src/app.ts", breakpoints: [{ line: 2, condition: "ready" }] },
      ],
      ["continue", {}],
      ["next", {}],
      ["step_in", {}],
      ["step_out", {}],
      ["pause", {}],
      ["stack", { thread_id: 7, start: 1, count: 2 }],
      ["variables", { frame_id: 9, start: 2, count: 3 }],
      ["variables", { variables_reference: 11 }],
      ["evaluate", { expression: "answer", frame_id: 9 }],
      ["status", {}],
      ["stop", {}],
    ];

    for (const [operation, input] of inputs) {
      const tool = dapTool(() => runtime, operation);
      expect(tool.prepareArguments?.(input)).toEqual(input);
      const result = await tool.execute(
        "dap-call",
        input,
        controller.signal,
        undefined,
        fixture.context,
      );
      expect(Value.Check(DapToolResultDetailsSchema, result.details)).toBe(true);
      expect(result.details).toMatchObject({ operation });
    }
    // The Observer UI still keys on the operation each tool performs.
    expect(observer.onToolStart.mock.calls.map(([parameters]) => parameters)).toEqual(
      inputs.map(([operation, input]) => ({ operation, ...input })),
    );
    expect(observer.onToolSuccess).toHaveBeenCalledTimes(inputs.length);

    expect(fixture.session.calls.map(({ name, input }) => ({ name, input }))).toEqual([
      {
        name: "launch",
        input: {
          profile: "node",
          program: resolve(fixture.cwd, "src/app.ts"),
          args: ["one"],
          cwd: resolve(fixture.cwd, "runtime"),
          launchArguments: { autoAttachChildProcesses: false, env: { A: "1" } },
        },
      },
      {
        name: "setBreakpoints",
        input: {
          filePath: resolve(fixture.cwd, "src/app.ts"),
          breakpoints: [{ line: 2, condition: "ready" }],
        },
      },
      { name: "continue", input: undefined },
      { name: "next", input: undefined },
      { name: "stepIn", input: undefined },
      { name: "stepOut", input: undefined },
      { name: "pause", input: undefined },
      { name: "stack", input: { threadId: 7, start: 1, count: 2 } },
      { name: "variables", input: { frameId: 9, start: 2, count: 3 } },
      { name: "variables", input: { variablesReference: 11 } },
      { name: "evaluate", input: { expression: "answer", frameId: 9 } },
      { name: "status", input: undefined },
      { name: "stop", input: undefined },
    ]);
    expect(
      fixture.session.calls
        .filter(({ name }) => name !== "status" && name !== "stop")
        .every(({ signal }) => signal === controller.signal),
    ).toBe(true);
  });

  test("omits absent dispatch fields without dropping zero IDs, offsets, or empty arguments", async () => {
    const fixture = await createToolFixture();
    const cases: [DapOperation, DapToolInput, RecordedDapInput, string[]][] = [
      ["launch", {}, {}, ["profile", "program", "args", "cwd", "launchArguments"]],
      ["launch", { args: [] }, { args: [] }, ["profile", "program", "cwd", "launchArguments"]],
      [
        "launch",
        { launch_arguments: {} },
        { launchArguments: {} },
        ["profile", "program", "args", "cwd"],
      ],
      ["stack", {}, {}, ["threadId", "start", "count"]],
      ["stack", { thread_id: 0, start: 0 }, { threadId: 0, start: 0 }, ["count"]],
      [
        "variables",
        { variables_reference: 0 },
        { variablesReference: 0 },
        ["frameId", "start", "count"],
      ],
      [
        "variables",
        { frame_id: 0, start: 0 },
        { frameId: 0, start: 0 },
        ["variablesReference", "count"],
      ],
      ["evaluate", { expression: "x" }, { expression: "x" }, ["frameId"]],
      ["evaluate", { expression: "x", frame_id: 0 }, { expression: "x", frameId: 0 }, []],
    ];
    for (const [operation, parameters, expected, absentFields] of cases) {
      await dapTool(() => fixture.runtime, operation).execute(
        "optional-fields",
        parameters,
        undefined,
        undefined,
        fixture.context,
      );
      const input = fixture.session.calls.at(-1)?.input;
      if (input === undefined) throw new Error("Expected recorded dispatch input");
      expect(input).toStrictEqual(expected);
      for (const field of absentFields) expect(Object.hasOwn(input, field)).toBe(false);
    }
  });

  test("points the model at the troubleshooting Skill only for failures it diagnoses", async () => {
    const fixture = await createToolFixture();
    const tool = dapTool(() => fixture.runtime, "launch");
    const adapterFailure = new DapSessionError("adapter", "launch failed: spawn ENOENT");
    const protocolCancelled = new DapProtocolClientError(
      "cancelled",
      "node",
      "/tmp/stderr.log",
      "launch request was cancelled",
    );
    const failures: readonly [Error, boolean][] = [
      [adapterFailure, true],
      [new DapSessionError("configuration", "launch requires a valid Launch Profile"), true],
      [new DapProtocolClientError("exit", "node", "/tmp/stderr.log", "adapter exited"), true],
      [new DapProtocolClientError("timeout", "node", "/tmp/stderr.log", "timed out"), true],
      [
        new DapProtocolClientError("request", "node", "/tmp/stderr.log", "evaluate request failed"),
        false,
      ],
      [protocolCancelled, false],
      [
        new DapSessionError("adapter", "launch was cancelled and cleaned up", {
          cause: protocolCancelled,
        }),
        false,
      ],
    ];
    for (const [failure, hinted] of failures) {
      vi.spyOn(fixture.session, "launch").mockRejectedValueOnce(failure);
      const error = await tool.execute("failure", {}, undefined, undefined, fixture.context).then(
        () => undefined,
        (cause: unknown) => cause,
      );
      if (!(error instanceof Error)) throw new Error("Expected launch to fail");
      expect(error.message.startsWith("Pi DAP: ")).toBe(true);
      expect(error.message.includes(TROUBLESHOOTING_HINT)).toBe(hinted);
      if (hinted) expect(error.message).toContain(`\n\n${TROUBLESHOOTING_HINT}`);
    }
  });

  test("reports a Debug Session state failure as an error result that keeps the current state", async () => {
    const fixture = await createToolFixture();
    const observer = {
      onToolStart: vi.fn(),
      onToolSuccess: vi.fn(),
      onToolFailure: vi.fn(),
    };
    fixture.session.result = {
      snapshot: {
        state: "terminated",
        adapterId: "node",
        profileId: "node",
        exitCode: 3,
        terminationReason: "exited",
      },
      output: "unread",
      discardedOutputBytes: 0,
      desiredBreakpoints: [],
    };
    vi.spyOn(fixture.session, "stack").mockRejectedValueOnce(
      new DapSessionError("state", "stack requires a stopped Debuggee"),
    );
    const result = await dapTool(() => ({ ...fixture.runtime, observer }), "stack").execute(
      "state",
      {},
      undefined,
      undefined,
      fixture.context,
    );
    const state = {
      state: "terminated",
      adapter_id: "node",
      profile_id: "node",
      exit_code: 3,
      termination_reason: "exited",
    };
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: `Pi DAP: DAP Session: stack requires a stopped Debuggee\nDebug Session: ${JSON.stringify(state)}`,
        },
      ],
      details: undefined,
      structuredContent: {
        ...state,
        error: "Pi DAP: DAP Session: stack requires a stopped Debuggee",
      },
      isError: true,
    });
    expect(result.content[0]).not.toMatchObject({
      text: expect.stringContaining(TROUBLESHOOTING_HINT),
    });
    expect(observer.onToolFailure).toHaveBeenCalledOnce();
    expect(observer.onToolSuccess).not.toHaveBeenCalled();
    // The state comes from the snapshot: a failed call does not drain unread Debuggee output.
    expect(fixture.session.calls.map(({ name }) => name)).not.toContain("status");
  });

  test("reparses hook-mutated input before effects and spills complete oversized output", async () => {
    const fixture = await createToolFixture();
    await expect(
      dapTool(() => fixture.runtime, "continue").execute(
        "invalid",
        { thread_id: 1 },
        undefined,
        undefined,
        fixture.context,
      ),
    ).rejects.toThrow("Pi DAP: invalid tool arguments");
    expect(fixture.session.calls).toEqual([]);

    fixture.session.result = {
      snapshot: {
        state: "stopped",
        adapterId: "node",
        profileId: "node",
        stopReason: "breakpoint",
        threadId: 7,
      },
      output: "x".repeat(60 * 1024),
      discardedOutputBytes: 12,
      desiredBreakpoints: [],
      stackFrames: [{ id: 42, name: "main", line: 0, column: 0 }],
    };
    const result = await dapTool(() => fixture.runtime, "stack").execute(
      "spilled",
      {},
      undefined,
      undefined,
      fixture.context,
    );
    expect(result.details).toMatchObject({
      operation: "stack",
      state: "stopped",
      adapter_id: "node",
      profile_id: "node",
      stop_reason: "breakpoint",
      thread_id: 7,
      stack_frame_ids: [42],
      output_discarded_bytes: 12,
      output_truncated: true,
      spill_path: expect.any(String),
    });
    if (result.details === undefined || "kind" in result.details) {
      throw new Error("Expected final DAP result details");
    }
    if (result.details.spill_path === undefined) throw new Error("Expected Result Spill path");
    expect(await readFile(result.details.spill_path, "utf8")).toContain("x".repeat(60 * 1024));
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("complete Result Spill"),
    });
  });
});
