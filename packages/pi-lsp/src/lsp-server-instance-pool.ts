/**
 * The process-wide pool of Server Instances that every Pi session running pi-lsp in one Pi process
 * shares (ADR-0005). Its entries live on `globalThis` under a registered symbol, because Pi
 * evaluates extension modules again on `/reload` and for every in-process Child Agent or Advisor
 * session, so module-level state would not be shared. Only pi-lsp reads or writes the slot; no
 * other package depends on it.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { WorkspaceEdit } from "vscode-languageserver-protocol";
import type { LspPositionEncoding } from "./lsp-position-encoding.js";
import type { LspServerClient } from "./lsp-server-client.js";
import type { LspServerDefinition, LspTimeouts } from "./pi-lsp-settings.js";

/** The versioned `globalThis` slot holding the shared pool's entries by Server Instance key. */
export const LSP_SERVER_INSTANCE_POOL_SLOT = Symbol.for(
  "@ian-pascoe/pi-lsp/server-instance-pool.v1",
);

/** The lifecycle a pooled client must offer. */
export interface LspPooledServerClient {
  /** Gracefully stop the language-server process and release protocol resources. */
  shutdown(): Promise<void>;
}

/** Converts a server-initiated Workspace Edit into a held preview, returning the preview ID. */
export type LspServerWorkspaceEditHandler = (
  edit: WorkspaceEdit,
  positionEncoding: LspPositionEncoding,
) => Promise<string>;

/** What the pool provides to start one shared language-server process. */
export interface LspPooledStartInput {
  /** Aborted once no lease remains, cancelling a startup still in progress. */
  readonly signal: AbortSignal;
  /**
   * Pool-owned stderr file outside every session directory, in a private directory of its own
   * that the client creates and the pool removes when the instance stops.
   */
  readonly stderrPath: string;
  /** Marks the shared instance unavailable to every leaseholder after a process or protocol failure. */
  readonly onUnavailable: (cause: unknown) => void;
  /**
   * Hands a server-initiated edit to the only leaseholder's session, or rejects it when two or
   * more sessions hold leases, because the edit cannot be attributed to one of them.
   */
  readonly onWorkspaceEdit: LspServerWorkspaceEditHandler;
}

/** One session's side of a Server Instance Lease. */
export interface LspServerInstanceLeaseHolder {
  /** Create a held Workspace Edit Preview in this session for a server-initiated edit. */
  readonly onWorkspaceEdit: LspServerWorkspaceEditHandler;
}

/** What a leaseholder gets when the shared startup has ended. */
export type LspServerInstanceOutcome<TClient> =
  | { readonly kind: "running"; readonly client: TClient }
  | { readonly kind: "unavailable"; readonly error: string }
  | { readonly kind: "stopped" };

/** A leased instance's state as one session sees it. */
export type LspServerInstanceLeaseState = "running" | "starting" | "stopped" | "unavailable";

interface LspPoolEntry<TClient> {
  readonly leases: Set<LspServerInstanceLease<TClient>>;
  readonly lifetime: AbortController;
  /** Settles, never rejecting, when startup has ended. */
  started: Promise<void>;
  settled: boolean;
  client: TClient | undefined;
  /** Failure that makes the instance unavailable to every leaseholder until it is stopped. */
  error: string | undefined;
  /** What startup threw, even when it threw because the instance was stopped. */
  startError: string | undefined;
  stderrDirectory: string | undefined;
  /** Present once the instance is stopping; a later lease starts a new instance after it. */
  stopping: Promise<void> | undefined;
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const PackageManifestSchema = Type.Object({ version: Type.String() });

/** The installed pi-lsp version, so copies of different versions never share client code. */
const PI_LSP_VERSION = Value.Parse(
  PackageManifestSchema,
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")),
).version;

/** An object's entries sorted by name, so a key does not depend on the order they were merged in. */
function sortedEntries<T>(record: Readonly<Record<string, T>>): [string, T][] {
  return Object.entries(record).sort(([left], [right]) => (left < right ? -1 : 1));
}

/**
 * The identity of a shared Server Instance: the pi-lsp version, Server Definition ID, workspace
 * root, and everything that shapes the process and its protocol behavior. Routing-only fields,
 * enablement, and `includeHintDiagnostics` are left out. The definition's values are serialized
 * in the order settings resolution produced them, so identical settings give identical keys.
 */
export function lspServerInstanceKey(
  definition: LspServerDefinition,
  rootPath: string,
  timeouts: LspTimeouts,
): string {
  return JSON.stringify([
    PI_LSP_VERSION,
    definition.id,
    rootPath,
    definition.command,
    definition.args,
    sortedEntries(definition.environment),
    definition.initializationOptions ?? null,
    definition.settings ?? null,
    sortedEntries({ ...timeouts }),
    definition.maxConcurrentDiagnostics,
  ]);
}

const UNATTRIBUTABLE_EDIT_REASON =
  "the shared Server Instance cannot attribute the edit to a session";

/** Releases a lease from its pool entry. */
interface LspLeaseOwner<TClient> {
  release(lease: LspServerInstanceLease<TClient>): Promise<void>;
}

/** A Pi session's claim on a shared Server Instance; the instance runs while it has one. */
export class LspServerInstanceLease<TClient> {
  /** Bind the lease to its pool entry; only the pool creates leases. */
  constructor(
    private readonly entry: LspPoolEntry<TClient>,
    readonly holder: LspServerInstanceLeaseHolder,
    private readonly owner: LspLeaseOwner<TClient>,
  ) {}

