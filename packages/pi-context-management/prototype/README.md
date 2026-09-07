# Native checkpoint adapter prototype

**Throwaway SDK experiment. Do not install this as an extension.**

Question: can immediate Rollover create a native Pi checkpoint that the live parent, native inheritance builder, fork, and resume all understand, without a summarization call or a consumer-specific integration?

## Verdict — core mechanism proven; stop prototype expansion here

Run on **2026-09-06**, Node **26.8.1**, explicitly importing the live harness's **Pi 0.85.1** installation. The checkout's `node_modules` resolves **0.85.0**, so using it would not establish 0.85.1 compatibility. Dependencies and the lockfile were not changed.

- **13 characterization checks pass.** They include a check that reproduces and asserts the known persistence defect; passing that check does **not** make the adapter production-ready.
- **Strict gate mode fails** on live-versus-persisted journal agreement after a failed write.
- No full extension/package has been built. The user directed us to stop prototype expansion once the core mechanism was demonstrated; the remaining diagnostics are documented limitations, not a mandate to build a transaction-recovery subsystem here.

## Run

Use the package directory of the Pi installation being tested, not a session directory. This is the exact target used here:

```sh
export PI_CONTEXT_PROTOTYPE_SDK=/home/ianpascoe/.local/share/pnpm/store/v11/links/@earendil-works/pi-coding-agent/0.85.1/3a232f447de493cd441b087d3be95eec7b2799f5739524201dc652d103374db3/node_modules/@earendil-works/pi-coding-agent
node --test packages/pi-context-management/prototype/checkpoint.test.mjs
```

Run the deliberately failing production gate:

```sh
PI_CONTEXT_PROTOTYPE_GATE=1 node --test packages/pi-context-management/prototype/checkpoint.test.mjs
```

Expected results for this candidate: normal mode **13 pass, exit 0**; strict mode **12 pass / 1 fail, exit 1**. The gate asserts that the journal in memory matches the journal reopened from disk.

Without the SDK override, the runner uses the checkout dependency and rejects anything other than 0.85.1 before running scenarios. On another machine, point the override at its existing 0.85.1 installation; the prototype does not install anything.

Scratch sessions live in temporary `pi-context-PROTOTYPE-*` directories and are removed after each scenario. The model stream is scripted, credentials are in-memory dummy values, model discovery is offline, and `fetch` is blocked. The failure scenario changes permissions only on its own scratch journal and restores them in `finally`; run as an ordinary user, not root. The adapter never edits journal bytes directly.

## What the executable checks prove

1. An early, mid-loop tool request commits a real native checkpoint, drops old context from the immediate follow-up, preserves standing instructions/tools, and leaves original History on disk.
2. A zero-message Tail works using a valid neutral custom-entry cutoff, without orphan tool results or invented IDs.
3. Native manual compaction uses the supplied checkpoint without another model request or routine cancellation.
4. Multiple checkpoints agree across live parent state, native `buildSessionContext`, journal reopening, `forkFrom`, and in-tree navigation. The inheritance check calls the same native builder used by Minimal Subagents; it is **not** an end-to-end Child Agent spawn test.
5. A real `EACCES` append failure leaves the previous checkpoint active and previously acknowledged Note data on disk, and blocks subsequent model requests. It also exposes the persistence defect below.
6. Native threshold compaction succeeds through the custom-result hook.
7. Native overflow retries successfully and its failed response remains in History without returning to the resumed active context.
8. A second overflow stops instead of opening another recovery loop.
9. Cancellation before commit creates no checkpoint or follow-up model request.
10. A non-isolated Rollover batch is rejected before checkpoint mutation, retaining complete call/result groups.
    11–12. Ephemeral context additions and in-place prompt replay survive either companion-hook order. These are small fixtures reproducing Todo/MCP hook contracts, **not** the full installed extensions or live MCP servers.
11. The version gate rejects an untested release before extension registration.

## Mechanism

