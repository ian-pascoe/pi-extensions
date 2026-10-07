import { createHash } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import {
  convertToLlm,
  parseSkillBlock,
  type AgentSession,
  type CustomToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import {
  evidenceItemsCost,
  fitEvidence,
  messageOrigins,
  projectEvidenceItem,
  shortenEvidence,
  type EvidenceBlock,
  type EvidenceItem,
  type EvidenceMessage,
} from "@ian-pascoe/pi-utils/evidence";

/** Marks text shortened to fit the Guardian's evidence budget. */
const omissionMarker = (omitted: number) =>
  `[… ${omitted} characters omitted from Guardian evidence]`;
/** Per-string cap on untrusted evidence, about 2000 tokens by Pi's chars/4 estimate. */
const untrustedCharacterLimit = 8_000;

/** A User Override recorded in the session, replayed as Trusted Evidence. */
export interface RecordedOverride {
  text: string;
  /** Milliseconds since the epoch, to place it among the conversation's messages. */
  timestamp: number;
}

/** A context file Pi loaded into the Guarded Agent's system prompt, such as `AGENTS.md`. */
export interface ContextFile {
  path: string;
  content: string;
  /** Global context files and those of a trusted project; others are untrusted evidence. */
  trusted: boolean;
}

/** Everything evidence selection reads. */
export interface EvidenceInput {
  /** The Guarded Agent's session messages, in order, as Pi stores them. */
  sources: AgentSession["messages"];
  /** False in Child Agent and Advisor sessions, whose user messages come from another agent. */
  trustUserMessages: boolean;
  /** Context files from Pi's resource loader, in the order Pi loaded them. */
  contextFiles: readonly ContextFile[];
  /** {@link userMessageKey}s of user messages an extension sent rather than the user typed. */
  extensionMessages?: ReadonlySet<string>;
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

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The text a user message carries, for identifying it across Pi's message conversions. */
function userText(content: Message["content"] | string): string {
  if (!Array.isArray(content)) return content;
  return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

/** Identifies one user message by its timestamp and text, stable across reloads. */
export function userMessageKey(message: {
  content: Message["content"] | string;
  timestamp: number;
}): string {
  return `${message.timestamp}:${sha256(userText(message.content))}`;
}

function render({ item, trusted, origin }: Entry): string {
  return `Evidence (${trusted ? "TRUSTED" : "UNTRUSTED"}, origin: ${origin}):\n${JSON.stringify(item.message)}`;
}

function userItem(content: string | EvidenceBlock[]): EvidenceItem {
  return { message: { role: "user", content }, images: [] };
}

function untrusted(item: EvidenceItem, origin: string): Entry {
  return {
    item: shortenEvidence([item], untrustedCharacterLimit, omissionMarker)[0] ?? item,
    trusted: false,
    origin,
  };
}

/**
 * Split a `/skill:` expansion: Pi wraps the Skill's file in a `<skill>` block before the user's
 * own text. The Skill body is file content, so it is untrusted even when the user invoked it.
 */
function splitSkill(
  message: EvidenceMessage,
): { skill: string; rest: EvidenceItem | undefined } | undefined {
  if (message.role !== "user") return undefined;
  const { content } = message;
  const blocks = Array.isArray(content) ? content : undefined;
  const first: EvidenceBlock | undefined = Array.isArray(content)
    ? content[0]
    : { type: "text", text: content };
  if (first?.type !== "text") return undefined;
  const parsed = parseSkillBlock(first.text);
  if (!parsed) return undefined;
  const skill = `<skill name="${parsed.name}" location="${parsed.location}">\n${parsed.content}\n</skill>`;
  const others = blocks?.slice(1) ?? [];
  if (!parsed.userMessage && !others.length) return { skill, rest: undefined };
  const text: EvidenceBlock[] = parsed.userMessage
    ? [{ type: "text", text: parsed.userMessage }]
    : [];
  return {
    skill,
    rest: userItem(blocks ? [...text, ...others] : (parsed.userMessage ?? "")),
  };
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
  const override = (text: string): Entry => ({
    item: userItem(text),
    trusted: true,
    origin: "userOverride",
  });
  let next = 0;
  for (const [index, message] of messages.entries()) {
    while (next < overrides.length && (overrides[next]?.timestamp ?? Infinity) < message.timestamp)
      result.push(override(overrides[next++]?.text ?? ""));
    const projected = projectEvidenceItem(message);
    if (!projected) continue;
    // Guardian sends text only; image attachments stay out of its request and its budget.
    const item: EvidenceItem = { message: projected.message, images: [] };
    let origin = origins[index] ?? "unknown";
    if (
      origin === "user" &&
      message.role === "user" &&
      input.extensionMessages?.has(userMessageKey(message))
    )
      origin = "extension";
    if (!input.trustUserMessages || origin !== "user") {
      result.push(untrusted(item, origin));
      continue;
    }
    const skill = splitSkill(item.message);
    if (!skill) {
      result.push({ item, trusted: true, origin });
      continue;
    }
    result.push(untrusted(userItem(skill.skill), "skill"));
    if (skill.rest) result.push({ item: skill.rest, trusted: true, origin });
  }
  for (const remaining of overrides.slice(next)) result.push(override(remaining.text));
  return result;
}

/** Context files as evidence: trusted ones can establish User Authorization, others cannot. */
function contextFileEntries(files: readonly ContextFile[]): Entry[] {
  return files.map((file) => {
    const item = userItem(
      `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>`,
    );
    return file.trusted
      ? { item, trusted: true, origin: "projectInstructions" }
      : untrusted(item, "projectInstructions");
  });
}

/**
 * Select evidence within the token budget. Always kept: every TRUSTED entry, shortened together
 * if they alone exceed the budget. The rest takes the newest UNTRUSTED entries that fit. Order
 * stays chronological, so within budget each review's evidence extends the previous one's and
 * providers can reuse the cached prefix.
 */
export function selectEvidence(input: EvidenceInput): SelectedEvidence {
  const all = [...contextFileEntries(input.contextFiles), ...entries(input)];
  const required = all.filter((entry) => entry.trusted);
  const requiredItems = required.map((entry) => entry.item);
  const budget = Math.max(0, input.budgetTokens);
  const fitted =
    fitEvidence(requiredItems, budget, omissionMarker) ??
    shortenEvidence(requiredItems, 0, omissionMarker);
  const fittedItems = new Map(required.map((entry, index) => [entry, fitted[index] ?? entry.item]));
  let remaining = budget - evidenceItemsCost(fitted);
  const kept = new Set<Entry>(required);
  for (const entry of all.toReversed()) {
    if (entry.trusted) continue;
    const cost = evidenceItemsCost([entry.item]);
    if (cost > remaining) break;
    kept.add(entry);
    remaining -= cost;
  }
  const omitted = all.filter((entry) => !entry.trusted && !kept.has(entry)).length;
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

/** A tool call's arguments as Pi passes them to `tool_call` handlers. */
export type ToolInput = CustomToolCallEvent["input"];

/** SHA-256 of a call's serialized arguments, identifying the exact call across reviews. */
export function argumentsHash(input: ToolInput): string {
  return sha256(JSON.stringify(input));
}

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
  /** Why a built-in default sends this call to review, such as its Sensitive Path. */
  reason?: string | undefined;
}

/**
 * The final request block: the Reviewed Call and the issuing call, if any. Never shortened: a
 * cut could hide the part of the call that does harm, so a call too large to review is a Review
 * Failure instead.
 */
export function renderReviewedCall(call: ReviewedCall): string {
  const lines = [
    "Reviewed Call (judge this exact action):",
    `Guarded Agent: ${call.agent}`,
    `Working directory: ${call.cwd}`,
    `Tool: ${call.toolName}`,
    ...(call.reason ? [`Reviewed because: ${call.reason}`] : []),
    `Arguments SHA-256: ${argumentsHash(call.input)}`,
    `Arguments: ${JSON.stringify(call.input)}`,
  ];
  if (call.parent)
    lines.push(
      `Issued by tool call: ${call.parent.toolName}`,
      `Issuing call arguments: ${JSON.stringify(call.parent.input)}`,
    );
  return lines.join("\n");
}

/** Tokens a request text block costs by Pi's chars/4 estimate. */
export function textTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
