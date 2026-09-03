/**
 * Decide whether terminal status UI should use Nerd Font icons.
 *
 * A positive result means the identified terminal path is expected to render Nerd Font symbols; it
 * does not prove the outer terminal's current font fallback configuration.
 */
export declare function shouldUseNerdFontIcons(environment?: Readonly<Record<string, string | undefined>>): boolean;
