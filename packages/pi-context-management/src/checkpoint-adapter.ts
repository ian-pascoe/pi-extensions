import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  AgentSession,
  SessionManager,
  type CompactionEntry,
  type ExtensionAPI,
  type ExtensionHandler,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { assertContextJournalReadable, quarantineContextJournal } from "./context-store.js";

const AdapterSlot = Symbol.for("@ian-pascoe/pi-context-management/checkpoint-adapter");
const Callable = Type.Function([], Type.Unknown());
const Capabilities = Type.Object({
  abortCompaction: Callable,
  getContextUsage: Callable,
  resourceLoader: Type.Object({ getExtensions: Callable }),
  extensionRunner: Type.Object({ emit: Callable, hasHandlers: Callable }),
  settingsManager: Type.Object({
    getGlobalSettings: Callable,
    getProjectSettings: Callable,
    isProjectTrusted: Callable,
  }),
  agent: Type.Object({
    abort: Callable,
    prepareNextTurnWithContext: Callable,
    transformContext: Callable,
    state: Type.Object({
      messages: Type.Array(Type.Unknown()),
      tools: Type.Array(Type.Unknown()),
      systemPrompt: Type.String(),
    }),
  }),
  sessionManager: Type.Object({
    getHeader: Callable,
    getSessionId: Callable,
    getLeafId: Callable,
    getEntry: Callable,
    getEntries: Callable,
    getBranch: Callable,
    getSessionFile: Callable,
    appendCompaction: Callable,
    appendCustomEntry: Callable,
    buildSessionContext: Callable,
    resetLeaf: Callable,
    branch: Callable,
  }),
});
const Disposable = Type.Object({ dispose: Callable });
const CancelledCompaction = Type.Object({ cancel: Type.Literal(true) });
const PassiveCompaction = Type.Object({
  cancel: Type.Optional(Type.Literal(false)),
  compaction: Type.Optional(Type.Undefined()),
});
const ProvidedCompaction = Type.Object({
  compaction: Type.Object({
    summary: Type.String({ minLength: 1 }),
    firstKeptEntryId: Type.String({ minLength: 1 }),
    tokensBefore: Type.Number({ minimum: 0 }),
  }),
});

export interface CheckpointAdapterOptions {
  /** Guard actual native hook results without rejecting passive listeners or cancellation. */
  readonly compaction?: {
    readonly handler: ExtensionHandler<SessionBeforeCompactEvent, unknown>;
    readonly onConflict: (error: Error) => void;
  };
  /** Checks the final public projections. A native commit reapplies those projections once, then validates without allowing another commit. */
  readonly afterTransformContext?: (
    messages: AgentMessage[],
    signal: AbortSignal | undefined,
    canRollover: boolean,
  ) => AgentMessage[] | void | Promise<AgentMessage[] | void>;
}

/** The sole capability-gated mutable Pi integration; the caller owns safe batch placement and policy. */
export interface CheckpointAdapter {
  readonly session: AgentSession;
  /** Last append acknowledged by the native journal method, including native compaction paths. */
  readonly lastCommittedCheckpointId: string | undefined;
  commit<T>(
    summary: string,
    firstKeptEntryId: string | undefined,
    tokensBefore: number,
    details: T,
    signal?: AbortSignal,
  ): CompactionEntry<T>;
  /** Returns a real cutoff for a native compaction hook; an absent Tail creates a neutral entry. */
  cutoff(firstKeptEntryId: string | undefined): string;
  /** Stops requests until disposal/reload. Does not roll back a possibly durable native checkpoint. */
  fault(error: Error): void;
  dispose(): void;
}

function writable(
  owner: AgentSession["agent"] | AgentSession["agent"]["state"],
  key: PropertyKey,
): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  // oxlint-disable-next-line typescript/unbound-method -- Capability parsing inspects the setter without calling it.
  return descriptor?.writable === true || Value.Check(Callable, descriptor?.set);
}

