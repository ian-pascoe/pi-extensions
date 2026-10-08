import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  expectNullOptionalArgumentsOmitted,
  withoutPreparedArguments,
} from "@ian-pascoe/pi-utils/tool-testing";
import { afterEach, expect, test } from "vitest";
import { TermctrlRegistry } from "../src/termctrl-registry.js";
import { FakeDriverFactory } from "./fake-driver.js";
import { createSdkFixture, disposeSdkFixtures, settle } from "./sdk-fixture.js";

const available = { kind: "available", path: "/fake/termctrl" } as const;

afterEach(async () => {
  await disposeSdkFixtures();
  await TermctrlRegistry.teardownForTests();
});

const TERMINAL_TOOLS = [
  "terminal_start",
  "terminal_send",
  "terminal_stop",
  "terminal_list",
  "terminal_wait",
];

async function conversation(strip: boolean) {
  const fixture = await createSdkFixture({
    binary: available,
    createDriver: new FakeDriverFactory().create,
    transformTermctrl: strip ? withoutPreparedArguments : undefined,
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
  return fixture;
}

test("each terminal tool and the bash replacement treat null for an optional parameter like omitting it", async () => {
  const { session } = await conversation(false);
  const proven = new Map<string, string[]>();
  for (const name of [...TERMINAL_TOOLS, "bash"]) {
    const tool = session.getToolDefinition(name);
    if (tool === undefined) throw new Error(`Expected a registered ${name} tool`);
    proven.set(name, expectNullOptionalArgumentsOmitted(tool));
  }
  expect(proven.get("terminal_start")).toEqual(expect.arrayContaining(["cwd"]));
  expect(proven.get("terminal_send")).toEqual(expect.arrayContaining(["text", "keys"]));
  expect(proven.get("terminal_wait")).toEqual(expect.arrayContaining(["ids"]));
});

test("accepting null leaves the system prompt and ordered tool declarations identical", async () => {
  const stripped = await conversation(true);
  const accepting = await conversation(false);
  const prefix = (turns: typeof accepting.turns, directory: string) =>
    JSON.stringify(turns.map(({ systemPrompt, tools }) => ({ systemPrompt, tools }))).replaceAll(
      directory,
      "<dir>",
    );
  expect(prefix(accepting.turns, accepting.cwd)).toBe(prefix(stripped.turns, stripped.cwd));
  expect(prefix(accepting.turns, accepting.cwd)).toContain('"name":"terminal_wait"');
});
