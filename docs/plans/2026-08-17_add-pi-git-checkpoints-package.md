# Add the `@ian-pascoe/pi-git-checkpoints` package

**Status:** Implemented

## Outcome

Add a source-TypeScript Pi extension package that records Git-backed Worktree Checkpoints at Model Step boundaries and offers an explicit Restore when `/tree` moves backward, forward, or sideways. The package works whether or not Pi's starting directory belongs to a Git repository, restores only Navigation Transition paths, keeps workspace Git metadata untouched, and supports one-level undo through `/checkpoint undo`.

Read before implementation:

- [`../../AGENTS.md`](../../AGENTS.md)
- [`../../CONTEXT-MAP.md`](../../CONTEXT-MAP.md)
- [`../../packages/pi-git-checkpoints/CONTEXT.md`](../../packages/pi-git-checkpoints/CONTEXT.md)
- all package ADRs in [`../../packages/pi-git-checkpoints/docs/adr/`](../../packages/pi-git-checkpoints/docs/adr/)
- [`../agents/domain.md`](../agents/domain.md)
- [`../adr/0001-package-naming-strategy.md`](../adr/0001-package-naming-strategy.md)
- [`../adr/0002-publish-pi-extensions-as-source-typescript.md`](../adr/0002-publish-pi-extensions-as-source-typescript.md)
- [`../../.oxlintrc.json`](../../.oxlintrc.json)

The package context and ADRs are approved inputs. Use their canonical terms in identifiers, tests, README text, and errors. This plan adds standalone-workspace mode; update ADR-0003's unconditional source-repository seeding decision before source implementation.

## Boundaries

- Handle `/tree` only. Add no `/fork` or `/resume` restore handoff and no Pi core changes.
- Register one `/checkpoint` command with `status` and `undo` actions. Bare `/checkpoint` reports status plus usage.
- Capture before and after each Model Step. Parallel tool results share the final checkpoint for their complete tool batch.
- Scope captures to Pi's starting directory. In repository mode, retain the canonical source-worktree identity; in standalone mode, use the canonical starting-directory identity.
- Restore eligible path contents and filesystem modes only. When a source repository exists, its index, `HEAD`, commits, refs, stash, and current branch remain unchanged.
- In repository mode, include tracked files and nonignored untracked files up to 2 MiB; include tracked files regardless of size. In standalone mode, treat every path as untracked until its first successful capture, so the same 2-MiB limit applies initially; thereafter the private index tracks captured paths normally. Leave ignored files, larger untracked files, submodules, nested repositories, sockets, devices, and unsupported entries untouched.
- Support regular files, deletions, symlinks, and executable modes. Reject lexical path escapes and destination paths whose existing ancestors escape through symlinks.
- Use a per-session isolated Git store beneath Pi's agent directory. Add no runtime dependency and never use the user's stash.
- Require the Git executable, not a pre-existing repository. Never create `.git` or other checkpoint metadata in the starting directory.
- Read only `gitCheckpoints.retentionDays` from Pi's trust-aware settings layers. Add no watcher or other setting.
- Keep expiration cleanup best-effort and asynchronous. Model Step capture and Restore remain awaited and abortable.
- In TUI/RPC, ask before Restore. In print/JSON, keep files unchanged during navigation. Never infer approval.
- Treat user `!` and `!!` changes as external changes that enter the next Model Step baseline; Pi has no composable post-user-bash hook.
- Publish source TypeScript only. Add no build, `dist`, `main`, `types`, or `exports` contract.
- Prepare public version `0.1.0`, add no bootstrap Changeset, and run no publish command.

## Runtime contract

### Checkpoint modes

Select one mode during `session_start`:

- **Repository mode:** discover the canonical source worktree and Git directories, scope capture to Pi's starting directory, seed the isolated store from the source index/object database, and record source `HEAD` for mismatch warnings.
- **Standalone mode:** when no enclosing repository exists, use the canonical starting directory as the checkpoint root, initialize the isolated store empty, and omit source `HEAD`/branch behavior. Respect `.gitignore` files in the starting-directory tree and Git's global excludes; no source `.git/info/exclude` exists.

A missing or unusable Git executable is an initialization failure. A non-repository starting directory is not a failure and remains fully checkpointable. Both modes use the same capture, Navigation Transition, Restore, undo, retention, and safety rules.

### Settings

