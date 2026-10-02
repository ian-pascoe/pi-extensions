import type { JsonValue } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test } from "vitest";
import { TermctrlRegistry } from "../src/termctrl-registry.js";
import { FakeDriverFactory } from "./fake-driver.js";
import { createSdkFixture, disposeSdkFixtures, settle } from "./sdk-fixture.js";

const available = { kind: "available", path: "/fake/termctrl" } as const;

afterEach(async () => {
  await disposeSdkFixtures();
  await TermctrlRegistry.teardownForTests();
});

/** Register the same tools without `annotations`, as an unannotated build of the extension would. */
function withoutAnnotations(factory: ExtensionFactory): ExtensionFactory {
  return (pi) => {
    const unannotated: ExtensionAPI = Object.create(pi);
    Object.defineProperty(unannotated, "registerTool", {
      value: (tool: ToolDefinition) => {
        const { annotations: _omitted, ...rest } = tool;
        pi.registerTool(rest);
      },
    });
    return factory(unannotated);
  };
}

/** Timestamps and the temporary directory are noise between two otherwise identical runs. */
function normalized<T>(value: T, directory: string): T {
  return JSON.parse(
    JSON.stringify(value, (key, item: JsonValue) =>
      key === "timestamp" ? undefined : item,
    ).replaceAll(directory, "<dir>"),
  );
}

const TERMINAL_TOOLS = [
  "terminal_start",
  "terminal_send",
  "terminal_stop",
  "terminal_list",
  "terminal_wait",
];

/** One real offline conversation that carries a Termctrl tool result. */
async function conversation(options: { strip: boolean; codemode: boolean }) {
  const fixture = await createSdkFixture({
    binary: available,
    createDriver: new FakeDriverFactory().create,
    codemode: options.codemode,
    transformTermctrl: options.strip ? withoutAnnotations : undefined,
  });
  fixture.responses.push(
    fauxAssistantMessage(fauxToolCall("terminal_list", {}, { id: "list-call" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Listed."),
  );
  await fixture.session.prompt("List Terminals");
  await settle(fixture.session);
  expect(fixture.turns).toHaveLength(2);
  const reported = fixture.session.getAllTools();
  return {
    terminal: reported
      .filter(({ name }) => TERMINAL_TOOLS.includes(name))
      .map(({ name, annotations }) => ({ name, annotations })),
    bash: reported.find(({ name }) => name === "bash"),
    turns: normalized(fixture.turns, fixture.cwd),
  };
}

const hints = (
  readOnlyHint: boolean,
  destructiveHint: boolean,
  idempotentHint: boolean,
  openWorldHint: boolean,
) => ({ readOnlyHint, destructiveHint, idempotentHint, openWorldHint });

test.each([{ codemode: false }, { codemode: true }])(
  "reports explicit annotations without changing the provider prefix (codemode: $codemode)",
  async ({ codemode }) => {
    const annotated = await conversation({ strip: false, codemode });
    const plain = await conversation({ strip: true, codemode });

    expect(annotated.terminal).toEqual([
      // They run arbitrary programs: potentially destructive, reaching beyond the workspace.
      { name: "terminal_start", annotations: hints(false, true, false, true) },
      { name: "terminal_send", annotations: hints(false, true, false, true) },
      // Killing a process is destructive, but repeating the call has no further effect.
      { name: "terminal_stop", annotations: hints(false, true, true, false) },
      { name: "terminal_list", annotations: hints(true, false, true, false) },
      { name: "terminal_wait", annotations: hints(true, false, true, false) },
    ]);
    // The comparison is meaningful only if the baseline really lacks the hints.
    expect(plain.terminal).toEqual(
      TERMINAL_TOOLS.map((name) => ({ name, annotations: undefined })),
    );

    // Annotations are Pi-local: ordered tool definitions, system prompt, and history are identical
    // on both turns, including the turn that carries the tool result.
    expect(JSON.stringify(annotated.turns)).toContain('"name":"terminal_list"');
    expect(annotated.turns).toEqual(plain.turns);
    expect(JSON.stringify(annotated.turns)).not.toContain("Hint");
  },
);

test("the bash replacement keeps inheriting the built-in definition's annotations", async () => {
  const annotated = await conversation({ strip: false, codemode: false });
  // The built-in declares none, so the replacement must not invent any.
  expect(createBashToolDefinition("/").annotations).toBeUndefined();
  // Termctrl's replacement (it adds `background`) is the registered `bash`, not the built-in.
  expect(JSON.stringify(annotated.bash?.parameters)).toContain("background");
  expect(annotated.bash?.annotations).toBeUndefined();
});
