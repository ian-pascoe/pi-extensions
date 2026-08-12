import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { ForkSnapshot } from "./minimal-subagents-types.js";

const FORK_SNAPSHOT_SYMBOL = Symbol.for("minimal-subagents.pending-fork-snapshots.v1");

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

/** Retain a complete pre-fork hierarchy across Pi extension-instance replacement. */
export function rememberForkSnapshot(snapshot: ForkSnapshot): void {
  forkSnapshotStore().set(
    canonicalSessionFile(snapshot.source_root_session_file),
    structuredClone(snapshot),
  );
}

/** Consume the pre-fork hierarchy once when the destination root session starts. */
export function takeForkSnapshot(previousSessionFile: string): ForkSnapshot | undefined {
  const key = canonicalSessionFile(previousSessionFile);
  const snapshot = forkSnapshotStore().get(key);
  if (snapshot) forkSnapshotStore().delete(key);
  return snapshot ? structuredClone(snapshot) : undefined;
}