  /** Whether the lease still holds its instance: not released and the instance not stopped. */
  get active(): boolean {
    return this.entry.leases.has(this);
  }

  /** The running client, while the lease is active and the instance is available. */
  get client(): TClient | undefined {
    return this.active && this.entry.error === undefined ? this.entry.client : undefined;
  }

  /** How many other sessions hold a lease on the same instance. */
  get otherLeaseholders(): number {
    return this.active ? this.entry.leases.size - 1 : 0;
  }

  /** The instance's state as this lease sees it, without waiting. */
  get state(): LspServerInstanceLeaseState {
    if (!this.active) return "stopped";
    if (this.entry.error !== undefined) return "unavailable";
    if (!this.entry.settled) return "starting";
    return this.entry.client === undefined ? "stopped" : "running";
  }

  /** The latest unavailable reason, when the shared instance failed. */
  get error(): string | undefined {
    return this.active ? this.entry.error : undefined;
  }

  /** Wait for the shared startup, then report the client or why there is none. */
  async ready(): Promise<LspServerInstanceOutcome<TClient>> {
    await this.entry.started;
    if (!this.active) {
      return this.entry.startError === undefined
        ? { kind: "stopped" }
        : { kind: "unavailable", error: this.entry.startError };
    }
    if (this.entry.error !== undefined) return { kind: "unavailable", error: this.entry.error };
    const client = this.entry.client;
    return client === undefined ? { kind: "stopped" } : { kind: "running", client };
  }

  /** Release this lease; the instance stops when it was the last one. */
  release(): Promise<void> {
    return this.owner.release(this);
  }
}

/**
 * Reference-counted Server Instances by key. A lease is taken on a session's first use of an
 * instance; sessions leasing an instance that is still starting share its one startup. The
 * instance stops at once when its last lease is released, and a Stop from any session stops it
 * for every leaseholder, who start it again lazily on their next use.
 */
export class LspServerInstancePool<TClient extends LspPooledServerClient> {
  /** Wrap `entries`; a pool of its own unless given the shared slot's entries. */
  constructor(private readonly entries: Map<string, LspPoolEntry<TClient>> = new Map()) {}

  /**
   * Lease the instance for `key`, starting it with `start` when no instance is running or
   * starting. A new instance waits for a previous one with the same key to finish stopping.
   */
  acquire(
    key: string,
    holder: LspServerInstanceLeaseHolder,
    start: (input: LspPooledStartInput) => Promise<TClient>,
  ): LspServerInstanceLease<TClient> {
    const current = this.entries.get(key);
    if (current !== undefined && current.stopping === undefined) {
      return this.addLease(key, current, holder);
    }
    const entry: LspPoolEntry<TClient> = {
      leases: new Set(),
      lifetime: new AbortController(),
      started: Promise.resolve(),
      settled: false,
      client: undefined,
      error: undefined,
      startError: undefined,
      stderrDirectory: undefined,
      stopping: undefined,
    };
    this.entries.set(key, entry);
    const lease = this.addLease(key, entry, holder);
    entry.started = this.launch(key, entry, current?.stopping, start).finally(() => {
      entry.settled = true;
    });
    return lease;
  }

