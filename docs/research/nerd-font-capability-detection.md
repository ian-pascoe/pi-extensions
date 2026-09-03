# Nerd Font capability detection in terminal TUIs

**Date:** 2026-09-02
**Question:** Can a terminal TUI reliably detect that the active terminal font contains Nerd Font glyphs without an explicit user toggle, including over SSH and tmux? What is the smallest safe contract for Pi extensions?

## Conclusion

No portable, universally reliable capability query exists for this. A terminal application can query some properties of the terminal emulator, and a few emulators expose their configured font name, but neither is equivalent to asking whether the complete rendering stack will draw a particular Nerd Font glyph. However, a conservative terminal-identity allowlist is viable for emulators that officially bundle Nerd symbol fonts by default.

The reason is structural:

1. Nerd Fonts add thousands of icon glyphs to fonts; the project also supports a separate `SymbolsOnly` fallback font and explicitly warns that fallback scaling and placement can be imperfect ([Nerd Fonts README, features and fallback](https://github.com/ryanoasis/nerd-fonts/blob/master/readme.md#features), [fallback section](https://github.com/ryanoasis/nerd-fonts/blob/master/readme.md#option-8-font-fallback)).
2. The TUI writes characters to a terminal emulator. The emulator chooses the primary font, per-character fallback fonts, shaping, and presentation. The process writing the bytes normally cannot inspect those choices.
3. Terminal protocols conventionally report terminal behavior (cursor position, colors, hyperlinks, graphics, keyboard protocols), not the font coverage of the rendering pipeline. Unicode's East Asian Width annex says that actual glyph display width is given by the font and may be adjusted by layout; it also cautions that the property is not an off-the-shelf solution for modern terminal emulators ([UAX #11 §§2, 4](https://www.unicode.org/reports/tr11/#Scope)).

Therefore the extensions should use **automatic, conservative detection**: enable Nerd glyphs only for a small allowlist of terminals with documented bundled Nerd symbol fallback, and use portable symbols everywhere else. This is a high-confidence rendering heuristic, not a proof of font coverage. Absence of a positive identity signal must mean the portable path.

## Mechanism review

| Mechanism                                                         | What it can establish                                      | Reliability                                                                                                                                                                    | Local / SSH / tmux                                                              | Portable?                                 |
| ----------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ----------------------------------------- |
| DA/DA2 and other terminal identity queries                        | Emulator identity/version and advertised terminal features | Cannot establish font coverage                                                                                                                                                 | Usually reaches the outer emulator; multiplexers may intercept/filter           | Mostly standardized, but not a font query |
| XTGETTCAP / terminfo                                              | Terminfo strings and selected emulator capabilities        | No standard font-coverage capability                                                                                                                                           | Can work over SSH; forwarding depends on the path                               | Semi-standard; no Nerd Font field         |
| Cursor-position or width probing                                  | Observed cell advance for a test character                 | Heuristic only; a missing-glyph box, fallback glyph, or symbol mapped from another font can have the same width; probing also perturbs a live TUI and needs a response timeout | Fragile over SSH, tmux, and other proxies; responses may be delayed or consumed | No                                        |
| Fontconfig from the Pi process                                    | Coverage of a font file, if that file is identified        | Useful only for the inspected file; does not reveal terminal fallback, `symbol_map`, shaping, or the terminal's configuration                                                  | Wrong process on local terminal; generally impossible on SSH (Pi runs remotely) | Linux/fontconfig only                     |
| Environment conventions (`TERM_PROGRAM`, `KITTY_WINDOW_ID`, etc.) | Often emulator identity/session                            | Does not establish selected font/coverage for arbitrary terminals; useful for a documented bundled-font allowlist                                                              | SSH and tmux can preserve, rewrite, stale-cache, or omit variables              | Convention only                           |
| Terminal-specific current-font query                              | Configured primary font name on a supported emulator       | Better evidence, but still not coverage of fallback/symbol mappings; opt-in, timeout, and emulator-specific                                                                    | Kitty documents the query as usable over SSH; tmux forwarding is path-dependent | No                                        |

### Standard and semi-standard terminal queries

xterm's control-sequence reference defines:

- Primary and secondary **Device Attributes** as requests for terminal attributes/identification ([xterm `CSI c` and `CSI > c`](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h4-Functions-using-CSI-_-ordered-by-the-final-character-lparen-s-rparen:CSI-Ps-c.1CA3)).
- **XTGETTCAP** as a request for termcap/terminfo strings; its documented use is terminal capabilities such as keys and other terminal behavior ([XTGETTCAP](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h4-Device-Control-functions:DCS-plus-q-Pt-ST.F95)).
- **CPR/DSR** as cursor-position responses ([CPR](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h4-Functions-using-CSI-_-ordered-by-the-final-character-lparen-s-rparen:CSI-Ps-n:Ps-=-6.1E06), [DECXCPR](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h4-Functions-using-CSI-_-ordered-by-the-final-character-lparen-s-rparen:CSI-?-Ps-n:Ps-=-6.1E72)).

None reports “this code point has a usable glyph in the active rendering stack.” XTGETTCAP is especially easy to confuse with such a capability: terminfo describes terminal I/O behavior, not the font selected by the emulator.

### Font queries that are real, but terminal-specific

There are useful exceptions, but they are not a portable contract:

- **xterm OSC 50:** xterm documents OSC 50 as setting a font and says that `?` queries the font, returning the control sequence that would set the corresponding value ([xterm OSC 50](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h4-Operating-System-Commands:OSC-Ps;Pt-ST:Ps-=-5-0.1019)). This is xterm-specific, may be disabled by `allowFontOps`, and yields a configured font value—not complete coverage after fallback.
- **kitty XTGETTCAP extensions:** kitty's `query_terminal` kitten uses XTGETTCAP and documents `font_family`, `bold_font`, `italic_font`, and `bold_italic_font` as the current fonts' PostScript names ([kitty query-terminal](https://sw.kovidgoyal.net/kitty/kittens/query_terminal/#query-terminal)). Kitty also permits a `symbol_map` that maps code-point ranges to a separate font ([kitty `symbol_map`](https://sw.kovidgoyal.net/kitty/conf/#opt-kitty.symbol_map)). Thus `font_family` alone cannot answer whether a Nerd Font symbol will render. The kitten notes that queries require a terminal round trip and can block while waiting for a response.

Font-name matching (for example, looking for `Nerd Font` in a returned name) is at best a heuristic. A user can patch a font under another name, select a `SymbolsOnly` fallback, or map only the relevant PUA range to another face. Conversely, a font name can contain “Nerd” without the particular icon set or code point an extension uses.

### Documented bundled-symbol terminals

Terminal identity becomes materially stronger when the terminal itself documents that the default rendering path includes Nerd symbols:

- **kitty:** the official FAQ says kitty has a built-in NERD font and uses it for symbols not found in another system font ([kitty FAQ, Nerd Fonts](https://sw.kovidgoyal.net/kitty/faq/)). kitty's changelog dates the built-in font feature to 0.36.0 ([kitty 0.36.0 changelog](https://sw.kovidgoyal.net/kitty/changelog/#id32)). The FAQ also documents `symbol_map`, so a user can change which font receives the PUA ranges.
- **Ghostty:** the official configuration documentation says Ghostty embeds JetBrains Mono and has built-in nerd fonts ([Ghostty configuration, zero-configuration philosophy](https://ghostty.org/docs/config#zero-configuration-philosophy)).
- **WezTerm:** the official font documentation says WezTerm bundles `Nerd Font Symbols` and includes it in the default fallback list ([WezTerm fonts](https://wezterm.org/config/fonts.html#fallback)). It also explains that fallback is attempted when a glyph is absent and that a user can customize the font resolver/list.

These facts justify a useful **allowlist heuristic** without requiring a user toggle: if Pi positively identifies kitty, Ghostty, or WezTerm, it may select Nerd icons; for an unknown terminal it must select portable icons. The allowlist should be documented as “bundled Nerd symbols under terminal defaults,” not as a generic font capability.

The heuristic has predictable boundaries:

- **False negatives:** `TERM_PROGRAM`/terminal variables may be absent in an integrated terminal, stripped by SSH, unavailable in a remote shell, or stale because a tmux server retained an older environment. A known terminal reached through an unrecognised proxy will therefore use portable symbols.
- **False positives:** environment variables can be spoofed or describe an outer terminal while the path is unusual; users can override bundled-font/fallback configuration (for example kitty `symbol_map`, WezTerm font resolver/list, or Ghostty font settings). These cases are why the allowlist should stay small and why a portable fallback remains necessary.
- **tmux:** when attached directly to a known allowlisted outer terminal, Pi may additionally consult tmux's client terminal identity (`client_termname`) rather than trusting only the tmux process environment. If that identity is unavailable or ambiguous, choose portable symbols. Never infer Nerd support merely from `TERM=tmux-*`.
- **SSH:** identity can only be trusted when it is actually propagated from the outer terminal or obtained through a terminal-specific query. SSH's PTY negotiation itself carries no font field ([RFC 4254 §6.2](https://www.rfc-editor.org/rfc/rfc4254#section-6.2)).

### Glyph-width probing

An application could write a known Private Use Area code point, ask for CPR, and compare the column delta. This does not test glyph presence:

- Nerd Font glyph data includes private-use code points (the official [`glyphnames.json`](https://github.com/ryanoasis/nerd-fonts/blob/master/glyphnames.json) maps icon names to code points such as `e607`).
- Unicode defines character-width properties, but says actual display width comes from the font and layout ([UAX #11 §4](https://www.unicode.org/reports/tr11/#Definitions)). A fallback glyph or replacement box can occupy the same one-cell advance as the intended icon.
- To make the probe non-destructive, the TUI would need save/restore cursor state, hide output, parse asynchronous responses, and handle timeout/proxy behavior. tmux or SSH may consume, delay, or transform responses. A positive width result still cannot distinguish the cases above.

This is suitable only as an explicitly labelled heuristic experiment, not as a default rendering decision.

### Fontconfig and “inspect the current font”

Fontconfig can inspect **a named/local font file**. Its API describes `FcCharSet` as the set of Unicode characters encoded by a font, provides `FcCharSetHasChar`, and provides `FcFontMatch` to return the best font for a pattern ([Fontconfig developer reference](https://fontconfig.pages.freedesktop.org/fontconfig/fontconfig-devel/), [`FcCharSetHasChar`](https://fontconfig.pages.freedesktop.org/fontconfig/fontconfig-devel/#FCCHARSETHASCHAR), [`FcFontMatch`](https://fontconfig.pages.freedesktop.org/fontconfig/fontconfig-devel/#FCFONTMATCH)).

That does not identify the terminal emulator's selected face. The terminal is a different process and may use a platform font API rather than fontconfig; it may also apply per-code-point fallback. Nerd Fonts' own fallback documentation confirms that the active text font may lack the glyph while another font supplies it ([Nerd Fonts fallback](https://github.com/ryanoasis/nerd-fonts/blob/master/readme.md#option-8-font-fallback)). On SSH, Pi and the terminal emulator are on different machines. In tmux, Pi talks to a pseudo-terminal managed by tmux, not directly to the outer emulator.

## Local, SSH, and tmux boundaries

- **Local direct terminal:** an emulator-specific query can sometimes return a configured font name. It still cannot generally report the effective fallback/shaping result. Fontconfig inspection is only meaningful if the terminal uses the same local font configuration and the queried font is known.
- **SSH:** SSH's `pty-req` carries `TERM`, character/pixel dimensions, and encoded terminal modes; it has no font or glyph-coverage field ([RFC 4254 §6.2](https://www.rfc-editor.org/rfc/rfc4254#section-6.2)). Kitty's query-terminal docs explicitly say its XTGETTCAP queries can work over SSH, but that only helps when the outer terminal is kitty and the query is forwarded. No general SSH mechanism exists.
- **tmux:** tmux exposes client terminal name/type and `client_termfeatures`, which are terminal features—not font coverage ([tmux format variables](https://github.com/tmux/tmux/blob/master/tmux.1#L7289-L7301)). Pi's own capability detector treats image protocols as unreliable under tmux and asks tmux specifically whether OSC 8 hyperlinks are forwarded ([Pi `terminal-image.ts`](https://github.com/earendil-works/pi/blob/main/packages/tui/src/terminal-image.ts#L49-L80)); this is a useful precedent for conservative path-aware detection, but there is no corresponding font feature.

## Pi implications

Pi's upstream terminal capability model currently contains only `images`, `trueColor`, and `hyperlinks`; its documented overrides cover those three ([Pi `TerminalCapabilities`](https://github.com/earendil-works/pi/blob/main/packages/tui/src/terminal-image.ts#L8-L12), [Pi terminal setup](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/terminal-setup.md#capability-overrides)). Pi's extension UI API likewise exposes status/widgets/footer placement, not font capabilities ([Pi extension types](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts#L149-L185)).

## Recommended minimal contract

1. **Use auto mode with a conservative allowlist:** positively identify a direct kitty, Ghostty, or WezTerm session and select Nerd icons; unknown paths and all current tmux or screen sessions select portable icons. A future terminal adapter may safely admit an unambiguous outer-client identity. This requires no user toggle while taking advantage of documented bundled symbols.
2. **Do not add a glyph-probing startup query.** It cannot be made reliable and would add escape-sequence latency and rendering risk to every TUI startup.
3. **Use portable defaults outside the allowlist:** ordinary Unicode symbols with known width/meaning, or ASCII if the extension already has an ASCII path. Keep labels short and preserve semantic meaning without private-use glyphs.
4. **Centralize icon selection in Pi/TUI, not in each extension.** Define a small mapping of semantic icon → `{ portable, nerd }`, and make the allowlist decision once. This avoids six independent guesses and keeps width calculations consistent.
5. **Represent the result explicitly:** `nerdFont: true | false | "unknown"` (or equivalent), where `true` means “known bundled-symbol terminal under normal defaults,” not “font coverage proven.” Treat unknown as false. Keep terminal-specific font queries (kitty `kitty-query-font_family`, xterm OSC 50) isolated as optional adapters and never let them remove the portable fallback.

For the current footer work, this means the extensions can remain minimal and uncluttered immediately: Nerd Font icons are used automatically in the documented bundled-symbol terminals, while all unknown, remote, or ambiguous paths retain portable symbols. This is the best practical contract, while acknowledging that no standards-based query can prove glyph coverage across every direct terminal, SSH session, and tmux topology.

## Primary sources consulted

- [Nerd Fonts official repository README](https://github.com/ryanoasis/nerd-fonts/blob/master/readme.md) and [glyph database](https://github.com/ryanoasis/nerd-fonts/blob/master/glyphnames.json)
- [xterm control sequences](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html)
- [Unicode Standard Annex #11: East Asian Width](https://www.unicode.org/reports/tr11/)
- [kitty query-terminal documentation](https://sw.kovidgoyal.net/kitty/kittens/query_terminal/) and [kitty configuration](https://sw.kovidgoyal.net/kitty/conf/)
- [kitty FAQ: built-in NERD font](https://sw.kovidgoyal.net/kitty/faq/) and [kitty changelog 0.36.0](https://sw.kovidgoyal.net/kitty/changelog/#id32)
- [Ghostty configuration: zero-configuration philosophy](https://ghostty.org/docs/config#zero-configuration-philosophy)
- [WezTerm font fallback and bundled Nerd Font Symbols](https://wezterm.org/config/fonts.html#fallback)
- [Fontconfig developer reference](https://fontconfig.pages.freedesktop.org/fontconfig/fontconfig-devel/)
- [tmux upstream manual](https://github.com/tmux/tmux/blob/master/tmux.1)
- [RFC 4254: The Secure Shell (SSH) Connection Protocol](https://www.rfc-editor.org/rfc/rfc4254)
- [Pi upstream terminal capability source](https://github.com/earendil-works/pi/blob/main/packages/tui/src/terminal-image.ts) and [terminal setup docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/terminal-setup.md)