`checkpoint-adapter.mjs` captures the owning `AgentSession` using the same temporary synchronous receiver-capture technique already used by CodeMode. It deliberately does not import CodeMode's helper: that module imports the checkout's different Pi version.

The Rollover tool only records a pending request. The awaited `turn_end` handler commits **after** the assistant and all tool results have reached SessionManager. It calls the native `appendCompaction`, then assigns the rebuilt native messages to the parent's agent state.

The active agent loop also holds a context snapshot. A narrow wrapper around `prepareNextTurnWithContext` refreshes that snapshot **before** Pi preflight and public context transforms. This avoids a second virtual checkpoint format and does not rebuild away live Todo/MCP context contributions.

The normal `session_before_compact` success path handles native manual, threshold, and overflow compaction. Tail selection retains a contiguous suffix of complete groups; a failed/aborted assistant at the cutoff is not retained. Empty Tail uses a real, invisible custom entry immediately before the checkpoint. That neutral entry is not itself an authoritative checkpoint.

No monkey patch remains on `AgentSession.prototype.getAllTools` after capture. The next-turn wrapper lives only on the scratch Agent; reload/disposal integration for a production extension is not implemented.

## Blocking finding: append is not transactional

Pi's `SessionManager._appendEntry` changes its entry array, ID map, and leaf **before** `_persist` writes the journal. The prototype makes an existing scratch journal read-only immediately before Rollover:

1. `appendCompaction` inserts a checkpoint into memory.
2. The append fails with `EACCES`; no checkpoint reaches disk.
3. Returning the leaf to its old entry preserves the old active Context Window, but an unpersisted checkpoint remains as an abandoned in-memory sibling.
4. Pi may attempt to persist an abort/error response to the still-unwritable file, producing further unpersisted state and a rejected prompt.
5. Reopening the journal yields the durable old branch and its acknowledged Note, but not the ghost entries.

The candidate blocks further requests until reload; it does **not** claim transactional rollback. Strict gate mode compares the two journals and fails visibly. Partial writes, storage exhaustion, process crashes, and atomic recovery are not proven by an `EACCES` test.

**Production consideration:** the observed behavior is fail-closed plus reload, not transactional memory rollback. Preserve that explicit limitation when using this mechanism; stronger recovery would be a separate decision, not more prototype churn. Do not claim the strict diagnostic passed or broaden private mutation to arbitrary session-file edits.

## Not implemented or proved yet

- The full Notes/History tools, Note Index, inspection commands, or rollover notices.
- Whole-prompt/output-reserve accounting, configurable 80%/90% warning/emergency policy, or rejection of an oversized Handoff. Only Tail selection is budgeted in this candidate; there is no claim that an arbitrary Handoff fits.
- Actual large external tool outputs, real model/provider serializers, images, real Child Agent delivery, CodeMode bindings, or end-to-end Todo/MCP integration.
- Parent-to-child provenance/access of inherited Note and History references; native checkpoint inheritance alone does not copy the source Note store.
- Competing compaction owners, hot reload, runtime capability loss, cancellation after commit, or crash/partial-write recovery.
- Readiness on Pi 0.85.0, future Pi versions, or other Node versions/platforms.

## Runtime evidence

Tests import installed compiled SDK files, not the read-only reference repository. The bundled session-format documentation mentions a newer `retainedTail` representation, but this tested runtime still implements the `firstKeptEntryId` append interface; the prototype follows observed runtime behavior.

SHA-256 of tested Pi 0.85.1 files:

```text
fb8a3981c20c8c0bbd42231b1c99a10335fb3858b659056b341954de9cfa467f  dist/core/agent-session.js
ccace64949db25379a43971ecea750c1b7ec6344e1bc31b9d5fe596ac2f1c9f3  dist/core/session-manager.js
```

Targeted `oxlint`, `oxfmt --check`, and `node --check` pass. No real model request, dependency installation, reference-repository edit, or full-package implementation was needed.
