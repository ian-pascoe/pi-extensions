# Shared Extension UI context

The Shared Extension UI context names the presentation conventions every package in this repository follows, so tool rows, messages, widgets, and panels read as part of the default Pi interface rather than as separate products, the shared behaviour of tools that wait, and the reference shorthand that selector packages expand in user messages.

## Language

### Transcript rendering

**Collapsed View**:
The compact default presentation of a tool row or message, showing a header and at most a bounded preview of its body.
_Avoid_: Summary view, short mode

**Expanded View**:
The full presentation of a tool row or message that the user reveals with Pi's tool-expansion key, which sets every item, or by clicking that one item; it carries no extra hint.
_Avoid_: Detail view, verbose mode

**Expand Hint**:
The dim notice on a Collapsed View that names how much is hidden and the key that reveals it, worded exactly as Pi's built-in tools word it.
_Avoid_: More indicator, truncation footer

**Nearest Built-in**:
The Pi built-in tool whose output most resembles a package tool's output, and whose header shape, preview length, and streaming behaviour that package tool copies.
_Avoid_: Reference tool, template

**Source Label**:
The bold, bracketed, lowercase extension name (`[termctrl]`, `[subagents]`, `[lsp]`) that opens a custom message or entry, as Pi opens its own with `[branch]`, `[compaction]`, and `[skill]`; what the message is follows on the same line, like the skill name in Pi's `[skill] name`.
_Avoid_: Message title, header badge

**Outcome Background**:
A tool row's background colour as Pi assigns it to show whether the call is pending, succeeded, or failed.
_Avoid_: Status colour, result box

### Status surfaces

**Status Mark**:
One glyph from the shared set (`●` active, `○` idle, `✓` done, `✗` failed, `!` warning, `■` stopped) that shows a state on a surface whose background does not already show it.
_Avoid_: Icon, badge, status glyph

**Severity Label**:
A coloured word (`nit`, `concern`, `blocker`) that shows how serious a finding is; it is never a Status Mark.
_Avoid_: Severity icon, priority marker

### Waiting tools

**Queued Steer**:
A message waiting to redirect an agent mid-turn, which Pi hands over only after every tool call in the current batch has returned: user input sent while the agent works, a parent agent's Coordination Message, or an extension message sent to steer. A follow-up is not a Queued Steer.
_Avoid_: Pending message, interrupt

**Steer Yield**:
A waiting tool call ending early because a Queued Steer is pending for its session, leaving what it waited on running. Its result reports the reason `steered`.
_Avoid_: Interrupt, cancellation, abort

### Reference shorthand

**Prose Span**:
A run of user-message Markdown that reads as plain text, outside code, existing links, HTML, and escapes. Reference shorthand expands only inside one.
_Avoid_: Plain-text region, non-code text

**Reference Sigil**:
The character that opens a reference shorthand: `$` for a Skill, `&` for an MCP server, `#` and `!` for an issue, `%` for a subagent model. It opens completion and conversion only at a token boundary in a Prose Span.
_Avoid_: Trigger character