Read global `~/.pi/agent/settings.json` and trusted project `.pi/settings.json` through `SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() })`:

```json
{
  "gitCheckpoints": {
    "retentionDays": 7
  }
}
```

`retentionDays` is a positive safe integer and defaults to `7`. A valid project value replaces the global value. An invalid value emits one path-qualified startup warning and falls back to the valid global value or the default. Unknown fields under `gitCheckpoints` warn and are ignored. Settings reload only through `session_start`, including `/reload`.

Follow the owned-key parsing pattern in `packages/pi-formatter/src/pi-formatter-settings.ts`: read global and project documents separately, validate unknown wire values, and keep untrusted project settings out of resolution.

### Persisted checkpoint entries

Use two model-invisible custom entry types with strict versioned TypeBox payloads. Keep checkpoint-root-relative paths normalized with `/` separators.

- A Model Step start entry records version, current session ID, checkpoint-scope identity, mode, step ID, tree ID, and source `HEAD`/unborn/standalone state. Append it during `turn_start`; immediately read the resulting leaf ID from `ctx.sessionManager`.
- A Model Step end entry records version, session ID, checkpoint-scope identity, mode, step ID, start-entry ID, result leaf ID, final tree ID, source `HEAD`/unborn/standalone state, changed paths, skipped paths, and every tool-call ID in the batch. Append it during `turn_end`, after Pi has persisted the assistant/tool-result messages.

Persist an end entry even when start and end tree IDs match so tree positions remain reconstructable. Replay validated entries from `ctx.sessionManager.getEntries()` because targets may live on sibling branches. Ignore malformed, unsupported-version, foreign-session, foreign-checkpoint-scope, mode-mismatched, and inherited fork/clone entries rather than guessing.

Tool-result targets map through their tool-call ID to the Model Step end entry. A selected user/custom message maps to the checkpoint immediately before that message. An assistant or other entry maps to the nearest preceding checkpoint on its target branch.

### Isolated Git store

Store data beneath:

```text
<agent-dir>/git-checkpoints/<workspace-id>/<session-id>/
```

Derive `workspace-id` from a stable SHA-256 of the canonical source-worktree path in repository mode or canonical starting-directory path in standalone mode. Verify the session ID, mode, canonical workspace root, optional source Git directory, and starting-directory scope before reusing a store.

Initialize one separate Git directory and mutable index per session without writing `.git` into the workspace. In repository mode, seed it by:

1. configuring Git for long paths, symlinks, disabled fsmonitor/autocrlf, and a modern index;
2. linking the source object database and its valid alternates;
3. copying the source worktree's current index only as the initial baseline.

In standalone mode, apply the same private-store configuration but begin with an empty index/object database and no alternates. On first capture, stage only nonignored eligible paths no larger than 2 MiB. Paths successfully captured then behave as private-index tracked paths, including capture after later growth; paths skipped on the first capture remain untracked and subject to the limit.

Implement the required Git CLI subset with Node's child-process APIs and NUL-delimited stdin for path lists. Reuse the algorithms, not the Effect architecture, from:

- [OpenCode V2 Snapshot](../../.repos/opencode/packages/core/src/snapshot.ts)
- [OpenCode Git repository/index/tree operations](../../.repos/opencode/packages/core/src/git.ts)

Each capture refreshes only the starting-directory scope, applies the active mode's ignore rules, removes newly ignored/skipped entries from the isolated index, stages eligible candidates, and writes a content-addressed tree. Return the tree ID, optional source `HEAD` state, mode, and skipped paths. Serialize operations within one store.

Selective Restore uses a temporary index/materialization path so any source index stays untouched. For each approved path, restore its target tree entry or remove it when absent. Skip gitlinks and unsupported modes. Check every path against the checkpoint root and starting-directory scope before a read, write, or removal.

Do not impose a fixed Git timeout. Propagate Pi's AbortSignal. A capture failure notifies once, records the reason for `/checkpoint status`, and disables checkpointing until `/reload` or the next session.

### Navigation planning and Restore

During `session_before_tree`:

