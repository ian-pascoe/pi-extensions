const BUNDLED_NERD_FONT_TERM_PROGRAMS = new Set(["ghostty", "kitty", "wezterm"]);
/**
 * Decide whether terminal status UI should use Nerd Font icons.
 *
 * A positive result means the identified terminal normally bundles Nerd Font symbols; it does not
 * prove that a user has kept the terminal's default font fallback configuration.
 */
export function shouldUseNerdFontIcons(environment = process.env) {
    const term = environment.TERM?.toLowerCase() ?? "";
    if (environment.TMUX || term.startsWith("tmux") || term.startsWith("screen"))
        return false;
    const termProgram = environment.TERM_PROGRAM?.toLowerCase() ?? "";
    return (BUNDLED_NERD_FONT_TERM_PROGRAMS.has(termProgram) ||
        Boolean(environment.KITTY_WINDOW_ID) ||
        term.includes("kitty") ||
        Boolean(environment.GHOSTTY_RESOURCES_DIR) ||
        term.includes("ghostty") ||
        Boolean(environment.WEZTERM_PANE));
}
