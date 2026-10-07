import type { Message } from "@earendil-works/pi-ai";
import {
  convertToLlm,
  type AgentSession,
  type CustomToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import {
  evidenceItemsCost,
  fitEvidence,
  messageOrigins,
  projectEvidence,
  shortenEvidence,
  type EvidenceItem,
} from "@ian-pascoe/pi-utils/evidence";

/** Marks text shortened to fit the Guardian's evidence budget. */
const omissionMarker = (omitted: number) =>
  `[… ${omitted} characters omitted from Guardian evidence]`;
/** Per-string cap on untrusted evidence, about 2000 tokens by Pi's chars/4 estimate. */
const untrustedCharacterLimit = 8_000;
/** Cap on the Reviewed Call's serialized arguments, about 8000 tokens. */
const reviewedCallCharacterLimit = 32_000;

/** A User Override recorded in the session, replayed as Trusted Evidence. */
export interface RecordedOverride {
  text: string;
  /** Milliseconds since the epoch, to place it among the conversation's messages. */
  timestamp: number;
}

/** Everything evidence selection reads. */
export interface EvidenceInput {
  /** The Guarded Agent's session messages, in order, as Pi stores them. */
  sources: AgentSession["messages"];
  /** False in Child Agent and Advisor sessions, whose user messages come from another agent. */
  trustUserMessages: boolean;
  /** The `<project_context>` section of the Guarded Agent's system prompt, when present. */
  projectInstructions: string | undefined;
  overrides: readonly RecordedOverride[];
  budgetTokens: number;
}

interface Entry {
  item: EvidenceItem;
  trusted: boolean;
  origin: string;
}

/** Selected evidence, rendered as one text block per entry. */
export interface SelectedEvidence {
  blocks: string[];
  /** Untrusted entries dropped to fit the budget. */
  omitted: number;
}

function render({ item, trusted, origin }: Entry): string {
  return `Evidence (${trusted ? "TRUSTED" : "UNTRUSTED"}, origin: ${origin}):\n${JSON.stringify(item.message)}`;
}

/** Each conversation message with its origin; overrides interleaved by time. */
function entries(input: EvidenceInput): Entry[] {
  const messages: Message[] = convertToLlm(input.sources).filter(
    (message) =>
      message.role === "user" || message.role === "assistant" || message.role === "toolResult",
  );
  const origins = messageOrigins(messages, input.sources);
  const result: Entry[] = [];
  const overrides = input.overrides.toSorted((left, right) => left.timestamp - right.timestamp);
  let next = 0;
  for (const [index, message] of messages.entries()) {
    while ((overrides[next]?.timestamp ?? Infinity) < message.timestamp) {
      const override = overrides[next++];
      if (override)
        result.push({
          item: { message: { role: "user", content: override.text }, images: [] },
          trusted: true,
          origin: "userOverride",
        });
    }
    const [projected] = projectEvidence([message]).messages;
    if (!projected) continue;
    const origin = origins[index] ?? "unknown";
    const trusted = input.trustUserMessages && origin === "user";
    const item: EvidenceItem = { message: projected, images: [] };
    result.push({
      item: trusted
        ? item
        : (shortenEvidence([item], untrustedCharacterLimit, omissionMarker)[0] ?? item),
      trusted,
      origin,
    });
  }
  for (const override of overrides.slice(next))
    result.push({
      item: { message: { role: "user", content: override.text }, images: [] },
      trusted: true,
      origin: "userOverride",
    });
  return result;
}

/**
 * Select evidence within the token budget. Always kept: project instructions and every TRUSTED
 * entry, shortened together if they alone exceed the budget. The rest takes the newest
 * UNTRUSTED entries that fit. Order stays chronological, so within budget each review's
 * evidence extends the previous one's and providers can reuse the cached prefix.
 */
export function selectEvidence(input: EvidenceInput): SelectedEvidence {
  const all = entries(input);
  if (input.projectInstructions)
    all.unshift({
      item: { message: { role: "user", content: input.projectInstructions }, images: [] },
      trusted: true,
      origin: "projectInstructions",
    });
  const required = all.filter((entry) => entry.trusted);
  const requiredItems = required.map((entry) => entry.item);
  const fitted =
    fitEvidence(requiredItems, input.budgetTokens, omissionMarker) ??
    shortenEvidence(requiredItems, 0, omissionMarker);
  const fittedItems = new Map(required.map((entry, index) => [entry, fitted[index] ?? entry.item]));
  let remaining = input.budgetTokens - evidenceItemsCost(fitted);
  const kept = new Set<Entry>(required);
  for (const entry of all.toReversed()) {
    if (entry.trusted) continue;
    const cost = evidenceItemsCost([entry.item]);
    if (cost > remaining) break;
    kept.add(entry);
    remaining -= cost;
  }
  const untrusted = all.filter((entry) => !entry.trusted);
  const omitted = untrusted.filter((entry) => !kept.has(entry)).length;
  const blocks: string[] = [];
  let noted = omitted === 0;
  for (const entry of all) {
    if (!kept.has(entry)) continue;
    if (!entry.trusted && !noted) {
      blocks.push(
        `[${omitted} older UNTRUSTED evidence ${omitted === 1 ? "entry was" : "entries were"} omitted to fit the evidence budget]`,
      );
      noted = true;
    }
    blocks.push(render({ ...entry, item: fittedItems.get(entry) ?? entry.item }));
  }
  return { blocks, omitted };
}

/** The `<project_context>` section of a Pi system prompt, if any. */
export function projectInstructions(systemPrompt: string): string | undefined {
  const open = "<project_context>\n";
  const close = "\n</project_context>";
  const start = systemPrompt.indexOf(open);
  const end = systemPrompt.indexOf(close, start + open.length);
  if (start < 0 || end < 0) return undefined;
  return systemPrompt.slice(start + open.length, end);
}

/** A tool call's arguments as Pi passes them to `tool_call` handlers. */
export type ToolInput = CustomToolCallEvent["input"];

/** The tool call that issued a nested call. */
export interface IssuingCall {
  toolName: string;
  input: ToolInput;
}

/** The call a Guardian Review judges. */
export interface ReviewedCall {
  toolName: string;
  input: ToolInput;
  cwd: string;
  /** Which agent issued it: the main agent, a Child Agent, or an Advisor. */
  agent: string;
  /** The tool call that issued this one, such as a codemode script. */
  parent?: IssuingCall | undefined;
}

function boundedJson(value: ToolInput): string {
  const json = JSON.stringify(value);
  if (json.length <= reviewedCallCharacterLimit) return json;
  return `${json.slice(0, reviewedCallCharacterLimit)}\n${omissionMarker(json.length - reviewedCallCharacterLimit)}`;
}

/** The final request block: the Reviewed Call and the issuing call, if any. */
export function renderReviewedCall(call: ReviewedCall): string {
  const lines = [
    "Reviewed Call (judge this exact action):",
    `Guarded Agent: ${call.agent}`,
    `Working directory: ${call.cwd}`,
    `Tool: ${call.toolName}`,
    `Arguments: ${boundedJson(call.input)}`,
  ];
  if (call.parent)
    lines.push(
      `Issued by tool call: ${call.parent.toolName}`,
      `Issuing call arguments: ${boundedJson(call.parent.input)}`,
    );
  return lines.join("\n");
}
