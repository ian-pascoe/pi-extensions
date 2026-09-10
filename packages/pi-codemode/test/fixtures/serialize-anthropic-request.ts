import type { Context, Message, StreamFunction, StreamOptions } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { expect } from "vitest";

export async function serializeAnthropicRequest(session: AgentSession, messages: Message[]) {
  const prepared = await session.extensionRunner.emitBeforeAgentStart(
    "synchronize",
    undefined,
    session.systemPrompt,
    { cwd: session.sessionManager.getCwd() },
  );
  return serializeAnthropicContext({
    systemPrompt: prepared?.systemPrompt ?? session.systemPrompt,
    tools: session.agent.state.tools,
    messages,
  });
}

/** Capture the same provider payload at a real Child Agent's model boundary. */
export async function serializeAnthropicContext(context: Context) {
  const entry = import.meta.resolve("@earendil-works/pi-ai");
  const api: { stream: StreamFunction<"anthropic-messages", StreamOptions & { client: object }> } =
    await import(new URL("./api/anthropic-messages.js", entry).href);
  const sentinel = "STOP BEFORE ANTHROPIC TRANSPORT";
  let captured: unknown;
  let transports = 0;
  const response = await api
    .stream(getModel("anthropic", "claude-sonnet-4-5"), context, {
      client: {
        beta: {
          messages: {
            create() {
              transports += 1;
              throw new Error("Unexpected transport");
            },
          },
        },
      },
      sessionId: "plan-004-fixed-routing-key",
      cacheRetention: "short",
      onPayload(payload) {
        captured = structuredClone(payload);
        throw new Error(sentinel);
      },
    })
    .result();
  expect(response.stopReason).toBe("error");
  expect(response.errorMessage).toContain(sentinel);
  expect(transports).toBe(0);
  const payloadSchema = Type.Object({
    tools: Type.Array(Type.Unknown(), { minItems: 1 }),
    system: Type.Array(Type.Unknown(), { minItems: 1 }),
    messages: Type.Array(
      Type.Object({
        role: Type.String(),
        content: Type.Array(Type.Record(Type.String(), Type.Unknown())),
      }),
      { minItems: 1 },
    ),
  });
  if (!Value.Check(payloadSchema, captured))
    throw new Error("Unexpected installed Anthropic payload");
  return captured;
}
