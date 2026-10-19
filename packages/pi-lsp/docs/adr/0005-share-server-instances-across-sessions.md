# Share Server Instances across the sessions of one Pi process

Every Pi session in one Pi process that loads pi-lsp (main sessions, Minimal Subagents children, Advisor sessions) now shares Server Instances through a pi-lsp-private, reference-counted pool. Before, each session's `session_start` built its own `LspServerManager`, which started its own processes and stopped them at `session_shutdown`. A child runs in its parent's process with the parent's working directory and project-trust snapshot, so every child that touched code cold-started its own copy of every language server for the same roots (#465). In this repository one `tsc --lsp` instance costs about 8–10 CPU-seconds to load the workspace and 650–900 MB of memory, and oxlint's server about 200 MB; a parent with three active children ran four of each.

## The pool

The pool lives on `globalThis` under the versioned slot `Symbol.for("@ian-pascoe/pi-lsp/server-instance-pool.v1")`, following the registry pattern of the repository's ADR-0008 and ADR-0009, because Pi evaluates extension modules again on `/reload` and for every in-process session, so module-level state would be duplicated. The slot holds only a `Map` of entries; the code that reads them is each pi-lsp copy's own. Only pi-lsp reads or writes the slot. No other package imports or depends on pi-lsp or its pool, and every package stays separately installable: sessions share Server Instances only because each of them loads pi-lsp. Sharing covers every session in the process, has no opt-out setting, and never crosses Pi processes.

An entry's key is the identity of the process and its protocol behavior:

- pi-lsp's package version, so copies of different released versions never share client code or entry shapes;
- the server ID and the workspace root;
- the resolved `command`, `args`, and `environment`;
- `initializationOptions` and `settings`;
- the resolved `lsp.timeouts`;
- `maxConcurrentDiagnostics`, so #464's limit is enforced once per shared process.

Routing-only fields (`languages`, `rootMarkers`, `workspaceRootMarkers`, `requireRootMarker`), enablement, and `includeHintDiagnostics` are left out: they decide which files reach an instance or how results are filtered per session, not what the process is. Sessions whose keys differ, for example because only one trusts a project override, get separate instances without any warning. The environment and timeouts are serialized sorted by name; `initializationOptions` and `settings` keep the key order settings resolution produced, so a difference in their key order alone could only cause an extra instance, never wrong sharing.

The version separates released versions, not two copies of the same version with different code, such as a linked development checkout loaded beside an installed release. Such copies share instances, and whichever started an instance supplies its client code. This is accepted: it affects only development setups, where a stale instance ends with a Stop, a restart, or the last session using it.

## Server Instance Leases

A session takes a Server Instance Lease the first time it routes a request to an instance, never at `session_start`, so a child that never touches code takes none. It releases the lease when it shuts down or disables the Server Definition, and every lease on an instance ends when the instance is stopped. The process stops as soon as its last lease is released. Sessions that route to an instance that is still starting all await its one startup; startup is aborted only when no lease remains, so it continues when the session that triggered it shuts down while another still holds a lease.

Failure state belongs to the shared instance: a crash makes it unavailable to every leaseholder, and `/lsp stop` or `lsp_restart` from any session stops the process for all of them and clears the failure. Each leaseholder starts it again lazily on its next use, so Stop keeps its glossary meaning. Enablement stays a per-session routing filter. Project and global enablement writes are still not pushed to other running sessions.

Per session stay the Server Enablement Overrides, the Workspace Edit Preview store, Result Spills and other session files, Pre-edit Baselines and Post-edit Diagnostics, and the routes the session has used; the other-roots warnings of references and rename come only from the asking session's routes. Per shared instance are the synchronized documents, their version counter and 100-document limit, the pull `resultId` cache and push-diagnostics state, the push-only silence memory, capabilities and dynamic registrations, failure state, and the diagnostics limit. One session's activity can evict another's documents, which only costs a re-open. Status reports, for each running instance, how many other sessions lease it; an instance a session holds no lease on reads `stopped` in that session.

## Callbacks that were bound to one session

The client's stderr file lived in the starting session's temp directory, which is deleted at its shutdown. The pool now owns it, in a private directory of its own under the OS temporary directory, and deletes it when the instance stops; failure messages cite that path. The unavailable callback and the startup abort signal belong to the pool entry. The function that starts a process captures no session state, because a startup can outlive the session that triggered it.

A server-initiated `workspace/applyEdit` always arrives unsolicited, because pi-lsp never sends `workspace/executeCommand`. On a shared instance it becomes a held Workspace Edit Preview in the only leaseholder's session when there is exactly one. With two or more leaseholders the client replies `applied: false`, with a `failureReason` saying the shared Server Instance cannot attribute the edit to a session, and creates no preview anywhere: guessing would put an edit in the wrong session's store, where its agent would see a change it never asked for. The client passes its negotiated position encoding with the edit, so the preview no longer depends on the session's handle to the client.

## Considered Options

- **A module-level pool**: rejected because Pi evaluates the module again on `/reload` and for every in-process session, so each evaluation would have its own pool and nothing would be shared.
- **A home in pi-utils**: rejected because the pool holds pi-lsp clients and is pi-lsp policy. Putting it in a shared package would couple that package to pi-lsp's internals, while the `globalThis` slot already shares it between pi-lsp copies without any other package knowing it exists.
- **A grace period or idle timeout before stopping an unleased instance**: rejected to keep the lifecycle simple and resource use predictable; a later session pays one cold start.
- **Stop releasing only the caller's lease**: rejected because Stop is how a user recovers a failed instance. If it only released the caller's lease, a crashed instance would stay unavailable in every other session, and the process would keep running wherever it still had a lease.

## Consequences

A parent and its children that resolve the same configuration run one process per Server Definition and root instead of one per session. A Stop, a restart, or a crash in one session is felt in all of them, and in a busy parent with active children, documents opened by one session can be closed to make room for another's. Server-initiated edits are lost while two or more sessions share an instance; servers that rely on them, through commands pi-lsp never sends, were already outside its scope.
