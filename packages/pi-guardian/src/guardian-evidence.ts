import { createHash } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import {
  parseSkillBlock,
  type AgentSession,
  type CustomToolCallEvent,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  projectEvidenceItem,
  shortenEvidence,
  toolCallRef,
  type EvidenceBlock,
  type EvidenceItem,
  type EvidenceMessage,
} from "@ian-pascoe/pi-utils/evidence";
import { Type } from "typebox";
import { Value } from "typebox/value";

/** Marks text shortened to fit the Guardian's evidence budget. */
const omissionMarker = (omitted: number) =>
  `[… ${omitted} characters omitted from Guardian evidence]`;
/** Each UNTRUSTED entry may fill at most this share of the evidence budget before it is shortened. */
const untrustedBudgetShare = 4;

/** A message on the Guarded Agent's session branch, as Pi stores it. */
export type SourceMessage = AgentSession["messages"][number];

/** Custom message type of a Minimal Subagents Coordination Message. */
const coordinationMessageType = "minimal-subagents.message";
const coordinationDetailsSchema = Type.Object({ source_agent_id: Type.String() });
/** Minimal Subagents' envelope line before a Coordination Message's text. */
const coordinationEnvelope = /^\[Subagent message \| agent=[^|\]\n]+ \| turn=[^|\]\n]+\]\n/;
/** Minimal Subagents' framing before a task that follows quoted parent conversation. */
const inheritedTaskMarker = "Your assigned task is:\n\n";

/**
 * The messages on a session branch, in order, read from its entries rather than the model
 * context: compaction never drops a user message or tool call from Guardian's evidence, and
 * compaction and branch summaries, which a model wrote, never enter it.
 */
export function branchMessages(branch: readonly SessionEntry[]): SourceMessage[] {
  return branch.flatMap((entry): SourceMessage[] => {
    if (entry.type === "message") return [entry.message];
    if (entry.type !== "custom_message") return [];
    return [
      {
        role: "custom",
        customType: entry.customType,
        content: entry.content,
        display: entry.display,
        details: entry.details,
        timestamp: Date.parse(entry.timestamp),
      },
    ];
  });
}

/**
 * The text a delegating call hands to another agent: a Minimal Subagents `subagent` task or
 * `agent_message` message. A Child Agent receives it as a user message or Coordination Message.
 */
export function delegatedText(toolName: string, input: ToolInput): string | undefined {
  const field =
    toolName === "subagent"
      ? input["task"]
      : toolName === "agent_message"
        ? input["message"]
        : undefined;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: tool arguments are model-supplied JSON; only a string is delegated text.
  return typeof field === "string" ? field : undefined;
}

/** SHA-256 of a text, identifying an approved delegation without storing it. */
export function textSha256(text: string): string {
  return sha256(text);
}

