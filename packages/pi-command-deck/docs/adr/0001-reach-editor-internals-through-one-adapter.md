# Reach editor internals through one adapter

Vim editing must place the cursor and group each Vim change into one undo step. Pi's public `Editor` API exposes `getCursor()` but no cursor setter or undo access. Command Deck therefore reads and writes private `Editor` fields: the text `state` and `undoStack`, plus prompt history, autocomplete, paste-marker, and layout fields. It does so only through one adapter module. At startup the adapter checks that those fields exist. If any are missing, Command Deck falls back to Pi's plain editor inside the Deck Header and Mode Rail and shows one warning. An SDK integration test pins the adapter against the installed Pi.

## Considered Options

- Owning a separate buffer, renderer, and undo stack was rejected. It would reimplement autocomplete, paste markers, and prompt history that Pi's `Editor` already owns.
- Driving the cursor with synthetic arrow and Home/End keystrokes was rejected. It depends on user keybindings, and every motion would cost many redundant edits and renders.
