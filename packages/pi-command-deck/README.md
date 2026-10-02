# Pi Command Deck

`@ian-pascoe/pi-command-deck` replaces Pi's prompt editor and footer with a compact **Command Deck** that edits text with Vim keys and follows the active theme.

Requires Node `>=22.19.0` and Pi `>=0.99.0` (see [Compatibility](#compatibility)).

## Install

```bash
pi install npm:@ian-pascoe/pi-command-deck
# or from this checkout
pi -e ./src/index.ts
```

## Layout

- **Deck Header** (top border): working directory, Git branch, and the **Worktree Snapshot** (ahead, behind, conflicted, untracked, and modified counts) on the left; model and thinking level on the right.
- **Mode Rail** (bottom border): the current **Vim Mode** with pending keys on the left; the latest cache hit rate and context usage on the right.
- **Status Footer**: Pi's footer reduced to extension statuses, sorted by status key.

The Worktree Snapshot refreshes when a session starts, after each tool finishes, and when you submit input. It uses Nerd Font icons in terminals known to ship them and plain symbols elsewhere. Outside a Git worktree, or when `git` fails, the Deck Header omits it.

## Vim

The editor starts in insert mode and returns to it after each submit. Escape enters normal mode. In normal mode with nothing pending, Escape interrupts the agent only when Escape is bound to Pi's `app.interrupt` action. Pi and extension keybindings take precedence over pending Vim commands.

- **Modes**: insert, normal, replace (`R`), visual (`v`), visual-line (`V`), ex (`:`), and search (`/`, `?`).
- **Motions**: `h j k l 0 ^ _ $ w b e W B E ge gE gg G { } % f F t T ; , n N * #` and `/pattern`, with counts. `k` on the first line and `j` on the last line step through Pi's prompt history.
- **Operators**: `d c y g~ gu gU` with motions, text objects, and doubled linewise forms.
- **Text objects**: `iw aw iW aW`, quotes, `( [ { <` brackets (`b`, `B` aliases), and paragraphs (`ip ap`).
- **Edits**: `x X s S D C Y r J gJ p P ~`, undo `u`, redo `Ctrl-r`, and `.` repeat, including visual-mode edits.
- **Visual mode**: highlighted selection, `o`, `gv`, and operators on the selection.
- **Ex commands**: `:q`, `:q!`, `:qa`, and their long forms quit Pi; `:name args` runs Pi's `/name args` command; `:!cmd` runs `!cmd`. Your draft returns after the command runs.

Yanks (`y`, `Y`, and visual `y`) also copy to the system clipboard through Pi's clipboard support, with paste markers expanded; if the copy fails, one warning appears per session. Deletes and changes fill only the internal register, so `x` or `cw` never overwrites your clipboard. Put (`p`, `P`) reads the internal register; to paste from the system clipboard, paste in insert mode. The terminal cursor is a bar in insert and replace modes and a block otherwise; it is restored on exit.

There are no user settings.

## Compatibility

Pi's public editor API cannot place the cursor or group undo steps, so the Command Deck reaches private editor fields through one adapter ([ADR-0001](docs/adr/0001-reach-editor-internals-through-one-adapter.md)). If a Pi release changes those fields, the Command Deck keeps its borders, falls back to Pi's plain editor, and shows one notice.

The Command Deck replaces any earlier editor component when a session starts. Pi runs `session_start` handlers in extension load order, so extensions that wrap the editor, such as Minimal Subagents, must load after it: list `pi-command-deck` earlier in your Pi packages. The Git collection's manifest already loads it first. When the Command Deck replaces an existing editor, it shows a warning.

This is privileged extension code: review it before installing it into an agent that can access local files, tools, or credentials.
