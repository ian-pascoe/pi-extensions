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
import { createDapToolDefinitions, type DapToolRuntime } from "../src/dap-tool.js";

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
async function methodsReachedBy(operation: DapOperation): Promise<string[]> {
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
        return Promise.resolve(EMPTY_RESULT);
      },
    },
  ) as DapToolRuntime["session"];
  const runtime: DapToolRuntime = { session, sessionFiles: await createDapSessionFiles(directory) };
  const tool = createDapToolDefinitions(() => runtime).find(
    ({ name }) => name === `dap_${operation}`,
  );
  if (tool === undefined) throw new Error(`Missing dap_${operation}`);
  await tool.execute(
    "call",
    // SAFETY: MINIMAL_ARGUMENTS holds valid arguments for each tool.
    MINIMAL_ARGUMENTS[operation] as never,
    undefined,
    undefined,
    // SAFETY: Tool execution only reads cwd and the session id; this fixture supplies that surface.
    {
      cwd: directory,
      sessionManager: { getSessionId: () => "contract-test" },
    } as ExtensionToolContext,
  );
  return methods;
}

function tool(name: string) {
  const found = tools.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`Missing ${name}`);
  return found;
}

describe("DAP tool family", () => {
  test("declares one dap_<operation> tool per operation with its output schema, run sequentially", () => {
    expect(tools.map(({ name }) => name)).toEqual(
      DAP_OPERATIONS.map((operation) => `dap_${operation}`),
    );
    for (const operation of DAP_OPERATIONS) {
      const definition = tool(`dap_${operation}`);
      expect(definition.outputSchema).toBe(DapToolOutputSchemas[operation]);
      expect(definition.executionMode).toBe("sequential");
    }
  });

  test("annotates each tool by what it does to the Debuggee", async () => {
    for (const operation of DAP_OPERATIONS) {
      const definition = tool(`dap_${operation}`);
      const methods = await methodsReachedBy(operation);
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

  test("a dap_launch state failure returns isError and an error without desired_breakpoints", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-dap-contract-"));
    directories.push(directory);
    // SAFETY: The proxy answers the two Debug Session methods dap_launch reaches on a state failure.
    const session = new Proxy(
      {},
      {
        get: (_target, method) => () =>
          method === "snapshot"
            ? EMPTY_RESULT.snapshot
            : Promise.reject(
                new DapSessionError("state", "launch requires no active Debug Session"),
              ),
      },
    ) as DapToolRuntime["session"];
    const runtime: DapToolRuntime = {
      session,
      sessionFiles: await createDapSessionFiles(directory),
    };
    const launch = createDapToolDefinitions(() => runtime).find(
      ({ name }) => name === "dap_launch",
    );
    if (launch === undefined) throw new Error("Missing dap_launch");
    // SAFETY: Tool execution only reads cwd and the session id.
    const context = {
      cwd: directory,
      sessionManager: { getSessionId: () => "contract-test" },
    } as ExtensionToolContext;
    const result = await launch.execute("call", {}, undefined, undefined, context);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      state: "idle",
      error: "Pi DAP: DAP Session: launch requires no active Debug Session",
    });
  });

  test("serializes parameters without TypeBox modifier markers", () => {
    // Gemini rejects unknown schema keywords such as `~optional`, which TypeBox
    // leaves enumerable when a modifier wraps a plain object literal.
    for (const { name, parameters } of tools) {
      expect(JSON.stringify(parameters), name).not.toMatch(/"~/u);
    }
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
