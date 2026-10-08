import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ApprovedDelegation, RootUserMessage } from "./guardian-evidence.js";
import type { ResolvedGuardianSettings } from "./guardian-settings.js";

/** Reads a root session's current effective Guardian settings. */
export type RootSettingsReader = () => ResolvedGuardianSettings;

/**
 * What a session running Guardian publishes to the sessions that follow it. A main session
 * publishes its own settings and typed messages; a Child Agent or Advisor republishes its root's,
 * so an Advisor observing a Child Agent resolves to the real root.
 */
export interface RootSession {
  /** The root session whose settings and user these are. */
  rootSessionId: () => string;
  settings: RootSettingsReader;
  /** The messages the root's user typed, as Trusted Evidence for delegated sessions' calls. */
  userMessages: () => RootUserMessage[];
}

/**
 * Process-global registry of sessions running Guardian, keyed by session ID. Child Agents and
 * Advisors run in-process with their own Guardian instance, possibly loaded from a different copy
 * of this package, so the registry lives on a global symbol.
 */
const registryKey = Symbol.for("pi-guardian.root-sessions.v3");

function registry(): Map<string, RootSession> {
  const existing: unknown = Object.getOwnPropertyDescriptor(globalThis, registryKey)?.value;
  // Only this module writes the slot, always with a Map of root sessions.
  if (existing instanceof Map) return existing;
  const created = new Map<string, RootSession>();
  Object.defineProperty(globalThis, registryKey, { value: created, configurable: true });
  return created;
}

/** Publish a session under its ID; returns the matching unpublish. */
export function publishRootSession(sessionId: string, root: RootSession): () => void {
  const roots = registry();
  roots.set(sessionId, root);
  return () => {
    if (roots.get(sessionId) === root) roots.delete(sessionId);
  };
}

/** What the session `sessionId` publishes, if it runs Guardian in this process. */
export function rootSession(sessionId: string): RootSession | undefined {
  return registry().get(sessionId);
}

/** Reads the delegations a session's Guardian or user allowed, newest last. */
export type DelegationReader = () => ApprovedDelegation[];

/**
 * Process-global registry of approved delegations, keyed by the delegating agent: its root
 * session ID and Minimal Subagents canonical agent ID (`root` for the root session). A Child
 * Agent records only these IDs of its parent, not the parent's session ID.
 */
const delegationsKey = Symbol.for("pi-guardian.approved-delegations.v1");

function delegations(): Map<string, DelegationReader> {
  const existing: unknown = Object.getOwnPropertyDescriptor(globalThis, delegationsKey)?.value;
  // Only this module writes the slot, always with a Map of delegation readers.
  if (existing instanceof Map) return existing;
  const created = new Map<string, DelegationReader>();
  Object.defineProperty(globalThis, delegationsKey, { value: created, configurable: true });
  return created;
}

/** The canonical agent ID Minimal Subagents gives the root agent. */
export const rootAgentId = "root";

function delegatorKey(rootSessionId: string, agentId: string): string {
  return JSON.stringify([rootSessionId, agentId]);
}

/** Publish an agent's approved delegations; returns the matching unpublish. */
export function publishDelegations(
  rootSessionId: string,
  agentId: string,
  reader: DelegationReader,
): () => void {
  const readers = delegations();
  const key = delegatorKey(rootSessionId, agentId);
  readers.set(key, reader);
  return () => {
    if (readers.get(key) === reader) readers.delete(key);
  };
}

/** The delegations an agent's Guardian or user allowed, if it runs Guardian in this process. */
export function approvedDelegations(
  rootSessionId: string,
  agentId: string,
): ApprovedDelegation[] | undefined {
  return delegations().get(delegatorKey(rootSessionId, agentId))?.();
}

const childIdentitySchema = Type.Object({
  original_root_session_id: Type.String(),
  canonical_agent_id: Type.Optional(Type.String()),
  direct_parent_id: Type.Optional(Type.String()),
});
const advisorRoleSchema = Type.Object({ observedSessionId: Type.String() });

/**
 * Which kind of agent a session belongs to, and the session it follows: a Child Agent's root, or
 * the session an Advisor observes, which may itself be a Child Agent that resolves to its root.
 */
export type GuardedSessionRole =
  | { kind: "main" }
  | {
      kind: "child";
      rootSessionId: string;
      /** Its Minimal Subagents canonical agent ID and its direct parent's, when recorded. */
      agentId: string | undefined;
      parentAgentId: string | undefined;
    }
  | { kind: "advisor"; rootSessionId: string };

/**
 * Detect Child Agent sessions (Minimal Subagents' `minimal-subagents.identity` entry) and
 * Advisor sessions (pi-advisor's `pi-advisor-role` entry) from their native journal.
 */
export function guardedSessionRole(branch: readonly SessionEntry[]): GuardedSessionRole {
  for (const entry of branch) {
    if (entry.type !== "custom") continue;
    if (
      entry.customType === "minimal-subagents.identity" &&
      Value.Check(childIdentitySchema, entry.data)
    )
      return {
        kind: "child",
        rootSessionId: entry.data.original_root_session_id,
        agentId: entry.data.canonical_agent_id,
        parentAgentId: entry.data.direct_parent_id,
      };
    if (entry.customType === "pi-advisor-role" && Value.Check(advisorRoleSchema, entry.data))
      return { kind: "advisor", rootSessionId: entry.data.observedSessionId };
  }
  return { kind: "main" };
}
