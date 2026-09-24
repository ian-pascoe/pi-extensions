import {
  getCurrentSystemPrompt,
  getCurrentTools,
  withoutInitialSystemMessage,
  type Context,
  type TranscriptContext,
} from "@earendil-works/pi-ai";

/** Pi 0.86+ carries the prompt and tool declarations as transcript system messages. */
export function endpointContext(context: TranscriptContext): Context {
  return {
    systemPrompt: getCurrentSystemPrompt(context.messages),
    messages: withoutInitialSystemMessage(context.messages),
    tools: getCurrentTools(context.messages),
  };
}
