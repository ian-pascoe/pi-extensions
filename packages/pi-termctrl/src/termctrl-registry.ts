import { rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  TerminalDriver,
  TerminalExit,
  TerminalHandle,
  TerminalLaunchRequest,
} from "./terminal-driver.js";
import { isDriverGone } from "./terminal-driver.js";
import type { TerminalViewport } from "./pi-termctrl-settings.js";

/** The `globalThis` key every registry version shares. Its value always satisfies {@link RegistrySlot}. */
export const REGISTRY_KEY = Symbol.for("@ian-pascoe/pi-termctrl/registry");
/** Bump on any change to the state's shape: a reloaded module must not adopt an older shape. */
export const REGISTRY_VERSION = 3;

/** Live Terminals plus Background jobs allowed across the whole process. */
export const LIVE_ENTRY_CAP = 16;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_STOP_GRACE_MS = 3_000;
/** How long a stopped Background job may take to report its exit before it is recorded as killed. */
const JOB_STOP_WAIT_MS = 5_000;
const STOP_POLL_MS = 50;
/** How an entry the registry killed is reported. */
export const KILLED_EXIT: TerminalExit = { code: null, signal: "SIGKILL" };
const DRIVER_EXITED: TerminalExit = { code: null, signal: "termctrl driver exited" };

/** The contract every registry version keeps, so a newer module can stop an older registry. */
interface RegistrySlot {
  readonly version: number;
  teardown(): Promise<void>;
}

/** The process side of a Background job: owned by the `bash` replacement, controlled by the registry. */
export interface BackgroundJobChild {
  readonly logPath: string;
  /** Abort the command; Pi's `exec` then kills its whole process tree. */
  stop(): void;
  /** Recent output for previews and Exit notifications. */
  tail(): string;
  removeLog(): Promise<void>;
}

/** Who asked an entry to stop. Agent stops are never notified; user stops are. */
type StopRequester = "agent" | "user";

interface EntryBase {
  readonly id: string;
  /** Session id of the Pi session that started the entry. */
  readonly owner: string;
  /** The command as the agent wrote it. */
  readonly command: string;
  readonly startedAt: number;
  state: "running" | "exited";
  exit: TerminalExit | null;
  exitedAt: number | undefined;
  /** The agent already saw this exit, so no Exit notification is due. */
  seen: boolean;
  stopRequested: StopRequester | undefined;
  readonly notify: boolean;
}

/** A PTY program driven through termctrl. */
export interface TerminalEntry extends EntryBase {
  readonly kind: "terminal";
  readonly handle: TerminalHandle;
  readonly generation: number;
  readonly cwd: string;
  /** The screen captured when the Terminal exited. */
  finalScreen: string | undefined;
  /** Number of agent tool calls currently driving this Terminal; the exit watcher skips them. */
  activeCalls: number;
  /** The screen the agent last received, for `changed: false`. */
  lastScreen: string | undefined;
  /** Count of log lines that scrolled off before the agent's last result. */
  logCursor: number;
  /**
   * Lines that locate `logCursor` again after termctrl trims its scrollback from the top: the
   * last lines before the cursor, or, while the cursor is 0, the log's first line.
   */
  logAnchor: readonly string[];
}

/** A `bash` command moved to the background. */
export interface BackgroundJobEntry extends EntryBase {
  readonly kind: "job";
  readonly child: BackgroundJobChild;
  readonly settled: Promise<void>;
  readonly settle: () => void;
}

/** A Terminal or a Background job. */
export type TermctrlEntry = TerminalEntry | BackgroundJobEntry;

/** One exit the agent has not seen, captured when it happened. */
export interface ExitNotice {
  readonly id: string;
  readonly kind: TermctrlEntry["kind"];
  readonly command: string;
  readonly exit: TerminalExit;
  readonly durationMs: number;
  /** The final screen of a Terminal or the recent log output of a Background job. */
  readonly output: string;
}

/** Delivers a batch of Exit notifications to one owner session. Throwing keeps the batch queued. */
export type NotificationDelivery = (notices: readonly ExitNotice[]) => void;