1. Clear stale pending intent.
2. Resolve Pi's selected entry to the resulting target position; user/custom selections use their parent.
3. Compute the current/target common ancestor from session entries rather than assuming `preparation.targetId` equals the resulting leaf.
4. Build the Navigation Transition path set: paths changed on the departed segment, entered segment, or both for sideways movement.
5. Resolve one Target Checkpoint and filter the path set to live-versus-target differences.
6. If no restorable difference exists, continue silently. If metadata exists but its store/tree expired, warn once and continue without file changes.
7. In TUI/RPC, show the total and first 20 `A`/`M`/`D` paths, skipped count, and any repository-mode `HEAD` mismatch. Offer **Restore code and navigate**, **Keep code and navigate**, and **Cancel navigation**.
8. For Restore approval, retain the old leaf, selected target, approved paths, target tree, and an approval-time live tree in memory. Return `{ cancel: true }` only for explicit cancellation.

During `session_tree`, act only on intent from the immediately preceding matching old leaf. Pi may attach a branch summary or label, so do not require `newLeafId` to equal the selected entry. Recapture the approved paths before writing; if they changed after approval, skip Restore and warn. Otherwise keep that live tree as the Safety Checkpoint, perform the selective Restore, and persist one atomic undo record containing safety tree, restored tree, affected paths, and session/checkpoint-scope identity.

Another extension may cancel after this package's `session_before_tree` handler. File writes therefore occur only in `session_tree`, as required by ADR-0001. Internal hook errors must be caught inside the package because Pi logs handler errors and continues navigation.

On Restore failure, attempt to restore every affected path from the Safety Checkpoint. Report the original failure and exact unrecovered paths; conversation navigation remains complete. A successful later Restore replaces the prior undo record.

### `/checkpoint` command

- `status`: report active repository/active standalone/disabled state, valid Model Step count, store path, retention days, last capture failure, and undo availability.
- `undo`: compare affected paths with the persisted restored tree. Undo immediately when unchanged; when diverged, show paths and require confirmation in TUI/RPC. Refuse divergent undo without UI. On success restore the Safety Checkpoint and remove the undo record.
- no argument: render `status` followed by concise action usage.
- unknown action: return concise usage without side effects.

Command operations are idle user actions. They never move the conversation leaf.

### Retention cleanup

Touch store activity on session start and after successful capture, Restore, or undo. Start cleanup from `session_start` without awaiting it. Skip the current store and stores marked active by a live process; remove stale process markers. Delete stores whose last activity exceeds `retentionDays`. Cleanup failures produce one package-prefixed log line and never notify, block startup, or disable checkpointing. Remove the current process marker during `session_shutdown`.

## Intended module map

| File                                  | Sole owner                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| `src/index.ts`                        | Thin default export                                                                          |
| `src/pi-git-checkpoints-settings.ts`  | Settings wire schema, validation, defaults, and trusted global/project resolution            |
| `src/git-checkpoint-store.ts`         | Git discovery, isolated store, capture/compare/restore, undo metadata, and retention cleanup |
| `src/git-checkpoint-history.ts`       | Persisted entry schemas, replay, target mapping, and Navigation Transition planning          |
| `src/pi-git-checkpoints-extension.ts` | Pi lifecycle, prompts, pending Restore intent, command handling, and status                  |

Keep domain types beside their owner. Add another production file only when one of these owners becomes internally incohesive; add no generic `types.ts`, `utils.ts`, `helpers.ts`, factory, or service interface with one implementation.

## Implementation sequence

### 1. Establish the baseline and package shell

Record:

```bash
git status --short
git rev-parse HEAD
pnpm verify
pnpm changeset:status
```

The expected starting changes are `CONTEXT-MAP.md`, `packages/pi-git-checkpoints/CONTEXT.md`, five package ADRs, and this plan. Stop for review if unrelated source/configuration changes are present. Amend ADR-0003 so repository mode seeds from source Git objects/index while standalone mode starts with an empty isolated store keyed by canonical starting directory; retain its per-session isolation and retention decision.

Create `packages/pi-git-checkpoints/package.json` as public `@ian-pascoe/pi-git-checkpoints@0.1.0`, matching the repository's source-package metadata, scripts, Node engine, wildcard Pi/TypeBox peers, and `pi.extensions: ["./src/index.ts"]`. Add `tsconfig.json`, MIT `LICENSE`, initial README, and the thin entrypoint/lifecycle shell. Add no runtime dependency.

Add a package entrypoint load test before root integration. Let `pnpm install --lockfile-only` add the workspace importer.

**Complete when:** the package typechecks, its source entrypoint loads through Pi without running Git at extension-load time, and its manifest has no build/distribution contract beyond source TypeScript.

