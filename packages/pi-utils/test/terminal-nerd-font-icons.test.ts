import { describe, expect, test } from "vitest";
import { shouldUseNerdFontIcons } from "../src/terminal-nerd-font-icons.js";

describe("Nerd Font terminal decision", () => {
  test.each([
    { TERM_PROGRAM: "kitty" },
    { TERM_PROGRAM: "Ghostty" },
    { TERM_PROGRAM: "WezTerm" },
    { KITTY_WINDOW_ID: "1" },
    { TERM: "xterm-kitty" },
    { GHOSTTY_RESOURCES_DIR: "/opt/ghostty" },
    { TERM: "xterm-ghostty" },
    { WEZTERM_PANE: "1" },
    { HERDR_ENV: "1", TERM: "xterm-256color" },
  ])("uses Nerd Font icons for a known capable terminal path: %o", (environment) => {
    expect(shouldUseNerdFontIcons(environment)).toBe(true);
  });

  test.each([
    {},
    { TERM: "xterm-256color" },
    { TERM_PROGRAM: "vscode" },
    { TERM_PROGRAM: "iTerm.app" },
  ])("uses portable icons for an unknown terminal: %o", (environment) => {
    expect(shouldUseNerdFontIcons(environment)).toBe(false);
  });

  test.each([
    { TERM_PROGRAM: "kitty", TMUX: "/tmp/tmux/default,1,0" },
    { TERM: "tmux-256color", WEZTERM_PANE: "1" },
    { GHOSTTY_RESOURCES_DIR: "/opt/ghostty", TERM: "screen-256color" },
  ])("uses portable icons through an ambiguous terminal multiplexer: %o", (environment) => {
    expect(shouldUseNerdFontIcons(environment)).toBe(false);
  });
});
