import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { afterEach, describe, expect, test } from "vitest";
import { DapSessionError, type DapSessionResult } from "../src/dap-session.js";
import { createDapSessionFiles } from "../src/dap-session-files.js";
import {
  DAP_OPERATIONS,
  DapToolOutputSchemas,
  type DapOperation,
} from "../src/dap-tool-contract.js";
import {
  createDapToolDefinitions,
  DAP_TOOL_NAMESPACE,
  type DapToolRuntime,
} from "../src/dap-tool.js";

const tools = createDapToolDefinitions(() => undefined);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** Minimal valid arguments of each tool. */
const MINIMAL_ARGUMENTS = {
  launch: {},
  set_breakpoints: { file_path: "a.ts", breakpoints: [{ line: 1 }] },
  continue: {},
  next: {},
  step_in: {},
  step_out: {},
  pause: {},
  stack: {},
  variables: { frame_id: 0 },
  evaluate: { expression: "x" },
  status: {},
  stop: {},
};

/** Debug Session methods that only observe the Debuggee. */
const OBSERVING_METHODS = new Set(["stack", "variables", "status", "snapshot"]);
/** Debug Session methods that start or resume the Debuggee, so its program runs. */
const RUNNING_METHODS = new Set(["launch", "continue", "next", "stepIn", "stepOut", "evaluate"]);

const EMPTY_RESULT: DapSessionResult = {
  snapshot: { state: "idle" },
  output: "",
  discardedOutputBytes: 0,
  desiredBreakpoints: [],
};

/** Run one tool against a session that records which Debug Session methods it reaches. */
async function methodsReachedBy(
  operation: DapOperation,
  outcome: "succeed" | "fail-state",
): Promise<{ methods: string[]; isError: boolean }> {
  const methods: string[] = [];
  const directory = await mkdtemp(join(tmpdir(), "pi-dap-contract-"));
  directories.push(directory);
  // SAFETY: The proxy answers every Debug Session method a tool can reach.
  const session = new Proxy(
    {},
    {
      get: (_target, method) => () => {
        methods.push(String(method));
        if (method === "snapshot") return EMPTY_RESULT.snapshot;
        if (outcome === "fail-state") {
          return Promise.reject(new DapSessionError("state", `${String(method)} not allowed`));
        }
        return Promise.resolve(EMPTY_RESULT);
      },
    },
  ) as DapToolRuntime["session"];
  const runtime: DapToolRuntime = { session, sessionFiles: await createDapSessionFiles(directory) };
  const tool = createDapToolDefinitions(() => runtime).find(
    ({ name }) => name === `dap_${operation}`,
  );
  if (tool === undefined) throw new Error(`Missing dap_${operation}`);
  const result = await tool.execute(
    "call",
    // SAFETY: MINIMAL_ARGUMENTS holds valid arguments for each tool.
    MINIMAL_ARGUMENTS[operation] as never,
    undefined,
    undefined,
    // SAFETY: Tool execution only reads cwd; this fixture supplies that surface.
    { cwd: directory } as ExtensionToolContext,
  );
  return { methods, isError: result.isError === true };
}

function tool(name: string) {
  const found = tools.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`Missing ${name}`);
  return found;
}