### 2. Parse settings and build the isolated Git tracer

Implement and test settings first using real temporary global/project settings files and a trust-aware `SettingsManager`. Cover missing settings, default/global/project precedence, untrusted project exclusion, invalid values, and unknown fields.

Then implement `git-checkpoint-store.ts` against temporary real Git repositories and ordinary non-repository directories. Read the OpenCode references named above immediately before coding this module. Use the standard library and direct Git commands; copy no unrelated OpenCode diff/UI/session machinery.

Prove at minimum:

- stable no-change tree IDs;
- modified, added, deleted, ignored, untracked, and greater-than-2-MiB untracked behavior;
- tracked large files, Unicode/spaces/leading-dash/wildcard/colon names, binary files, symlinks, and executable modes;
- starting-directory scoping and lexical/symlink-ancestor escape rejection;
- source `.gitignore`, `.git/info/exclude`, and global ignore handling;
- linked-worktree discovery and per-session store isolation;
- source `HEAD`, branch, index bytes, refs, and stash remain unchanged after capture and Restore;
- standalone initialization creates no `.git` or checkpoint metadata in the starting directory;
- standalone `.gitignore` and global-ignore handling, stable no-change captures, modifications, additions, deletions, and selective Restore;
- standalone first-capture 2-MiB filtering, continued exclusion of skipped paths, and normal private-index tracking of successfully captured paths;
- standalone canonical-directory identity, store isolation, nested-repository skipping, and absence of `HEAD` mismatch behavior;
- selective Restore preserves unrelated files and removes target-absent files;
- submodules, nested repositories, and unsupported modes are reported as skipped;
- cancellation and Git failure leave a precise disabled/failure state;
- Safety Checkpoint rollback restores every already-written path or reports exact recovery failures;
- inactive-store cleanup skips current/live stores and removes expired/stale stores without blocking its caller.

Use real files and narrow injected process/filesystem effects for deterministic failure and liveness cases; use no Node module mocks.

**Complete when:** the Git store alone can capture, compare, selectively restore, roll back, undo, and expire temporary repository and standalone workspaces while every source Git metadata invariant remains byte-for-byte unchanged and standalone workspaces contain no package-created Git metadata.

### 3. Model persisted history and Navigation Transitions

Implement the versioned start/end entry schemas and pure history planner. Build synthetic Pi session trees with real `SessionManager` entries and cover:

- malformed, unsupported-version, foreign-session/checkpoint-scope, mode-mismatched, and inherited fork records;
- start/end pairing, identical trees, missing ends, tool-call association, and parallel tool batches;
- user/custom target-to-parent semantics;
- assistant nearest-preceding semantics and tool-result final-step semantics;
- backward, forward, and sideways common ancestors and exact changed-path unions;
- branch summaries, labels, hidden custom entries, root targets, and sibling branches;
- expired/missing Target Checkpoints and skipped paths;
- deterministic `A`/`M`/`D` preview ordering and first-20 truncation.

Keep tree traversal and mapping independent of Git process execution. Use repository-wide searchable domain names in test descriptions.

**Complete when:** every Pi target kind and navigation direction resolves to one deterministic Target Checkpoint/path plan or one explicit unavailable reason, with no filesystem access.

### 4. Capture Model Steps through Pi lifecycle events

Wire `session_start`, `turn_start`, `turn_end`, and `session_shutdown` in `pi-git-checkpoints-extension.ts`.

- On session start, load settings, select repository or standalone mode, initialize the store, replay entries, install the active marker, and launch cleanup without awaiting it. Standalone initialization remains silent; only an actual initialization failure warns and disables the session.
- On turn start, await capture, append the start entry, and retain its generated leaf ID/step ID.
- On turn end, await capture, diff start/end paths, collect `event.toolResults` call IDs plus the current result leaf, and append the end entry even for an unchanged tree.
- On capture failure, warn once and disable the session. `/reload` reconstructs from persisted valid entries and retries initialization.

Test through a real `ExtensionRunner`/`SessionManager` lifecycle seam. Add one focused agent-loop check proving parallel tools produce one end checkpoint associated with every result in the batch. Characterize the accepted user-bash limitation without wrapping `user_bash` operations.

**Complete when:** persisted entries reconstruct every successful Model Step across reload and branches, parallel result mapping is stable, capture cannot race a step, and failure disables only the active session.

