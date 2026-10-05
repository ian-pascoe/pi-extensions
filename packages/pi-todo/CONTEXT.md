# Todo List context

The Todo List context tracks the work an agent intends to complete during a Pi session without prescribing how that work is planned or performed.

## Language

**Task**:
An independent, non-nested unit of work recorded by the agent in the Todo List, identified by a title and optionally expanded with a description.
_Avoid_: Todo, work item

**Task Status**:
A Task's unconstrained state: `pending`, `active`, or `completed`. Multiple Tasks may be active simultaneously.
_Avoid_: Done flag, progress

**Todo List**:
The current session branch's collection of Tasks made available to the agent.
_Avoid_: Task list, plan

**Todo List Snapshot**:
The hidden, header-labelled message that carries the Todo List's final state for one tool group (or the post-compaction baseline) into the model's context.
_Avoid_: Todo message, state update