function capture(pi: Pick<ExtensionAPI, "getAllTools">): AgentSession {
  const prototype = AgentSession.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "getAllTools");
  if (!descriptor?.configurable || !Value.Check(Callable, descriptor.value)) {
    throw new Error(
      "Context Management capability unavailable: AgentSession.getAllTools data method",
    );
  }
  const original = descriptor.value;
  let session: AgentSession | undefined;
  Object.defineProperty(prototype, "getAllTools", {
    ...descriptor,
    value(this: AgentSession) {
      // oxlint-disable-next-line typescript/no-this-alias -- Exact synchronous receiver capture, restored in finally; SDK tests verify restoration.
      session = this;
      return original.call(this);
    },
  });
  try {
    pi.getAllTools();
  } finally {
    Object.defineProperty(prototype, "getAllTools", descriptor);
  }
  if (!(session instanceof AgentSession) || !(session.sessionManager instanceof SessionManager)) {
    throw new Error(
      "Context Management could not capture the native AgentSession and SessionManager",
    );
  }
  // Capture even a quarantined owner so replacement request guards can be installed on /reload.
  // Every request and mutation checks journal readability in ready().
  if (!Value.Check(Capabilities, session)) {
    throw new Error(
      "Context Management capability unavailable: required session/checkpoint methods",
    );
  }
  if (
    !writable(session.agent.state, "messages") ||
    !writable(session.agent, "prepareNextTurnWithContext") ||
    !writable(session.agent, "transformContext")
  ) {
    throw new Error(
      "Context Management capability unavailable: writable native messages/next-turn hook",
    );
  }
  return session;
}