### 5. Add tree confirmation, Restore, and `/checkpoint`

Register `session_before_tree` and `session_tree` plus the single command. Use Pi's actual async UI contexts and an `AgentSession.navigateTree(..., { summarize: false })` integration where possible; use direct runner events only for branches the public navigation seam cannot synthesize.

Cover:

- no difference/no checkpoint/no UI paths keep files and navigate without approval;
- backward, forward, and sideways previews and all three dialog choices;
- user-message parent targeting and parallel tool-result targeting;
- a later `session_before_tree` handler cancels after approval and no file changes occur;
- successful navigation restores only after `session_tree` and before `navigateTree()` resolves;
- summarization/label-produced leaves still consume only their matching pending intent;
- stale approval skips Restore after an external path change;
- repository-mode `HEAD` mismatch warns but never switches branch; standalone mode has no `HEAD` mismatch;
- Restore failure rolls back from the Safety Checkpoint while leaving navigation complete;
- `/checkpoint status`, bare usage, unknown action, undo, divergent undo confirmation, and noninteractive divergent refusal;
- one successful Restore replaces the previous undo record and successful undo clears it.

Keep prompt text deterministic and package-prefixed errors searchable. Return `{ cancel: true }` only for the user's explicit Cancel choice.

**Complete when:** every file write is downstream of explicit approval and successful tree navigation, every failed/stale path leaves recoverable file state, and command behavior is fully exercised without credentials or network access.

### 6. Finish package and repository integration

Complete `packages/pi-git-checkpoints/README.md` as the user-facing source for installation, Git-executable prerequisite, repository and standalone modes, Model Step behavior, all three navigation choices, settings precedence/trust, `/checkpoint status|undo`, file eligibility, standalone first-capture semantics, 2-MiB limit, retention, storage path, repository-only `HEAD` warning, noninteractive behavior, user-bash/parallel-tool semantics, Restore/rollback limits, and the Git metadata boundary.

Wire the ninth package through every repository authority:

- root `package.json` ordered `pi.extensions`;
- tracked `.pi/settings.json` workspace/Git signed override lists;
- root README package table, selectable paths, prerequisite, and focused test command;
- `test/extension-entrypoints.test.ts` path and count;
- `test/project-extension-overrides.test.ts` expected count;
- `scripts/check-package-packs.mjs` workspace count and message;
- `scripts/check-git-install.mjs` extension count and messages;
- `docs/releases.md`: seven scoped bootstrap packages and nine trusted-publishing packages;
- `pnpm-lock.yaml`.

Retain the approved context/ADR wording except for corrections discovered through red tests. Add no bootstrap Changeset.

Run:

```bash
pnpm format
pnpm --filter @ian-pascoe/pi-git-checkpoints typecheck
pnpm --filter @ian-pascoe/pi-git-checkpoints test
pnpm test:load
pnpm pack:check
pnpm git-install:check
pnpm changeset:status
```

**Complete when:** workspace, packed npm tarball, and clean Git installation all load the ninth source entrypoint; every package count/list agrees; the README covers every caller-visible limitation; and Changeset status contains no bootstrap entry for this package.

### 7. Run the proof gate

Run in order:

```bash
pnpm format
pnpm verify
pnpm changeset:status
git diff --check
git status --short
```

Inspect the final diff and prove:

- only `/tree` owns navigation Restore behavior;
- every Model Step has paired validated entries or an explicit disabled failure;
- Restore planning supports backward, forward, and sideways transitions without checkout of the entire checkpoint root;
- repository mode leaves every source Git metadata invariant unchanged, and standalone mode creates no workspace Git metadata;
- no fixed Git timeout, file watcher, cleanup timer, bash wrapper, full textual-diff UI, `/fork` handoff, `/resume` handoff, or extra slash command entered the package;
- no new runtime dependency or generic abstraction entered the package;
- every child process, temporary index/materialization, active marker, and asynchronous cleanup task has a bounded cleanup path;
- package files, root metadata, tracked project overrides, release counts, documentation, lockfile, and tests all agree on nine packages;
- no publish command ran.

**Complete when:** `pnpm verify` is green, the real-Git store and actual Pi tree-navigation integration checks are green, every checklist item is evidenced in the diff/tests, and the only working-tree changes are the approved package/docs/plan plus required root integration.

## Pause

Do not begin implementation until this plan is approved in a later turn.
