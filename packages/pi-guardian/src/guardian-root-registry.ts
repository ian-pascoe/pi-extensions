import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { RootUserMessage } from "./guardian-evidence.js";
import type { ResolvedGuardianSettings } from "./guardian-settings.js";

/** Reads a root session's current effective Guardian settings. */
export type RootSettingsReader = () => ResolvedGuardianSettings;

/** What a root session running Guardian publishes to its Child Agents and Advisors. */
export interface RootSession {
  settings: RootSettingsReader;
  /** The messages the root's user typed, as Trusted Evidence for delegated sessions' calls. */
  userMessages: () => RootUserMessage[];
}

/**
 * Process-global registry of root sessions, keyed by root session ID. Child Agents and Advisors
 * run in-process with their own Guardian instance, possibly loaded from a different copy of this
 * package, so the registry lives on a global symbol.
 */
const registryKey = Symbol.for("pi-guardian.root-sessions.v2");

function registry(): Map<string, RootSession> {
  const existing: unknown = Object.getOwnPropertyDescriptor(globalThis, registryKey)?.value;
  // Only this module writes the slot, always with a Map of root sessions.
  if (existing instanceof Map) return existing;
  const created = new Map<string, RootSession>();
  Object.defineProperty(globalThis, registryKey, { value: created, configurable: true });
  return created;
}

/** Publish a root session; returns the matching unpublish. */
export function publishRootSession(rootSessionId: string, root: RootSession): () => void {
  const roots = registry();
  roots.set(rootSessionId, root);
  return () => {
    if (roots.get(rootSessionId) === root) roots.delete(rootSessionId);
  };
}

/** The published root session, if that root runs Guardian in this process. */
export function rootSession(rootSessionId: string): RootSession | undefined {
  return registry().get(rootSessionId);
}

/** The published settings reader for a root session, if that root runs Guardian in-process. */
export function rootSettingsReader(rootSessionId: string): RootSettingsReader | undefined {
  return rootSession(rootSessionId)?.settings;
}

const childIdentitySchema = Type.Object({ original_root_session_id: Type.String() });
const advisorRoleSchema = Type.Object({ observedSessionId: Type.String() });

/** Which kind of agent a session belongs to, and the root whose settings it follows. */
export type GuardedSessionRole =
  | { kind: "main" }
  | { kind: "child"; rootSessionId: string }
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
      return { kind: "child", rootSessionId: entry.data.original_root_session_id };
    if (entry.customType === "pi-advisor-role" && Value.Check(advisorRoleSchema, entry.data))
      return { kind: "advisor", rootSessionId: entry.data.observedSessionId };
  }
  return { kind: "main" };
}