describe("DAP tool family", () => {
  test("registers one dap_<operation> tool per operation in one namespace", () => {
    expect(tools.map(({ name }) => name)).toEqual(
      DAP_OPERATIONS.map((operation) => `dap_${operation}`),
    );
    for (const [index, definition] of tools.entries()) {
      const operation = DAP_OPERATIONS[index];
      if (operation === undefined) throw new Error("Missing operation");
      expect(definition.namespace).toBe(DAP_TOOL_NAMESPACE);
      expect(definition.outputSchema).toBe(DapToolOutputSchemas[operation]);
      expect(definition.executionMode).toBe("sequential");
      expect(definition.promptGuidelines).toEqual(tools[0]?.promptGuidelines);
    }
    expect(DAP_TOOL_NAMESPACE).toMatchObject({ name: "dap" });
    expect(DAP_TOOL_NAMESPACE.instructions).toContain("same single Debug Session");
    // One snippet keeps the system prompt's tool list to one DAP line.
    expect(tools.filter((definition) => definition.promptSnippet !== undefined)).toEqual([
      tool("dap_launch"),
    ]);
  });

  test("declares every tool directly", () => {
    expect(tools.map(({ name, exposure }) => [name, exposure])).toEqual(
      DAP_OPERATIONS.map((operation) => [`dap_${operation}`, "direct"]),
    );
  });

  test("annotates each tool by what it does to the Debuggee", async () => {
    for (const operation of DAP_OPERATIONS) {
      const definition = tool(`dap_${operation}`);
      const { methods } = await methodsReachedBy(operation, "succeed");
      const annotations = definition.annotations;
      const label = `dap_${operation} (reaches ${methods.join(", ")})`;
      const runsDebuggee = methods.some((method) => RUNNING_METHODS.has(method));
      const onlyObserves = methods.every((method) => OBSERVING_METHODS.has(method));
      // A condition or expression argument is Debuggee code even if the tool only forwards it.
      const carriesDebuggeeCode = /"(condition|expression)":/u.test(
        JSON.stringify(definition.parameters),
      );

      expect(annotations?.readOnlyHint === true, `${label} read-only`).toBe(onlyObserves);
      if (onlyObserves) {
        expect(annotations, label).toMatchObject({
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        });
      }
      if (runsDebuggee || carriesDebuggeeCode) {
        // Running or evaluating program code can do anything the Debuggee can.
        expect(annotations, label).toMatchObject({
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: true,
        });
      }
      if (runsDebuggee) {
        // Resuming or launching again does something new each time.
        expect(annotations?.idempotentHint, label).toBe(false);
      }
    }
  });

  test("annotates the tools whose behavior is not a code-running or observing one", () => {
    const annotations = (name: string) => tool(name).annotations;
    // Replacing a file's Desired Breakpoints with the same list changes nothing more, but a
    // condition is code the Debuggee will run.
    expect(annotations("dap_set_breakpoints")).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
    // Pausing a paused Debuggee, or stopping a stopped one, is a no-op; pause kills nothing.
    expect(annotations("dap_pause")).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(annotations("dap_stop")).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  test("tells models and scripts about the state-failure result in each description", async () => {
    // These never reject because of the Debug Session state.
    const neverStateFailing: readonly DapOperation[] = ["set_breakpoints", "status", "stop"];
    for (const operation of DAP_OPERATIONS) {
      if (neverStateFailing.includes(operation)) continue;
      const { isError } = await methodsReachedBy(operation, "fail-state");
      expect(isError, `dap_${operation} returns a state-failure result`).toBe(true);
      expect(tool(`dap_${operation}`).description, `dap_${operation}`).toMatch(
        /error result with the current `state`/u,
      );
    }
    for (const schema of Object.values(DapToolOutputSchemas)) {
      expect(schema.properties.error).toMatchObject({
        description: expect.stringContaining("current state"),
      });
    }
  });

  test("registers plain object parameters holding only each operation's fields", () => {
    const fields = Object.fromEntries(
      tools.map(({ name, parameters }) => {
        expect(parameters.type).toBe("object");
        expect(Object.hasOwn(parameters, "anyOf")).toBe(false);
        expect(parameters).toMatchObject({ additionalProperties: false });
        return [name, [Object.keys(parameters.properties), parameters.required ?? []]];
      }),
    );
    expect(fields).toEqual({
      dap_launch: [["profile", "program", "args", "cwd"], []],
      dap_set_breakpoints: [
        ["file_path", "breakpoints"],
        ["file_path", "breakpoints"],
      ],
      dap_continue: [[], []],
      dap_next: [[], []],
      dap_step_in: [[], []],
      dap_step_out: [[], []],
      dap_pause: [[], []],
      dap_stack: [["thread_id", "start", "count"], []],
      dap_variables: [["frame_id", "variables_reference", "start", "count"], []],
      dap_evaluate: [["expression", "frame_id"], ["expression"]],
      dap_status: [[], []],
      dap_stop: [[], []],
    });
    expect(tool("dap_variables").description).toContain(
      "Exactly one of frame_id (every scope of a Stack Frame) or variables_reference (children of a value) is required, never both",
    );
  });

  test("keeps variables selector exclusivity inside the tool", () => {
    const variables = tool("dap_variables");
    // The provider-facing object admits both selectors; the strict ingress parser does not.
    expect(Value.Check(variables.parameters, { frame_id: 1, variables_reference: 2 })).toBe(true);
    expect(() => variables.prepareArguments?.({ frame_id: 1, variables_reference: 2 })).toThrow(
      "Pi DAP: invalid tool arguments",
    );
    expect(() => variables.prepareArguments?.({})).toThrow("Pi DAP: invalid tool arguments");
    expect(variables.prepareArguments?.({ frame_id: 0, count: 2 })).toEqual({
      frame_id: 0,
      count: 2,
    });
  });
});