/** Request to start one Terminal. */
export interface TerminalStartRequest {
  readonly command: TerminalLaunchRequest["command"];
  readonly displayCommand: string;
  readonly cwd: string;
  readonly viewport: TerminalViewport;
  readonly notify: boolean;
}

/** Collaborators rebound by each module load. */
export interface RegistryDependencies {
  readonly createDriver: () => Promise<TerminalDriver>;
  readonly pollIntervalMs?: number;
  readonly stopGraceMs?: number;
}

interface DriverSlot {
  readonly driver: TerminalDriver;
  readonly generation: number;
}

/** Version 2 of the process-wide state. Only plain data and SDK handles; never `pi` or `ctx`. */
interface RegistryStateV2 extends RegistrySlot {
  readonly version: typeof REGISTRY_VERSION;
  nextTerminal: number;
  nextJob: number;
  nextOutputFile: number;
  /** Full output files of truncated Terminal results, by owner; deleted when the owner shuts down. */
  readonly outputFiles: Map<string, string[]>;
  reserved: number;
  generation: number;
  readonly entries: Map<string, TermctrlEntry>;
  driver: DriverSlot | undefined;
  driverStarting: Promise<DriverSlot> | undefined;
  readonly owners: Map<string, NotificationDelivery>;
  readonly pending: Map<string, ExitNotice[]>;
  flushScheduled: boolean;
  watcher: ReturnType<typeof setInterval> | undefined;
  polling: boolean;
  readonly changeListeners: Set<() => void>;
  /** The registry built by the most recently loaded module; listeners always call through it. */
  current: TermctrlRegistry;
}

function readSlot(): RegistrySlot | undefined {
  const slot: RegistrySlot | undefined = Object.getOwnPropertyDescriptor(
    globalThis,
    REGISTRY_KEY,
  )?.value;
  return slot;
}

function isCurrentVersion(slot: RegistrySlot): slot is RegistryStateV2 {
  return slot.version === REGISTRY_VERSION;
}

function writeSlot(state: RegistryStateV2): void {
  Object.defineProperty(globalThis, REGISTRY_KEY, {
    value: state,
    configurable: true,
    enumerable: false,
    writable: true,
  });
}

function clearSlot(state: RegistrySlot): void {
  if (readSlot() === state) Reflect.deleteProperty(globalThis, REGISTRY_KEY);
}

function describeEntry(entry: TermctrlEntry): string {
  return `${entry.id} (${entry.kind === "terminal" ? "Terminal" : "Background job"}) ${entry.command}`;
}

function delay(milliseconds: number): Promise<"timeout"> {
  return new Promise((resolve) => setTimeout(() => resolve("timeout"), milliseconds));
}

/**
 * The process-wide registry of Terminals and Background jobs. One instance exists per module load;
 * all of them share the versioned `globalThis` state, and only the newest is called by listeners.
 */
export class TermctrlRegistry {
  private constructor(
    private readonly state: RegistryStateV2,
    private readonly dependencies: RegistryDependencies,
  ) {}

  /** Adopt the process registry, tearing down an unknown version, and rebind it to this module. */
  static acquire(dependencies: RegistryDependencies): TermctrlRegistry {
    const slot = readSlot();
    if (slot !== undefined && isCurrentVersion(slot)) {
      const registry = new TermctrlRegistry(slot, dependencies);
      slot.current = registry;
      if (slot.watcher !== undefined) {
        clearInterval(slot.watcher);
        slot.watcher = undefined;
        registry.syncWatcher();
      }
      return registry;
    }
    if (slot !== undefined) {
      clearSlot(slot);
      void slot.teardown().catch(() => {});
    }
    const state: Omit<RegistryStateV2, "current" | "teardown"> & Partial<RegistryStateV2> = {
      version: REGISTRY_VERSION,
      nextTerminal: 1,
      nextJob: 1,
      nextOutputFile: 1,
      outputFiles: new Map(),
      reserved: 0,
      generation: 0,
      entries: new Map(),
      driver: undefined,
      driverStarting: undefined,
      owners: new Map(),
      pending: new Map(),
      flushScheduled: false,
      watcher: undefined,
      polling: false,
      changeListeners: new Set(),
    };
    const complete: RegistryStateV2 = Object.assign(state, {
      teardown: () => complete.current.teardownAll(),
      current: undefined!,
    });
    const registry = new TermctrlRegistry(complete, dependencies);
    complete.current = registry;
    writeSlot(complete);
    return registry;
  }

