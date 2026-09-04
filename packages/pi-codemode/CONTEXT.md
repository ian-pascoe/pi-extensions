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

**Tool Catalogue**:
The generated TypeScript declarations for one synchronized Exposure Mode
snapshot. Registry changes update execution policy immediately, while catalogue
rendering waits for the next model-turn or CodeMode-access boundary.
_Avoid_: registry, tool list

**CodeMode Transcript**:
The durable, semantic presentation of CodeMode tool calls and results in Pi's
conversation history.
_Avoid_: notebook UI, raw tool JSON

**CodeMode Observer UI**:
The ephemeral, read-only TUI presentation of current CodeMode Session activity.
It never executes a Cell or controls a Session.
_Avoid_: session manager, notebook editor, control panel

**Cell Ordinal**:
The human-facing sequence number of a Cell within one CodeMode Session.
_Avoid_: Cell ID, protocol ID

**Presentation Snapshot**:
Bounded facts retained with a CodeMode Transcript result so its semantic display
can be reconstructed later. It is not returned to the model.
_Avoid_: result, Observer state

**Result Spill**:
A private file containing complete returned data when the expanded CodeMode
Transcript reaches its display limit.
_Avoid_: log, cache

**Cell Console Output**:
Ordered diagnostic text emitted through a Cell's supported `console` methods,
distinct from the Cell's returned data.
_Avoid_: log, standard output

**Session Reclamation**:
Capacity-pressure shutdown of the least-recently-used idle CodeMode Session.
It releases the Deno process and discards that Session's Notebook Bindings.
_Avoid_: cleanup, timeout
