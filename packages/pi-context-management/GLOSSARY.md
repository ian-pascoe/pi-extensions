# Context Management context

The Context Management context lets an agent continue a Pi session across Context Windows using its own Notes and retrievable History.

## Language

**Notes**:
Agent-maintained working knowledge organized into independently named documents, written only by the one Pi session branch that owns them; other sessions may read them but never write them.
_Avoid_: Project memory, global memory, shared notebook

**Lineage Notes**:
Notes owned by another agent in the reader's Agent Lineage, readable live but never writable by the reader.
_Avoid_: Shared Notes, parent memory

**Agent Lineage**:
The ancestors and descendants of an agent within one agent tree, excluding its siblings and other trees.
_Avoid_: Agent family, session tree

**Search Scope**:
The set of sessions a Notes or History search covers: Branch (the default) or Lineage.
_Avoid_: Search mode, visibility

**Note Index**:
The compact catalogue of the agent's own Note names carried into a Context Window so the agent can choose which Notes to read.
_Avoid_: Full notebook, summary

**History**:
The original recorded conversation on the active session branch, including material from earlier Context Windows and inherited fork history, but excluding abandoned sibling branches and unrelated sessions.
_Avoid_: Summary, Notes

**Context Window**:
The conversation material currently presented to the model during a continuing Pi session.
_Avoid_: Session, context archive

**Context Checkpoint**:
The durable definition of a new Context Window, consisting of its Handoff and retained-History boundary. It is the common continuity point used when resuming, forking, or inheriting session context.
_Avoid_: Git Checkpoint, virtual-only boundary

**Rollover**:
A transition to a new Context Window through a Context Checkpoint, without starting a new Pi session or resetting the working environment, normally preceded by fresh agent-maintained Notes and an agent-written Handoff.
_Avoid_: New session, environment reset

**Manual Rollover**:
A Rollover explicitly requested by the user or caller, which pauses after its Context Checkpoint and waits for the user's next input.
_Avoid_: Automatic compaction, immediate task continuation

**Automatic Rollover**:
A normal Rollover started by Pi's context policy, which continues the current task after its Context Checkpoint.
_Avoid_: Manual Rollover, Emergency Rollover

**Idle Rollover**:
A Manual Rollover started by Context Management when a large Context Window sits idle until just before its provider prompt cache expires, so the preparation reads the cached prefix and the user's next message starts from a small Context Window.
_Avoid_: Idle compaction, background summary

**Emergency Rollover**:
A Rollover after native context overflow, carrying the last saved state and access to History without requiring a fresh agent-written Handoff.
_Avoid_: Automatic summary, normal Rollover

**Handoff**:
The agent-written continuation brief carried into the next Context Window to explain the current objective and next actions.
_Avoid_: History, automatic summary

**Tail**:
The portion of recent History retained by Pi across a Rollover for immediate conversational continuity, keeping tool calls together with their corresponding results.
_Avoid_: Handoff, summary