/** Captures the owner without importing another extension or maintaining a shadow Context Window. */
export function captureCheckpointAdapter(
  pi: Pick<ExtensionAPI, "getAllTools">,
  options: CheckpointAdapterOptions = {},
): CheckpointAdapter {
  const session = capture(pi);
  const agent = session.agent;
  const manager = session.sessionManager;
  const runner = session.extensionRunner;
  const existing = Object.getOwnPropertyDescriptor(agent, AdapterSlot)?.value;
  if (existing !== undefined) {
    if (!Value.Check(Disposable, existing))
      throw new Error("Context Management adapter ownership conflict");
    existing.dispose();
  }
  const previous = agent.prepareNextTurnWithContext;
  const previousTransform = agent.transformContext;
  if (!previous || !previousTransform)
    throw new Error("Context Management request hook disappeared during capture");
  let active = true;
  let refresh = false;
  let failure: Error | undefined;
  let committedCheckpointId: string | undefined;
  let verifyingProjection = false;
  const appendDescriptor = Object.getOwnPropertyDescriptor(manager, "appendCompaction");
  if (
    manager.appendCompaction !== SessionManager.prototype.appendCompaction ||
    (appendDescriptor ? appendDescriptor.writable !== true : !Object.isExtensible(manager))
  ) {
    throw new Error("Context Management requires the unwrapped native appendCompaction method");
  }
  const emitDescriptor = Object.getOwnPropertyDescriptor(runner, "emit");
  const hasHandlersDescriptor = Object.getOwnPropertyDescriptor(runner, "hasHandlers");
  if (
    (emitDescriptor ? emitDescriptor.writable !== true : !Object.isExtensible(runner)) ||
    (hasHandlersDescriptor ? hasHandlersDescriptor.writable !== true : !Object.isExtensible(runner))
  ) {
    throw new Error("Context Management capability unavailable: writable extension event dispatch");
  }
  const hasHandlers = runner.hasHandlers.bind(runner);
  // Native compaction must reach our result guard even if its registered handler disappears.
  const hasHandlersWrapper: typeof runner.hasHandlers = (event) =>
    active && options.compaction && event === "session_before_compact" ? true : hasHandlers(event);
  const emit = runner.emit.bind(runner);
  const emitWrapper: typeof runner.emit = async (event) => {
    const policy = options.compaction;
    if (!active || !policy || event.type !== "session_before_compact") return emit(event);
    const restoreHandlers: Array<() => void> = [];
    let ownResult: unknown;
    try {
      ready();
      for (const extension of session.resourceLoader.getExtensions().extensions) {
        const handlers = extension.handlers.get("session_before_compact");
        if (!handlers) continue;
        for (const [index, handler] of handlers.entries()) {
          const guarded: typeof handler = async (...args) => {
            const result = await handler(...args);
            if (handler === policy.handler) {
              ownResult = result;
              return result;
            }
            if (!result || Value.Check(PassiveCompaction, result)) return;
            if (Value.Check(CancelledCompaction, result)) return { cancel: true };
            policy.onConflict(
              new Error(
                `Competing compaction result from ${extension.path}; disable its compaction override`,
              ),
            );
            return { cancel: true };
          };
          handlers[index] = guarded;
          restoreHandlers.push(() => {
            if (handlers[index] === guarded) handlers[index] = handler;
          });
        }
      }
      const result = await emit(event);
      if (
        !Value.Check(CancelledCompaction, result) &&
        (result !== ownResult || !Value.Check(ProvidedCompaction, ownResult))
      ) {
        throw new Error(
          "Context Management compaction result missing or replaced; refusing native summarizer fallback",
        );
      }
      return result;
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      policy.onConflict(error);
      throw new Error("Compaction cancelled", { cause: error });
    } finally {
      for (const restore of restoreHandlers.reverse()) restore();
    }
  };
  const appendCompaction = manager.appendCompaction.bind(manager);
  const appendWrapper: SessionManager["appendCompaction"] = (...args) => {
    const id = appendCompaction(...args);
    if (active) committedCheckpointId = id;
    return id;
  };

  function ready(): void {
    if (!active) throw new Error("Context Management adapter has been disposed");
    if (failure) throw failure;
    assertContextJournalReadable(manager);
    if (
      !Value.Check(Capabilities, session) ||
      !writable(agent.state, "messages") ||
      manager.appendCompaction !== appendWrapper ||
      runner.emit !== emitWrapper ||
      runner.hasHandlers !== hasHandlersWrapper
    ) {
      const error = new Error("Context Management native checkpoint capability lost");
      adapter.fault(error);
      throw error;
    }
  }

  function durable(): void {
    ready();
    if (
      !manager.getSessionFile() ||
      !manager
        .getEntries()
        .some((entry) => entry.type === "message" && entry.message.role === "assistant")
    ) {
      throw new Error(
        "Context Checkpoint requires a persistent session with a recorded assistant turn; shorten the initial request or select a persistent session",
      );
    }
  }

  function restoreLeaf(leaf: string | null): void {
    if (leaf === null) manager.resetLeaf();
    else manager.branch(leaf);
  }

  const wrapper: NonNullable<typeof previous> = async (turn, signal) => {
    if (!active) return previous.call(agent, turn, signal);
    ready();
    signal?.throwIfAborted();
    turn = {
      ...turn,
      context: {
        ...turn.context,
        systemPrompt: agent.state.systemPrompt,
        tools: agent.state.tools,
        messages: refresh ? agent.state.messages.slice() : turn.context.messages,
      },
    };
    const snapshot = await previous.call(agent, turn, signal);
    // A thrown preceding hook must not consume the refresh needed by a later retry.
    refresh = false;
    return snapshot;
  };

  const transformWrapper: NonNullable<typeof previousTransform> = async (messages, signal) => {
    if (!active) return previousTransform.call(agent, messages, signal);
    ready();
    signal?.throwIfAborted();
    const before = committedCheckpointId;
    let projected = await previousTransform.call(agent, messages, signal);
    signal?.throwIfAborted();
    projected = (await options.afterTransformContext?.(projected, signal, true)) ?? projected;
    ready();
    signal?.throwIfAborted();
    if (committedCheckpointId !== before) {
      projected = await previousTransform.call(agent, agent.state.messages.slice(), signal);
      signal?.throwIfAborted();
      verifyingProjection = true;
      try {
        projected = (await options.afterTransformContext?.(projected, signal, false)) ?? projected;
      } finally {
        verifyingProjection = false;
      }
      ready();
      signal?.throwIfAborted();
    }
    return projected;
  };

  const adapter: CheckpointAdapter = {
    session,
    get lastCommittedCheckpointId() {
      return committedCheckpointId;
    },
    cutoff(firstKeptEntryId) {
      durable();
      if (firstKeptEntryId !== undefined) {
        if (!manager.getBranch().some((entry) => entry.id === firstKeptEntryId)) {
          throw new Error("Context Checkpoint cutoff is not on the selected session branch");
        }
        return firstKeptEntryId;
      }
      const before = manager.getLeafId();
      try {
        return manager.appendCustomEntry("pi-context-management-empty-tail", { version: 1 });
      } catch (cause) {
        restoreLeaf(before);
        quarantineContextJournal(manager);
        adapter.fault(cause instanceof Error ? cause : new Error(String(cause)));
        throw cause;
      }
    },
    commit(summary, firstKeptEntryId, tokensBefore, details, signal) {
      ready();
      signal?.throwIfAborted();
      if (verifyingProjection)
        throw new Error(
          "Fresh Context Window still does not fit; refusing a second rebuild before one request",
        );
      if (!summary.trim() || !Number.isFinite(tokensBefore) || tokensBefore < 0) {
        throw new Error(
          "Context Checkpoint requires a nonempty Handoff and finite nonnegative token count",
        );
      }
      durable();
      const before = manager.getLeafId();
      let committed = false;
      try {
        const cutoff = adapter.cutoff(firstKeptEntryId);
        let id: string;
        try {
          id = manager.appendCompaction(summary, cutoff, tokensBefore, details, true);
        } catch (cause) {
          quarantineContextJournal(manager);
          throw cause;
        }
        committed = true;
        const entry = manager.getEntry(id);
        if (entry?.type !== "compaction")
          throw new Error("Pi did not return a native Context Checkpoint");
        agent.state.messages = manager.buildSessionContext().messages;
        refresh = true;
        // SAFETY: This entry was just created by appendCompaction with this exact generic details value.
        return entry as CompactionEntry<typeof details>;
      } catch (cause) {
        if (!committed) restoreLeaf(before);
        adapter.fault(cause instanceof Error ? cause : new Error(String(cause)));
        throw cause;
      }
    },
    fault(error) {
      failure ??= new Error(
        `Context Management stopped; reload required: reopen the persisted session because resource /reload is insufficient: ${error.message}`,
        {
          cause: error,
        },
      );
      agent.abort();
    },
    dispose() {
      if (!active) return;
      active = false;
      if (runner.hasHandlers === hasHandlersWrapper) {
        if (hasHandlersDescriptor)
          Object.defineProperty(runner, "hasHandlers", hasHandlersDescriptor);
        else Reflect.deleteProperty(runner, "hasHandlers");
      }
      if (runner.emit === emitWrapper) {
        if (emitDescriptor) Object.defineProperty(runner, "emit", emitDescriptor);
        else Reflect.deleteProperty(runner, "emit");
      }
      if (manager.appendCompaction === appendWrapper) {
        if (appendDescriptor) Object.defineProperty(manager, "appendCompaction", appendDescriptor);
        else Reflect.deleteProperty(manager, "appendCompaction");
      }
      if (agent.prepareNextTurnWithContext === wrapper) agent.prepareNextTurnWithContext = previous;
      if (agent.transformContext === transformWrapper) agent.transformContext = previousTransform;
      if (Object.getOwnPropertyDescriptor(agent, AdapterSlot)?.value === adapter)
        Reflect.deleteProperty(agent, AdapterSlot);
      // A later extension may wrap us. Leave that chain intact; our inactive wrapper only delegates.
    },
  };
  Object.defineProperty(agent, AdapterSlot, { value: adapter, configurable: true });
  runner.hasHandlers = hasHandlersWrapper;
  runner.emit = emitWrapper;
  manager.appendCompaction = appendWrapper;
  agent.prepareNextTurnWithContext = wrapper;
  agent.transformContext = transformWrapper;
  return adapter;
}