  /** The registry of the most recently loaded module, for listeners that outlive their module. */
  static current(): TermctrlRegistry | undefined {
    const slot = readSlot();
    return slot !== undefined && isCurrentVersion(slot) ? slot.current : undefined;
  }

  /** Stop everything in the process registry and remove it. Tests use this between cases. */
  static async teardownForTests(): Promise<void> {
    await readSlot()?.teardown();
  }

  // ── Owners and notifications ──────────────────────────────────────────────

  /** Bind an owner session so its Exit notifications are delivered, flushing any queued ones. */
  bindOwner(owner: string, delivery: NotificationDelivery): void {
    this.state.owners.set(owner, delivery);
    if (this.state.pending.has(owner)) this.scheduleFlush();
  }

  /** Unbind an owner whose `pi` is going stale; its notifications queue until it binds again. */
  unbindOwner(owner: string): void {
    this.state.owners.delete(owner);
  }

  /** Deliver queued notifications to bound owners. Called through the current registry only. */
  flush(): void {
    this.state.flushScheduled = false;
    for (const [owner, notices] of Array.from(this.state.pending)) {
      const delivery = this.state.owners.get(owner);
      if (delivery === undefined) continue;
      const due = notices.filter((notice) => this.state.entries.get(notice.id)?.seen !== true);
      this.state.pending.delete(owner);
      if (due.length === 0) continue;
      try {
        delivery(due);
        for (const notice of due) this.markSeen(notice.id);
      } catch {
        this.state.owners.delete(owner);
        this.state.pending.set(owner, [...due, ...(this.state.pending.get(owner) ?? [])]);
      }
    }
  }

  private scheduleFlush(): void {
    if (this.state.flushScheduled) return;
    this.state.flushScheduled = true;
    const state = this.state;
    setImmediate(() => state.current.flush());
  }

  private queueNotice(entry: TermctrlEntry, output: string): void {
    if (!entry.notify || entry.seen || entry.stopRequested === "agent" || entry.exit === null) {
      return;
    }
    const notices = this.state.pending.get(entry.owner) ?? [];
    notices.push({
      id: entry.id,
      kind: entry.kind,
      command: entry.command,
      exit: entry.exit,
      durationMs: (entry.exitedAt ?? Date.now()) - entry.startedAt,
      output,
    });
    this.state.pending.set(entry.owner, notices);
    this.scheduleFlush();
  }

