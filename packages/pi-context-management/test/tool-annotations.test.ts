import type { JsonValue } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import type {
  ExtensionAPI,
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import contextManagement from "../src/context-management-extension.js";
import { createSdkHarness, reply, toolCall } from "./sdk-harness.js";

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

/** Timestamps, tool durations, and the temporary directory are noise between two otherwise identical runs. */
function normalized<T>(value: T, directory: string): T {
  return JSON.parse(
    JSON.stringify(value, (key, item: JsonValue) =>
      key === "timestamp" || key === "durationMs" ? undefined : item,
    ).replaceAll(directory, "<dir>"),
  );
}

const CONTEXT_TOOLS = ["context_history", "context_notes", "context_rollover"];

/** One real offline conversation that exercises a Context Management tool result. */
async function conversation(factory: ExtensionFactory) {
  const f = await createSdkHarness([factory]);
  f.responses.push(toolCall("context_notes", { action: "list" }), reply("Listed."));
  await f.session.prompt("List the Notes");
  expect(f.requests).toHaveLength(2);
  expect(f.providerRequests).toEqual([]);
  return {
    reported: f.session
      .getAllTools()
      .filter(({ name }) => CONTEXT_TOOLS.includes(name))
      .map(({ name, annotations }) => ({ name, annotations })),
    requests: normalized(
      f.requests.map(({ systemPrompt, messages, toolDefinitions }) => ({
        systemPrompt,
        toolDefinitions,
        messages,
      })),
      f.dir,
    ),
  };
}

it("reports explicit annotations without changing the provider prefix", async () => {
  const annotated = await conversation(contextManagement);
  const plain = await conversation(withoutAnnotations(contextManagement));

  const sessionLocal = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  };
  expect(annotated.reported).toEqual([
    {
      name: "context_history",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    { name: "context_notes", annotations: sessionLocal },
    { name: "context_rollover", annotations: sessionLocal },
  ]);
  // The comparison is meaningful only if the baseline really lacks the hints.
  expect(plain.reported).toEqual(CONTEXT_TOOLS.map((name) => ({ name, annotations: undefined })));

  // Annotations are Pi-local: ordered tool definitions, system prompt, and history are identical
  // on both turns, including the turn that carries the tool result.
  expect(JSON.stringify(annotated.requests)).toContain('"name":"context_notes"');
  expect(annotated.requests).toEqual(plain.requests);
  expect(JSON.stringify(annotated.requests)).not.toContain("Hint");
});
