import { createHash } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import {
  convertToLlm,
  parseSkillBlock,
  type AgentSession,
  type CustomToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import {
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

/**
 * A message the root session's user typed, as Trusted Evidence for a Child Agent's or Advisor's
 * calls: their own task comes from another agent, but the root user's requests are the user's.
 */
export interface RootUserMessage {
  content: string | EvidenceBlock[];
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
  /** The root user's typed messages, in a Child Agent or Advisor session whose root is known. */
  rootUserMessages?: readonly RootUserMessage[];
  budgetTokens: number;
}

interface Entry {
  item: EvidenceItem;
  trusted: boolean;
  origin: string;
  /** The message's timestamp, for entries that come from a session message. */
  timestamp?: number;
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

/**
 * Each conversation message with its origin; User Overrides and the root user's messages are
 * interleaved by time, so entries recorded later land after the messages before them.
 */
function entries(input: EvidenceInput): Entry[] {
  const messages: Message[] = convertToLlm(input.sources).filter(
    (message) =>
      message.role === "user" || message.role === "assistant" || message.role === "toolResult",
  );
  const origins = messageOrigins(messages, input.sources);
  const result: Entry[] = [];
  const inserts = [
    ...input.overrides.map((override) => ({
      timestamp: override.timestamp,
      entry: { item: userItem(override.text), trusted: true, origin: "userOverride" },
    })),
    ...(input.rootUserMessages ?? []).map((message) => ({
      timestamp: message.timestamp,
      entry: { item: userItem(message.content), trusted: true, origin: "rootUser" },
    })),
  ].toSorted((left, right) => left.timestamp - right.timestamp);
  let next = 0;
  for (const [index, message] of messages.entries()) {
    while (next < inserts.length && (inserts[next]?.timestamp ?? Infinity) < message.timestamp) {
      const insert = inserts[next++];
      if (insert) result.push(insert.entry);
    }
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
    const { timestamp } = message;
    if (!input.trustUserMessages || origin !== "user") {
      result.push({ ...untrusted(item, origin), timestamp });
      continue;
    }
    const skill = splitSkill(item.message);
    if (!skill) {
      result.push({ item, trusted: true, origin, timestamp });
      continue;
    }
    result.push({ ...untrusted(userItem(skill.skill), "skill"), timestamp });
    if (skill.rest) result.push({ item: skill.rest, trusted: true, origin, timestamp });
  }
  for (const remaining of inserts.slice(next)) result.push(remaining.entry);
  return result;
}

/**
 * The messages the user typed in a main session, as Trusted Evidence would hold them: without
 * Skill bodies or messages an extension sent. Child Agents and Advisors of this session receive
 * them as the root user's requests.
 */
export function typedUserMessages(
  input: Pick<EvidenceInput, "sources" | "extensionMessages">,
): RootUserMessage[] {
  return entries({
    ...input,
    trustUserMessages: true,
    contextFiles: [],
    overrides: [],
    budgetTokens: 0,
  }).flatMap((entry) =>
    entry.trusted &&
    entry.origin === "user" &&
    entry.timestamp !== undefined &&
    entry.item.message.role === "user"
      ? [{ content: entry.item.message.content, timestamp: entry.timestamp }]
      : [],
  );
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

/** Per-string caps tried for TRUSTED entries, longest first, when they alone exceed the budget. */
const trustedCaps = [undefined, 32_000, 8_000, 2_000, 500] as const;
/** Tokens reserved for the omission note, whatever its count. */
const noteTokens = 32;

function omissionNote(omitted: number): string {
  return `[${omitted} older UNTRUSTED evidence ${omitted === 1 ? "entry was" : "entries were"} omitted to fit the evidence budget]`;
}

/**
 * Where the evidence window starts, or `undefined` when even an empty window exceeds the budget.
 * TRUSTED entries before the start are kept; the window holds every entry from it. The start
 * only moves forward, and each move drops at least half the budget of UNTRUSTED entries, so it
 * is a pure function of the history that moves at most once per half-budget of growth.
 */
function windowStart(
  all: readonly Entry[],
  costs: readonly number[],
  budget: number,
): number | undefined {
  const total = costs.reduce((sum, cost) => sum + cost, 0);
  let start = 0;
  let before = 0;
  let trustedBefore = 0;
  const cost = () => trustedBefore + (total - before) + (start > 0 ? noteTokens : 0);
  while (cost() > budget) {
    if (start >= all.length) return undefined;
    let dropped = 0;
    do {
      const entryCost = costs[start] ?? 0;
      if (all[start]?.trusted) trustedBefore += entryCost;
      else dropped += entryCost;
      before += entryCost;
      start++;
    } while (start < all.length && dropped < budget / 2);
  }
  return start;
}

/**
 * Select evidence within the token budget, prefix-stable so provider prompt caches survive
 * across reviews. Every TRUSTED entry is always kept. The rest is a window of every entry from a
 * start that jumps forward, dropping at least half the budget of the oldest UNTRUSTED entries,
 * only when the evidence overflows; between jumps each review's blocks extend the previous
 * review's. TRUSTED entries are shortened, all with one per-string cap from a fixed ladder, only
 * when they alone exceed the budget, so they do not reshape from review to review.
 */
export function selectEvidence(input: EvidenceInput): SelectedEvidence {
  const all = [...contextFileEntries(input.contextFiles), ...entries(input)];
  const budget = Math.max(0, input.budgetTokens);
  let capped = all;
  let start = all.length;
  for (const cap of trustedCaps) {
    capped =
      cap === undefined
        ? all
        : all.map((entry) =>
            entry.trusted
              ? {
                  ...entry,
                  item: shortenEvidence([entry.item], cap, omissionMarker)[0] ?? entry.item,
                }
              : entry,
          );
    const found = windowStart(
      capped,
      capped.map((entry) => textTokens(render(entry))),
      budget,
    );
    if (found === undefined) continue;
    start = found;
    break;
  }
  const blocks: string[] = [];
  let omitted = 0;
  for (const entry of capped.slice(0, start)) {
    if (entry.trusted) blocks.push(render(entry));
    else omitted++;
  }
  if (omitted) blocks.push(omissionNote(omitted));
  for (const entry of capped.slice(start)) blocks.push(render(entry));
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
