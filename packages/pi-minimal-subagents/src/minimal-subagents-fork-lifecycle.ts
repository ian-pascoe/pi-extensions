import type { ForkSnapshot } from "./minimal-subagents-types.js";
import { canonicalPath } from "./minimal-subagents-sessions.js";

declare global {
  // eslint-disable-next-line no-var -- A process-global handoff must be visible to replacement extension instances.
  var minimalSubagentsForkSnapshots: Map<string, ForkSnapshot> | undefined;
}

function forkSnapshotStore(): Map<string, ForkSnapshot> {
  globalThis.minimalSubagentsForkSnapshots ??= new Map();
  return globalThis.minimalSubagentsForkSnapshots;
}

/** Prove a process-loss fork destination was derived from the expected canonical source file. */
export function isForkDestinationForSource(
  destinationHeader: { parentSession?: string } | null,
  previousSessionFile: string,
): boolean {
  return (
    destinationHeader?.parentSession !== undefined &&
    canonicalPath(destinationHeader.parentSession) === canonicalPath(previousSessionFile)
  );
}

/** Retain a complete pre-fork hierarchy across Pi extension-instance replacement. */
export function rememberForkSnapshot(snapshot: ForkSnapshot): void {
  const canonicalSourceFile = canonicalPath(snapshot.source_root_session_file);
  const retained = structuredClone(snapshot);
  retained.source_root_session_file = canonicalSourceFile;
  forkSnapshotStore().set(canonicalSourceFile, retained);
}

/** Consume the pre-fork hierarchy once when the destination root session starts. */
export function takeForkSnapshot(previousSessionFile: string): ForkSnapshot | undefined {
  const key = canonicalPath(previousSessionFile);
  const snapshot = forkSnapshotStore().get(key);
  if (snapshot) forkSnapshotStore().delete(key);
  return snapshot ? structuredClone(snapshot) : undefined;
}
