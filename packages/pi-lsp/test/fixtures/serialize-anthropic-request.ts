import type { Message, StreamFunction, StreamOptions } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { expect } from "vitest";

// Stop at the external transport boundary, after the installed provider serializes the SDK state.
export async function serializeAnthropicRequest(session: AgentSession, messages: Message[]) {
  const entry = import.meta.resolve("@earendil-works/pi-ai");
  const api: { stream: StreamFunction<"anthropic-messages", StreamOptions & { client: object }> } =
    await import(new URL("./api/anthropic-messages.js", entry).href);
  const prepared = await session.extensionRunner.emitBeforeAgentStart(
    "inspect",
    undefined,
    session.systemPrompt,
    { cwd: session.sessionManager.getCwd() },
  );
  let captured: unknown;
  let transports = 0;
  const response = await api
    .stream(
      getModel("anthropic", "claude-sonnet-4-5"),
      {
        systemPrompt: prepared?.systemPrompt ?? session.systemPrompt,
        tools: session.agent.state.tools,
        messages,
      },
      {
        client: {
          beta: {
            messages: {
              create() {
                transports++;
                throw new Error("Unexpected transport");
              },
            },
          },
        },
        sessionId: "lsp-prefix-proof",
        cacheRetention: "short",
        onPayload(payload) {
          captured = structuredClone(payload);
          throw new Error("STOP BEFORE TRANSPORT");
        },
      },
    )
    .result();
  expect(response.errorMessage).toContain("STOP BEFORE TRANSPORT");
  expect(transports).toBe(0);
  const schema = Type.Object({
    tools: Type.Array(Type.Unknown(), { minItems: 1 }),
    system: Type.Array(Type.Unknown(), { minItems: 1 }),
    messages: Type.Array(Type.Unknown(), { minItems: 1 }),
  });
  if (!Value.Check(schema, captured)) throw new Error("Invalid serialized provider request");
  return captured;
}
