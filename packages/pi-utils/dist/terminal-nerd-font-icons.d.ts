/**
 * Decide whether terminal status UI should use Nerd Font icons.
 *
 * A positive result means the identified terminal normally bundles Nerd Font symbols; it does not
 * prove that a user has kept the terminal's default font fallback configuration.
 */
export declare function shouldUseNerdFontIcons(environment?: Readonly<Record<string, string | undefined>>): boolean;
