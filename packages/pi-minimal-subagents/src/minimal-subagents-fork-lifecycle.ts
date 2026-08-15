import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { ForkSnapshot } from "./minimal-subagents-types.js";

const FORK_SNAPSHOT_SYMBOL = Symbol.for("minimal-subagents.pending-fork-snapshots.v2");

type GlobalWithForkSnapshots = typeof globalThis & {
  [FORK_SNAPSHOT_SYMBOL]?: Map<string, ForkSnapshot>;
};

function forkSnapshotStore(): Map<string, ForkSnapshot> {
  const processGlobal = globalThis as GlobalWithForkSnapshots;
  processGlobal[FORK_SNAPSHOT_SYMBOL] ??= new Map();
  return processGlobal[FORK_SNAPSHOT_SYMBOL];
}

function canonicalSessionFile(sessionFile: string): string {
  const absolutePath = resolve(sessionFile);
  return existsSync(absolutePath) ? realpathSync(absolutePath) : absolutePath;
}

/** Prove a process-loss fork destination was derived from the expected canonical source file. */
export function isForkDestinationForSource(
  destinationHeader: { parentSession?: string } | null,
  previousSessionFile: string,
): boolean {
  return (
    destinationHeader?.parentSession !== undefined &&
    canonicalSessionFile(destinationHeader.parentSession) ===
      canonicalSessionFile(previousSessionFile)
  );
}

/** Retain a complete pre-fork hierarchy across Pi extension-instance replacement. */
export function rememberForkSnapshot(snapshot: ForkSnapshot): void {
  const canonicalSourceFile = canonicalSessionFile(snapshot.source_root_session_file);
  const retained = structuredClone(snapshot);
  retained.source_root_session_file = canonicalSourceFile;
  forkSnapshotStore().set(canonicalSourceFile, retained);
}

/** Consume the pre-fork hierarchy once when the destination root session starts. */
export function takeForkSnapshot(previousSessionFile: string): ForkSnapshot | undefined {
  const key = canonicalSessionFile(previousSessionFile);
  const snapshot = forkSnapshotStore().get(key);
  if (snapshot) forkSnapshotStore().delete(key);
  return snapshot ? structuredClone(snapshot) : undefined;
}
