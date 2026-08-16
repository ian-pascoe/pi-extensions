import type { CoordinatorMessage } from "./minimal-subagents-types.js";

/** Add the stable source identity that the receiving model must see. */
export function addCoordinatorMessageEnvelope(message: CoordinatorMessage): CoordinatorMessage {
  const kind = message.customType === "minimal-subagents.result" ? "result" : "message";
  const status = message.details.status ? ` | status=${message.details.status}` : "";
  const envelope = `[Subagent ${kind} | agent=${message.details.source_agent_id} | turn=${message.details.source_turn_id}${status}]`;
  return {
    ...message,
    content: message.content.length > 0 ? `${envelope}\n${message.content}` : envelope,
  };
}

/** Remove the model-only envelope from the styled TUI message body. */
export function stripCoordinatorMessageEnvelope(content: string): string {
  return content.replace(
    /^\[Subagent (?:message|result) \| agent=[^|\]\n]+ \| turn=[^|\]\n]+(?: \| status=[^|\]\n]+)?\]\n?/,
    "",
  );
}