  /** Stop the instance for `key` for every leaseholder; nothing happens when none exists. */
  stop(key: string): Promise<void> {
    const entry = this.entries.get(key);
    return entry === undefined ? Promise.resolve() : this.stopEntry(key, entry);
  }

  private addLease(
    key: string,
    entry: LspPoolEntry<TClient>,
    holder: LspServerInstanceLeaseHolder,
  ): LspServerInstanceLease<TClient> {
    const lease = new LspServerInstanceLease(entry, holder, {
      release: (released) => {
        if (!entry.leases.delete(released)) return entry.stopping ?? Promise.resolve();
        return entry.leases.size === 0 ? this.stopEntry(key, entry) : Promise.resolve();
      },
    });
    entry.leases.add(lease);
    return lease;
  }

  private async launch(
    key: string,
    entry: LspPoolEntry<TClient>,
    previousStop: Promise<void> | undefined,
    start: (input: LspPooledStartInput) => Promise<TClient>,
  ): Promise<void> {
    const { signal } = entry.lifetime;
    if (previousStop !== undefined) {
      try {
        await previousStop;
      } catch (cause) {
        // The leases waiting for a failed Stop fail with it, and the next use starts afresh.
        entry.startError = describeError(cause);
        entry.leases.clear();
        if (this.entries.get(key) === entry) this.entries.delete(key);
        return;
      }
    }
    if (signal.aborted) return;
    // A random name in the temporary directory, so no other process can predict or pre-create it.
    entry.stderrDirectory = join(tmpdir(), `pi-lsp-server-${randomUUID()}`);
    try {
      const client = await start({
        signal,
        stderrPath: join(entry.stderrDirectory, "stderr.log"),
        onUnavailable: (cause) => {
          if (!signal.aborted) entry.error = describeError(cause);
        },
        onWorkspaceEdit: (edit, positionEncoding) => {
          const [sole, ...others] = entry.leases;
          if (sole === undefined || others.length > 0) {
            return Promise.reject(new Error(UNATTRIBUTABLE_EDIT_REASON));
          }
          return sole.holder.onWorkspaceEdit(edit, positionEncoding);
        },
      });
      if (signal.aborted || entry.error !== undefined) {
        await client.shutdown().catch(() => undefined);
        return;
      }
      entry.client = client;
    } catch (cause) {
      entry.startError = describeError(cause);
      if (!signal.aborted) entry.error = entry.startError;
    }
  }

  private stopEntry(key: string, entry: LspPoolEntry<TClient>): Promise<void> {
    if (entry.stopping !== undefined) return entry.stopping;
    entry.leases.clear();
    entry.lifetime.abort();
    entry.stopping = (async () => {
      try {
        await entry.started;
        await entry.client?.shutdown();
      } finally {
        entry.client = undefined;
        if (entry.stderrDirectory !== undefined) {
          await rm(entry.stderrDirectory, { force: true, recursive: true }).catch(() => undefined);
        }
        if (this.entries.get(key) === entry) this.entries.delete(key);
      }
    })();
    return entry.stopping;
  }
}

function sharedEntries(): Map<string, LspPoolEntry<LspServerClient>> {
  const existing: unknown = Object.getOwnPropertyDescriptor(
    globalThis,
    LSP_SERVER_INSTANCE_POOL_SLOT,
  )?.value;
  // Every copy of pi-lsp writes this slot with a Map, and keys name the version that owns each
  // entry, so a copy only ever reads entries of its own shape.
  // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the slot's key names its value type, only pi-lsp writes it, and entry keys include the owning version.
  if (existing instanceof Map) return existing as Map<string, LspPoolEntry<LspServerClient>>;
  const created = new Map<string, LspPoolEntry<LspServerClient>>();
  Object.defineProperty(globalThis, LSP_SERVER_INSTANCE_POOL_SLOT, {
    value: created,
    configurable: true,
  });
  return created;
}

/** The pool every Pi session in this process shares. */
export function sharedLspServerInstancePool(): LspServerInstancePool<LspServerClient> {
  return new LspServerInstancePool(sharedEntries());
}
