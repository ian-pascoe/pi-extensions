# Improve the Pi CodeMode UI

**Status:** Implemented

## Outcome

Give a human watching Pi a semantic, durable account of CodeMode Cells and an
ephemeral view of current CodeMode Session activity. Keep CodeMode
agent-operated: presentation never executes a Cell, controls a Session, or
changes the text returned to the model.

Use Pi LSP's compact/expanded Transcript and Result Spill pattern, Pi DAP's
read-only above-editor Observer lifecycle, and Minimal Subagents' accessible
status grammar, responsive hierarchy, and live footer.

## Transcript

- Register semantic call/result renderers for execute, poll, and cancel.
- Collapsed rows show operation, Session prefix, lifecycle, Cell Ordinal,
  returned-value shape, nested-tool count, and elapsed time.
- Expanded rows show explicit arguments, full Session ID, bounded TypeScript,
  structured data/error, Session reusable/closed state, and bounded nested-tool
  names, outcomes, and durations.
- Limit displayed source to 200 lines or 50 KB and returned data to 2,000 lines
  or 50 KB. Write complete oversized data to a private Result Spill.
- Publish awaited progress immediately and once per second.
- Preserve exact `AgentToolResult.content`; add only strict, bounded, versioned
  Presentation Snapshots to details.
- Infer historical results without snapshots. Fall back to original text for
  malformed or unknown snapshots.

Use symbols and text together with Pi's theme:

```text
◉ running   ○ idle   ✓ completed
× failed    ■ cancelled   ! timed out
```

Script and serialization failures leave the Session reusable. Timeout,
cancellation, termination, and runtime death close it.

## Observer

- Mount one read-only TUI widget above the editor during activity.
- Show running Sessions first, then relevant idle/recent-terminal Sessions;
  bound the view to eight rows plus `… +N more`.
- Use shortest-unique Session prefixes of at least eight characters.
- Show `Cell N`, elapsed time, and bounded active nested-tool names/counts.
- Show footer status only while Cells run: `◉ N running · N live`.
- Hide after a ten-second all-idle/terminal cooldown and remount on activity.
- Notify once for an idle Deno worker failure not represented by an active tool
  result. Suppress duplicate represented failures.
- Add no controls, settings, hidden operations, editor, or raw nested payloads.

## TDD seams

Verify behavior through:

1. `createCodeModeToolDefinitions` and its byte-stable model content;
2. pure Transcript renderers through `Component.render(width)`;
3. the real-Deno `CodeModeSessionCoordinator` execute/result/cancel/inspection
   interface with deterministic clocks and nested-tool bridge;
4. pure Observer projection/rendering plus its lifecycle controller;
5. the private Result Spill owner; and
6. the real Pi `AgentSession` extension fixture.

Cover partial, success, reusable failure, fatal failure, cancellation,
malformed/history fallback, terminal-width degradation, cooldown, notification
suppression, reload, shutdown, and resource cleanup.
