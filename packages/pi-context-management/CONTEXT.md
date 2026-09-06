# Context Management context

The Context Management context lets an agent continue a Pi session across Context Windows using its own Notes and retrievable History.

## Language

**Notes**:
Agent-maintained working knowledge organized into independently named documents belonging to one Pi session branch, rather than shared knowledge across independent sessions or projects.
_Avoid_: Project memory, global memory

**Note Index**:
The compact catalogue of available Note names carried into a Context Window so the agent can choose which Notes to read.
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
A transition to a new Context Window through a Context Checkpoint, without starting a new Pi session or resetting the working environment, normally requested by the agent.
_Avoid_: New session, environment reset

**Emergency Rollover**:
An automatic Rollover at a context safety limit, carrying the last saved state and access to History without requiring a fresh agent-written checkpoint.
_Avoid_: Automatic summary, normal Rollover

**Handoff**:
The agent-written continuation brief carried into the next Context Window to explain the current objective and next actions.
_Avoid_: History, automatic summary

**Tail**:
A bounded portion of recent History carried across a Rollover for immediate conversational continuity, keeping tool calls together with their corresponding results.
_Avoid_: Handoff, summary