  /** Record that the agent has seen an entry's exit in a tool result. */
  markSeen(id: string): void {
    const entry = this.state.entries.get(id);
    if (entry !== undefined) entry.seen = true;
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  /** Every entry in the process, oldest first. Only the human-facing `/ps` uses this. */
  entries(): readonly TermctrlEntry[] {
    return [...this.state.entries.values()];
  }

  /** Entries started by one owner session. */
  ownedEntries(owner: string): readonly TermctrlEntry[] {
    return this.entries().filter((entry) => entry.owner === owner);
  }

  /** Look up an entry the owner may act on. */
  find(owner: string, id: string): TermctrlEntry | undefined {
    const entry = this.state.entries.get(id);
    return entry?.owner === owner ? entry : undefined;
  }

  /** Look up any entry, for the human-facing `/ps`. */
  get(id: string): TermctrlEntry | undefined {
    return this.state.entries.get(id);
  }

  /** Live Terminals and Background jobs across the process. */
  runningCount(): number {
    return this.entries().filter((entry) => entry.state === "running").length;
  }

  /** Subscribe to entry additions, exits and removals. */
  onChange(listener: () => void): () => void {
    this.state.changeListeners.add(listener);
    return () => this.state.changeListeners.delete(listener);
  }

  private emitChange(): void {
    for (const listener of Array.from(this.state.changeListeners)) {
      try {
        listener();
      } catch {
        // A failing UI listener must not break process bookkeeping.
      }
    }
  }

  /** Throw the cap error, listing the caller's live entries, when no new entry may start. */
  checkCapacity(owner: string): void {
    if (this.runningCount() + this.state.reserved < LIVE_ENTRY_CAP) return;
    const live = this.ownedEntries(owner).filter((entry) => entry.state === "running");
    const listed = live.length === 0 ? "none" : live.map(describeEntry).join(", ");
    throw new Error(
      `Cannot start: ${LIVE_ENTRY_CAP} Terminals and Background jobs are already running (the limit). Your live entries: ${listed}. Stop one with terminal_stop.`,
    );
  }

  // ── Terminals ─────────────────────────────────────────────────────────────

  /** Start a Terminal on the shared driver, starting a driver first when none is alive. */
  async startTerminal(owner: string, request: TerminalStartRequest): Promise<TerminalEntry> {
    this.checkCapacity(owner);
    this.state.reserved++;
    try {
      const id = `t${this.state.nextTerminal++}`;
      const launch: TerminalLaunchRequest = {
        id,
        command: request.command,
        cwd: request.cwd,
        viewport: request.viewport,
      };
      let slot = await this.ensureDriver();
      let handle: TerminalHandle;
      try {
        handle = await slot.driver.launch(launch);
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        if (!isDriverGone(error)) throw error;
        this.driverDied(slot.generation);
        slot = await this.ensureDriver();
        handle = await slot.driver.launch(launch);
      }
      const entry: TerminalEntry = {
        kind: "terminal",
        id,
        owner,
        command: request.displayCommand,
        cwd: request.cwd,
        startedAt: Date.now(),
        state: "running",
        exit: null,
        exitedAt: undefined,
        seen: false,
        stopRequested: undefined,
        notify: request.notify,
        handle,
        generation: slot.generation,
        finalScreen: undefined,
        activeCalls: 0,
        lastScreen: undefined,
        logCursor: 0,
        logAnchor: [],
      };
      this.state.entries.set(id, entry);
      this.syncWatcher();
      this.emitChange();
      return entry;
    } finally {
      this.state.reserved--;
    }
  }

  private async ensureDriver(): Promise<DriverSlot> {
    if (this.state.driver !== undefined) return this.state.driver;
    if (this.state.driverStarting !== undefined) return this.state.driverStarting;
    const state = this.state;
    const starting = this.dependencies.createDriver().then((driver) => {
      const slot = { driver, generation: ++state.generation };
      state.driver = slot;
      return slot;
    });
    state.driverStarting = starting;
    try {
      return await starting;
    } finally {
      state.driverStarting = undefined;
    }
  }

  /** Mark every Terminal of a dead driver exited; the next start creates a new driver. */
  driverDied(generation: number): void {
    if (this.state.driver?.generation === generation) this.state.driver = undefined;
    for (const entry of this.entries()) {
      if (entry.kind === "terminal" && entry.generation === generation) {
        this.terminalExited(entry.id, DRIVER_EXITED, entry.lastScreen ?? "", false);
      }
    }
  }

  /** Record a Terminal's exit, as seen by a tool call (`seen`) or by the exit watcher. */
  terminalExited(id: string, exit: TerminalExit, finalScreen: string, seen: boolean): void {
    const entry = this.state.entries.get(id);
    if (entry?.kind !== "terminal" || entry.state === "exited") return;
    entry.state = "exited";
    entry.exit = exit;
    entry.exitedAt = Date.now();
    entry.finalScreen = finalScreen;
    if (seen) entry.seen = true;
    this.queueNotice(entry, finalScreen);
    this.syncWatcher();
    this.emitChange();
    this.closeIdleDriver();
  }

  /** Report a driver failure seen while a tool drove one of its Terminals. */
  reportTerminalError(entry: TerminalEntry, cause: Error): boolean {
    if (!isDriverGone(cause)) return false;
    this.driverDied(entry.generation);
    return true;
  }

  private syncWatcher(): void {
    const needed = this.entries().some(
      (entry) => entry.kind === "terminal" && entry.state === "running",
    );
    if (needed && this.state.watcher === undefined) {
      const state = this.state;
      state.watcher = setInterval(
        () => void state.current.pollTerminals(),
        this.dependencies.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      );
      state.watcher.unref?.();
    } else if (!needed && this.state.watcher !== undefined) {
      clearInterval(this.state.watcher);
      this.state.watcher = undefined;
    }
  }

  /** Detect Terminal exits nobody is waiting on. Called by the watcher through the current registry. */
  async pollTerminals(): Promise<void> {
    if (this.state.polling) return;
    this.state.polling = true;
    try {
      for (const entry of this.entries()) {
        if (entry.kind !== "terminal" || entry.state !== "running") continue;
        if (entry.activeCalls > 0 || entry.stopRequested !== undefined) continue;
        try {
          const snapshot = await entry.handle.snapshot();
          if (entry.activeCalls > 0 || entry.state !== "running") continue;
          if (snapshot.state === "exited") {
            this.terminalExited(entry.id, snapshot.exit ?? DRIVER_EXITED, snapshot.screen, false);
          }
        } catch (cause) {
          this.reportTerminalError(
            entry,
            cause instanceof Error ? cause : new Error(String(cause)),
          );
        }
      }
    } finally {
      this.state.polling = false;
    }
  }

  private closeIdleDriver(): void {
    const slot = this.state.driver;
    if (slot === undefined) return;
    const inUse = this.entries().some(
      (entry) =>
        entry.kind === "terminal" &&
        entry.generation === slot.generation &&
        entry.state === "running",
    );
    if (inUse || this.state.reserved > 0) return;
    this.state.driver = undefined;
    void slot.driver.close().catch(() => {});
  }

  // ── Background jobs ───────────────────────────────────────────────────────

  /**
   * Register a Background job. `start` receives the new id and returns the job's process side;
   * `startedAt` is when the command itself started, before it was backgrounded.
   */
  createJob(
    owner: string,
    command: string,
    start: (id: string) => BackgroundJobChild,
    startedAt = Date.now(),
  ): BackgroundJobEntry {
    this.checkCapacity(owner);
    const id = `b${this.state.nextJob++}`;
    const child = start(id);
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const entry: BackgroundJobEntry = {
      kind: "job",
      id,
      owner,
      command,
      startedAt,
      state: "running",
      exit: null,
      exitedAt: undefined,
      seen: false,
      stopRequested: undefined,
      notify: true,
      child,
      settled,
      settle,
    };
    this.state.entries.set(id, entry);
    this.emitChange();
    return entry;
  }

  /** Record a Background job's exit. Called by the job's `exec` listener through the current registry. */
  jobExited(id: string, exit: TerminalExit): void {
    const entry = this.state.entries.get(id);
    if (entry?.kind !== "job" || entry.state === "exited") return;
    entry.state = "exited";
    entry.exit = exit;
    entry.exitedAt = Date.now();
    entry.settle();
    this.queueNotice(entry, entry.child.tail());
    this.emitChange();
  }

  // ── Stopping and removal ──────────────────────────────────────────────────

  /** The agent stops an entry: no notification follows, and the entry is removed. */
  async stop(owner: string, id: string): Promise<TermctrlEntry | undefined> {
    const entry = this.find(owner, id);
    if (entry === undefined) return undefined;
    await this.retire(entry);
    const pending = this.state.pending.get(owner)?.filter((notice) => notice.id !== id);
    if (pending !== undefined) this.state.pending.set(owner, pending);
    return entry;
  }

  /** Stop and remove an entry on the agent's or its session's behalf, without a notification. */
  private async retire(entry: TermctrlEntry): Promise<void> {
    entry.stopRequested ??= "agent";
    entry.seen = true;
    await this.stopEntry(entry);
    await this.removeEntry(entry);
  }

  /** The user stops an entry from `/ps`: it stays listed as exited and the agent is notified. */
  async stopByUser(id: string): Promise<void> {
    const entry = this.state.entries.get(id);
    if (entry === undefined || entry.state === "exited") return;
    entry.stopRequested ??= "user";
    await this.stopEntry(entry);
  }

  /** Remove an exited entry, deleting a Background job's log. Running entries are kept. */
  async remove(id: string): Promise<boolean> {
    const entry = this.state.entries.get(id);
    if (entry === undefined || entry.state === "running") return false;
    await this.removeEntry(entry);
    return true;
  }

  /** Stop and remove every entry an owner started, and drop its queued notifications. */
  async shutdownOwner(owner: string): Promise<void> {
    this.unbindOwner(owner);
    this.state.pending.delete(owner);
    await Promise.all(this.ownedEntries(owner).map((entry) => this.retire(entry)));
    await this.removeOutputFiles(owner);
  }

  /**
   * Reserve a path in `directory` for the full output of a truncated Terminal result. The file
   * outlives the Terminal, so `terminal_stop` can point to it, until its owner's session shuts down.
   */
  reserveOutputFile(owner: string, id: string, directory: string): string {
    const path = join(directory, `${process.pid}-${id}-output-${this.state.nextOutputFile++}.log`);
    const paths = this.state.outputFiles.get(owner) ?? [];
    paths.push(path);
    this.state.outputFiles.set(owner, paths);
    return path;
  }

  private async removeOutputFiles(owner: string): Promise<void> {
    const paths = this.state.outputFiles.get(owner) ?? [];
    this.state.outputFiles.delete(owner);
    await Promise.all(paths.map((path) => rm(path, { force: true }).catch(() => {})));
  }

  /** Stop everything in the process and release the global slot. */
  async teardownAll(): Promise<void> {
    clearSlot(this.state);
    if (this.state.watcher !== undefined) clearInterval(this.state.watcher);
    this.state.watcher = undefined;
    this.state.pending.clear();
    this.state.owners.clear();
    await Promise.all(this.entries().map((entry) => this.retire(entry)));
    await Promise.all(
      [...this.state.outputFiles.keys()].map((owner) => this.removeOutputFiles(owner)),
    );
    const slot = this.state.driver;
    this.state.driver = undefined;
    await slot?.driver.close().catch(() => {});
  }

  private async stopEntry(entry: TermctrlEntry): Promise<void> {
    if (entry.state === "exited") return;
    if (entry.kind === "job") {
      entry.child.stop();
      const outcome = await Promise.race([entry.settled, delay(JOB_STOP_WAIT_MS)]);
      if (outcome === "timeout") this.jobExited(entry.id, KILLED_EXIT);
      return;
    }
    await this.stopTerminal(entry);
  }

  private async stopTerminal(entry: TerminalEntry): Promise<void> {
    const seen = entry.stopRequested === "agent";
    let screen = entry.lastScreen ?? "";
    let exit = KILLED_EXIT;
    try {
      const snapshot = await entry.handle.snapshot();
      screen = snapshot.screen;
      if (snapshot.state === "exited" && snapshot.exit !== null) exit = snapshot.exit;
    } catch {
      // The Terminal may already be gone; keep the last screen the agent saw.
    }
    const graceMs = this.dependencies.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), graceMs);
    });
    const startedAt = performance.now();
    const stopped = entry.handle.stop().then(
      () => "stopped" as const,
      () => "failed" as const,
    );
    const outcome = await Promise.race([stopped, grace]);
    clearTimeout(timer);
    // termctrl may forget the Terminal while its process still runs; give it the rest of the grace.
    let remainingMs = graceMs - (performance.now() - startedAt);
    while (outcome === "stopped" && entry.handle.isAlive() && remainingMs > 0) {
      await delay(STOP_POLL_MS);
      remainingMs -= STOP_POLL_MS;
    }
    if (outcome !== "stopped" || entry.handle.isAlive()) entry.handle.kill();
    this.terminalExited(entry.id, exit, screen, seen);
  }

  private async removeEntry(entry: TermctrlEntry): Promise<void> {
    if (!this.state.entries.delete(entry.id)) return;
    if (entry.kind === "job") await entry.child.removeLog().catch(() => {});
    this.syncWatcher();
    this.emitChange();
    this.closeIdleDriver();
  }
}
