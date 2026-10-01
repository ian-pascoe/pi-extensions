import {
  copyToClipboard,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { shouldUseNerdFontIcons } from "@ian-pascoe/pi-utils";
import { CommandDeckEditor } from "./command-deck-editor.js";
import {
  formatCacheHit,
  formatContextUsage,
  formatDeckCwd,
  formatStatusFooter,
} from "./deck-chrome.js";
import { isPiCommand } from "./pi-commands.js";
import {
  formatWorktreeSnapshot,
  parseWorktreeSnapshot,
  WORKTREE_SNAPSHOT_GIT_ARGS,
  type WorktreeSnapshot,
} from "./worktree-snapshot.js";

const GIT_TIMEOUT_MS = 2_000;
const COMMAND_DECK_FACTORY = Symbol.for("@ian-pascoe/pi-command-deck/editor-factory");

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

/** Replaces Pi's editor and footer with the Command Deck and Status Footer. */
export default function commandDeck(pi: ExtensionAPI): void {
  let activeEditor: CommandDeckEditor | undefined;
  let requestRender = (): void => {};
  let getGitBranch = (): string | null => null;
  let snapshot: WorktreeSnapshot | undefined;
  let refreshGeneration = 0;

  const refreshWorktreeSnapshot = async (ctx: ExtensionContext): Promise<void> => {
    if (ctx.mode !== "tui") return;
    const generation = ++refreshGeneration;
    const result = await pi
      .exec("git", WORKTREE_SNAPSHOT_GIT_ARGS, { cwd: ctx.cwd, timeout: GIT_TIMEOUT_MS })
      .catch(() => undefined);
    if (generation !== refreshGeneration) return;
    snapshot = result?.code === 0 ? parseWorktreeSnapshot(result.stdout) : undefined;
    requestRender();
  };

  pi.on("session_shutdown", (event) => {
    activeEditor?.restoreTerminalCursor(event);
    activeEditor = undefined;
    requestRender = () => {};
    snapshot = undefined;
    refreshGeneration += 1;
  });

  // Pi awaits handlers before continuing the agent loop; never block it on Git.
  pi.on("tool_execution_end", (_event, ctx) => {
    void refreshWorktreeSnapshot(ctx);
  });
  pi.on("input", (_event, ctx) => {
    void refreshWorktreeSnapshot(ctx);
  });

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    const useNerdFontIcons = shouldUseNerdFontIcons(process.env);
    let clipboardWarned = false;
    const copy = (text: string): void => {
      copyToClipboard(text).catch((error) => {
        if (clipboardWarned) return;
        clipboardWarned = true;
        const reason = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(
          `Command Deck could not copy the yank to the system clipboard (${reason}); put still works inside Pi. Run /skill:pi-command-deck to diagnose.`,
          "warning",
        );
      });
    };

    // Install before awaiting so later extensions wrap the Command Deck rather than replace it.
    const current = ctx.ui.getEditorComponent();
    if (current !== undefined && !(COMMAND_DECK_FACTORY in current)) {
      ctx.ui.notify(
        "Command Deck replaced an editor installed by an earlier extension. Load pi-command-deck before extensions that wrap the editor. Run /skill:pi-command-deck to diagnose.",
        "warning",
      );
    }
    const factory: EditorFactory = (tui, editorTheme, keybindings) => {
      activeEditor?.restoreTerminalCursor();
      requestRender = () => tui.requestRender();
      activeEditor = new CommandDeckEditor(
        tui,
        editorTheme,
        keybindings,
        {
          notify: (message, level) => ctx.ui.notify(message, level),
          quit: () => ctx.shutdown(),
          isPiCommand: (name) => isPiCommand(name, pi.getCommands()),
          copy,
        },
        {
          theme: () => ctx.ui.theme,
          headerLeft: () => {
            const theme = ctx.ui.theme;
            const branch = getGitBranch();
            const status =
              snapshot === undefined
                ? ""
                : `${theme.fg("dim", " · ")}${formatWorktreeSnapshot(snapshot, theme, useNerdFontIcons)}`;
            return `${theme.fg("dim", ` ${formatDeckCwd(ctx.cwd)}`)}${branch ? theme.fg("syntaxVariable", ` · ${branch}`) : ""}${status} `;
          },
          headerRight: () => {
            const theme = ctx.ui.theme;
            const thinking = pi.getThinkingLevel();
            return ` ${theme.fg("syntaxFunction", ctx.model?.id ?? "no model")} ${theme.fg("dim", "·")} ${theme.getThinkingBorderColor(thinking)(thinking)} `;
          },
          railRight: () => {
            const theme = ctx.ui.theme;
            const cache = theme.fg("syntaxNumber", formatCacheHit(ctx.sessionManager.getEntries()));
            const context = theme.fg("muted", formatContextUsage(ctx.getContextUsage()?.percent));
            return ` ${cache}${theme.fg("dim", " · ")}${context} `;
          },
        },
      );
      return activeEditor;
    };
    // The global marker distinguishes an earlier Command Deck instance, including one from a reloaded module, from a foreign editor.
    ctx.ui.setEditorComponent(Object.assign(factory, { [COMMAND_DECK_FACTORY]: true }));

    ctx.ui.setWorkingVisible(true);
    ctx.ui.setFooter((tui, theme, footerData) => {
      getGitBranch = () => footerData.getGitBranch();
      const stopWatchingBranch = footerData.onBranchChange(() => tui.requestRender());
      return {
        render: (width: number) =>
          formatStatusFooter(
            footerData.getExtensionStatuses(),
            theme.fg("dim", " · "),
            theme.fg("dim", "…"),
            width,
          ),
        invalidate() {},
        dispose: stopWatchingBranch,
      };
    });

    await refreshWorktreeSnapshot(ctx);
  });
}
