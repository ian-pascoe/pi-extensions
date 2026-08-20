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
