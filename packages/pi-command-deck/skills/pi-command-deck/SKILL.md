---
name: pi-command-deck
description: Diagnose pi-command-deck when the prompt editor, Vim keys, Deck Header, Mode Rail, or Status Footer misbehave.
license: MIT
disable-model-invocation: true
---

# Pi Command Deck

1. Read [`../../README.md`](../../README.md) and [`../../CONTEXT.md`](../../CONTEXT.md) for the expected behavior and vocabulary.
2. Confirm Pi runs in interactive TUI mode; the Command Deck installs nothing in print, JSON, or RPC modes.
3. If the Mode Rail shows no Vim Mode and a notice reported a fallback, the installed Pi changed the private editor fields the adapter needs ([ADR-0001](../../docs/adr/0001-reach-editor-internals-through-one-adapter.md)). Compare `src/editor-adapter.ts` with the installed `@earendil-works/pi-tui` `Editor`.
4. If another extension's editor replaces the Command Deck, check extension load order: the Command Deck installs at the start of `session_start`, and later extensions must wrap the existing editor factory.
5. For a Vim key problem, reproduce it from an empty prompt, record the Mode Rail label before and after each key, and check whether a host keybinding (interrupt, exit, image paste, or an extension shortcut) matched the key first.
6. If yanks do not reach the system clipboard, check the warning's reason: Linux needs `wl-copy` (Wayland) or `xclip`/`xsel` (X11), and remote or headless sessions need a terminal that accepts OSC 52.
7. For missing Git status, run `git status --porcelain=v2 --branch --untracked-files=normal` in the session directory; a failure or timeout hides the Worktree Snapshot.
8. Finish when the symptom reproduces at one named boundary: the editor adapter, the Vim engine, host keybindings, the clipboard, or Git.
