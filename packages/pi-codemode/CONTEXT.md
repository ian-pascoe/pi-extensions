# CodeMode context

CodeMode lets an agent compose registered Pi tools from persistent TypeScript
notebook sessions.

## Language

**CodeMode Session**:
An identified sequence of cells that share notebook bindings and one current
execution.
_Avoid_: Pi session, runtime

**Cell**:
One TypeScript program submitted to a CodeMode Session for evaluation.
_Avoid_: command, query

**Notebook Binding**:
A top-level variable, function, or class declared by one cell and available to
later cells in the same CodeMode Session. A later cell may redefine it.
_Avoid_: global, persisted variable

**Exposure Mode**:
The policy that makes a registered Pi tool direct-only, CodeMode-only, or
available through both interfaces.
_Avoid_: inclusion, visibility