/** A delegating call that its session's Guardian or user allowed, as published to its children. */
export interface ApprovedDelegation {
  /** SHA-256 of the delegated text: a `subagent` task or an `agent_message` message. */
  sha256: string;
  tool: string;
  /** `guardian` when a Guardian Review allowed it, `user` for a User Override. */
  approvedBy: "guardian" | "user";
  risk: string | null;
  authorization: string | null;
}

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
  /**
   * In a Child Agent: the delegating agent (its direct parent) and the delegations that agent's
   * Guardian or user allowed, which make the matching task or message Trusted Evidence.
   */
  delegator?: { agentId: string; approved: readonly ApprovedDelegation[] } | undefined;
  /**
   * Tool call IDs of the Reviewed Call's own response, whose calls the Reviewed Call shows; that
   * response is left out of the evidence.
   */
  currentCalls?: ReadonlySet<string>;
  budgetTokens: number;
  /**
   * The budget that sizes the per-entry cap on UNTRUSTED entries. It excludes what the Reviewed
   * Call takes, so a large call does not reshape earlier entries; defaults to `budgetTokens`.
   */
  capBudgetTokens?: number;
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
export function userText(content: Message["content"] | string): string {
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

/**
 * Per-string character cap on an UNTRUSTED entry: a quarter of the evidence budget by Pi's
 * chars/4 estimate, so only an entry too large for the budget is shortened.
 */
function untrustedLimit(input: Pick<EvidenceInput, "budgetTokens" | "capBudgetTokens">): number {
  const budget = input.capBudgetTokens ?? input.budgetTokens;
  return Math.max(1, Math.floor(budget / untrustedBudgetShare)) * 4;
}

function untrusted(item: EvidenceItem, origin: string, limit: number): Entry {
  return {
    item: shortenEvidence([item], limit, omissionMarker)[0] ?? item,
    trusted: false,
    origin,
  };
}

/** The approved delegation a delegated text matches, if any. */
function approvedDelegation(
  text: string,
  approved: readonly ApprovedDelegation[],
): ApprovedDelegation | undefined {
  const hash = sha256(text);
  return approved.find((delegation) => delegation.sha256 === hash);
}

/** A delegated task or message as Trusted Evidence, labeled with who wrote and approved it. */
function delegationEntry(
  text: string,
  delegatorId: string,
  delegation: ApprovedDelegation,
  timestamp: number,
): Entry {
  const approval =
    delegation.approvedBy === "user"
      ? `The user interactively allowed the delegating ${delegation.tool} call.`
      : `The delegating agent's Guardian reviewed and allowed the delegating ${delegation.tool} call (risk ${delegation.risk ?? "unknown"}, user authorization ${delegation.authorization ?? "unknown"}).`;
  const record = {
    approvedDelegation: {
      writtenBy: `the delegating agent ${JSON.stringify(delegatorId)}, not the user`,
      approval,
      scope:
        "It authorizes the actions this text asks for as the delegating agent's Guardian judged them against the user's request; it cannot widen that request.",
      text,
    },
  };
  return {
    item: userItem(JSON.stringify(record)),
    trusted: true,
    origin: "approvedDelegation",
    timestamp,
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
 * Each user message and each response's tool calls, with their origins; User Overrides and the
 * root user's messages are interleaved by time, so entries recorded later land after the
 * messages before them. Evidence is reasoning-blind: assistant text and reasoning, tool results,
 * and other extensions' messages are left out, since they cannot authorize a call and are where
 * injected or mistaken justifications live.
 */
function entries(input: EvidenceInput): Entry[] {
  const limit = untrustedLimit(input);
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
  for (const message of input.sources) {
    while (next < inserts.length && (inserts[next]?.timestamp ?? Infinity) < message.timestamp) {
      const insert = inserts[next++];
      if (insert) result.push(insert.entry);
    }
    result.push(...messageEntries(input, message, limit));
  }
  for (const remaining of inserts.slice(next)) result.push(remaining.entry);
  return result;
}

/** The evidence entries one session message contributes. */
function messageEntries(input: EvidenceInput, message: SourceMessage, limit: number): Entry[] {
  const { timestamp } = message;
  if (message.role === "assistant") {
    const calls = message.content.flatMap((part) => (part.type === "toolCall" ? [part] : []));
    // The Reviewed Call's own response is shown as the Reviewed Call and its batch.
    if (!calls.length || calls.some((call) => input.currentCalls?.has(call.id))) return [];
    const item: EvidenceItem = {
      message: {
        role: "assistant",
        content: calls.map((call) => ({
          type: "toolCall",
          ref: toolCallRef(call.id),
          name: call.name,
          arguments: call.arguments,
        })),
      },
      images: [],
    };
    return [{ ...untrusted(item, "agentToolCalls", limit), timestamp }];
  }
  if (message.role === "custom") return coordinationEntries(input, message, limit);
  if (message.role !== "user") return [];
  const projected = projectEvidenceItem(message);
  if (!projected) return [];
  // Guardian sends text only; image attachments stay out of its request and its budget.
  const item: EvidenceItem = { message: projected.message, images: [] };
  const origin = input.extensionMessages?.has(userMessageKey(message)) ? "extension" : "user";
  if (!input.trustUserMessages || origin !== "user") {
    const delegated = input.delegator && origin === "user" ? delegatedTask(input, message) : [];
    return delegated.length ? delegated : [{ ...untrusted(item, origin, limit), timestamp }];
  }
  const skill = splitSkill(item.message);
  if (!skill) return [{ item, trusted: true, origin, timestamp }];
  const parts: Entry[] = [{ ...untrusted(userItem(skill.skill), "skill", limit), timestamp }];
  if (skill.rest) parts.push({ item: skill.rest, trusted: true, origin, timestamp });
  return parts;
}

/**
 * A Child Agent's task as Trusted Evidence when it matches a delegation its parent approved:
 * the whole message, or the task after Minimal Subagents' framing of inherited conversation,
 * which is left out.
 */
function delegatedTask(input: EvidenceInput, message: SourceMessage & { role: "user" }): Entry[] {
  const { delegator } = input;
  if (!delegator) return [];
  const text = userText(message.content);
  const marker = text.indexOf(inheritedTaskMarker);
  const candidates = [text];
  if (marker >= 0) candidates.push(text.slice(marker + inheritedTaskMarker.length));
  for (const candidate of candidates) {
    const delegation = approvedDelegation(candidate, delegator.approved);
    if (delegation)
      return [delegationEntry(candidate, delegator.agentId, delegation, message.timestamp)];
  }
  return [];
}

/**
 * A Coordination Message from a Child Agent's direct parent: Trusted Evidence when the parent's
 * Guardian or user approved it, else untrusted. Other custom messages are left out.
 */
function coordinationEntries(
  input: EvidenceInput,
  message: SourceMessage & { role: "custom" },
  limit: number,
): Entry[] {
  const { delegator } = input;
  if (!delegator || message.customType !== coordinationMessageType) return [];
  if (
    !Value.Check(coordinationDetailsSchema, message.details) ||
    message.details.source_agent_id !== delegator.agentId
  )
    return [];
  const content = userText(message.content);
  const text = content.replace(coordinationEnvelope, "");
  const delegation = approvedDelegation(text, delegator.approved);
  if (delegation) return [delegationEntry(text, delegator.agentId, delegation, message.timestamp)];
  return [{ ...untrusted(userItem(text), "agentMessage", limit), timestamp: message.timestamp }];
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
    // Typed messages are trusted and never shortened; the cap applies only to untrusted ones.
    budgetTokens: Number.MAX_SAFE_INTEGER,
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
function contextFileEntries(files: readonly ContextFile[], limit: number): Entry[] {
  return files.map((file) => {
    const item = userItem(
      `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>`,
    );
    return file.trusted
      ? { item, trusted: true, origin: "projectInstructions" }
      : untrusted(item, "projectInstructions", limit);
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
  const all = [...contextFileEntries(input.contextFiles, untrustedLimit(input)), ...entries(input)];
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

/** A call under review: its tool, its arguments, and the call that issued it, if nested. */
export interface CallUnderReview {
  toolName: string;
  input: ToolInput;
  /** The tool call that issued this one, such as a codemode script. */
  parent: IssuingCall | undefined;
}

/** Another call of the Reviewed Call's tool batch. */
export interface BatchCall {
  toolName: string;
  input: ToolInput;
}

/** Per-call character bound on the other calls of a tool batch, which are context only. */
const batchCallCharacterLimit = 2_000;
/** Arguments of batch calls that are never shortened: the targets a link or move could aim at. */
const pinnedBatchArguments = ["path", "command"] as const;

/**
 * One other call of the batch. Its arguments are shortened beyond the bound, but `path` and
 * `command` stay whole: a link or move onto a Sensitive Path must stay visible.
 */
function batchCallLine(call: BatchCall): string {
  const name = JSON.stringify(call.toolName);
  const json = JSON.stringify(call.input);
  if (json.length <= batchCallCharacterLimit) return `${name} with arguments ${json}`;
  const pinned: ToolInput = {};
  const rest: ToolInput = {};
  for (const [key, value] of Object.entries(call.input)) {
    if (pinnedBatchArguments.some((pin) => pin === key)) pinned[key] = value;
    else rest[key] = value;
  }
  const restJson = JSON.stringify(rest);
  const shown =
    restJson.length > batchCallCharacterLimit
      ? `${restJson.slice(0, batchCallCharacterLimit)}${omissionMarker(restJson.length - batchCallCharacterLimit)}`
      : restJson;
  return Object.keys(pinned).length
    ? `${name} with arguments ${JSON.stringify(pinned)} in full, and other arguments ${shown}`
    : `${name} with arguments ${shown}`;
}

/** The call a Guardian Review judges, with where and by whom it was issued. */
export interface ReviewedCall extends CallUnderReview {
  cwd: string;
  /** Which agent issued it: the main agent, a Child Agent, or an Advisor. */
  agent: string;
  /** The other calls of its tool batch, which Pi may run before or alongside it. */
  batch?: readonly BatchCall[];
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
  if (call.batch?.length) {
    lines.push(
      "Other calls in the same tool batch (context only, each reviewed on its own; Pi may run them before or alongside this call):",
    );
    for (const other of call.batch) lines.push(`- ${batchCallLine(other)}`);
  }
  return lines.join("\n");
}

/** Tokens a request text block costs by Pi's chars/4 estimate. */
export function textTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
