# Bridge Pi's registered tools

CodeMode invokes Pi's effective wrapped tool registry through a capability-gated
private AgentSession seam instead of recreating built-in or extension tools. The
private seam is version-sensitive, but it preserves the registered handlers,
extension contexts, hooks, and overrides that a parallel implementation would
silently bypass.

CodeMode also wraps the captured session's `setActiveToolsByName` on that
instance. The wrapper retains Pi's pre-policy requested names separately from
policy-applied direct names and fresh registry names, so registry refreshes and
external selections remain distinguishable. Shutdown applies retained requested
names through the original callable, then restores the exact prior own
descriptor—or deletes the wrapper when the method was originally inherited.

Exposure decisions take effect synchronously for execution, but dynamic registry
changes do not render a new TypeScript catalogue immediately. The next
`before_agent_start` hook, direct catalogue search, or CodeMode Session snapshot
renders the latest coherent catalogue once. This avoids quadratic startup work
when extensions register large tool sets one tool at a time.

Deliver the synchronized Tool Catalogue through direct `codemode_search` results
and each Cell's frozen discovery snapshot, rather than rewriting the immediate
`codemode_execute` definition. Constant execution and discovery guidance trades a
possible discovery call before unfamiliar tool use for a stable reusable provider
prefix. Real changes to other directly exposed tool definitions remain visible;
native deferred loading may preserve the immediate prefix for additions.
