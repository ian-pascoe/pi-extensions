import type { JsonValue } from "@earendil-works/pi-ai";
import { SECRET_NAME_PATTERN } from "@ian-pascoe/pi-utils/secret-registry";

/** Prefix of the environment variable a held Secret is exported as. */
export const SECRET_ENV_PREFIX = "PI_SECRET_";

/** The environment variable that carries a Secret's value into spawned processes. */
export function secretEnvName(name: string): string {
  return `${SECRET_ENV_PREFIX}${name}`;
}

/**
 * A Secret Reference in either form, optionally escaped by a backslash right before it:
 * - `{{secret:NAME}}`, with anything between the colon and the braces, so malformed names are caught;
 * - `PI_SECRET_NAME` as a whole word, however a shell or program spells the expansion around it. The
 *   bare prefix names no Secret, so a command that only mentions it, such as `env | grep` for the
 *   prefix, is not a reference.
 *
 * An escaped reference is literal text: it names no Secret, and the backslash is removed before
 * the tool runs, so documentation and tests can contain the syntax. A shell's own escape of an
 * expansion, `\$PI_SECRET_NAME` or `\${PI_SECRET_NAME}`, is literal to the shell too, so it names no Secret
 * and is left exactly as written.
 */
const REFERENCE = /(\\?)(?:\{\{secret:([^{}]*)\}\}|(?<![A-Za-z0-9_])PI_SECRET_([A-Za-z0-9_]+))/g;

/** One reference found in text. */
interface ReferenceMatch {
  readonly escaped: boolean;
  readonly name: string;
  readonly form: "placeholder" | "env";
}

/** `\$` or `\${` right before an expansion: the shell prints it literally. */
const SHELL_ESCAPE = /\\\$\{?$/;

/**
 * The reference matched at `index` of `text`, or undefined when a shell escape makes it literal.
 */
function matchOf(
  groups: (string | undefined)[],
  text: string,
  index: number,
): ReferenceMatch | undefined {
  const [escape, placeholder, env] = groups;
  if (placeholder !== undefined)
    return { escaped: escape === "\\", name: placeholder, form: "placeholder" };
  if (escape !== "\\" && SHELL_ESCAPE.test(text.slice(Math.max(0, index - 3), index)))
    return undefined;
  return { escaped: escape === "\\", name: env ?? "", form: "env" };
}

/**
 * Every Secret Name a value references, in either form, including names that are not valid Secret
 * Names (such as `{{secret:lower}}`), so a call naming one can be refused rather than run as typed.
 * Escaped references name nothing.
 */
export function referencedSecretNames(value: JsonValue): Set<string> {
  const names = new Set<string>();
  visitStrings(value, (text) => {
    for (const found of text.matchAll(REFERENCE)) {
      const match = matchOf(found.slice(1), text, found.index);
      if (match !== undefined && !match.escaped) names.add(match.name);
    }
  });
  return names;
}

function visitStrings(value: JsonValue, visit: (text: string) => void): void {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: tool arguments are model-supplied JSON; only strings carry references.
  if (typeof value === "string") {
    visit(value);
    return;
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: tool arguments are model-supplied JSON; other primitives carry no references.
  if (value === null || typeof value !== "object") return;
  for (const item of Object.values(value)) visitStrings(item, visit);
}

/** Whether `name` is a valid Secret Name. */
export function isSecretName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name);
}

/**
 * `record` with every `{{secret:NAME}}` replaced by `resolve(NAME)` and every escaped reference
 * turned into literal text without its backslash. Environment references are left as written:
 * the process environment resolves them. Returns `record` itself when nothing changed.
 */
export function rewriteReferences(record: JsonValue, resolve: (name: string) => string): JsonValue {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: tool arguments are model-supplied JSON; only strings carry references.
  if (typeof record === "string") {
    let text = "";
    let last = 0;
    for (const found of record.matchAll(REFERENCE)) {
      const [whole] = found;
      const match = matchOf(found.slice(1), record, found.index);
      text += record.slice(last, found.index);
      if (match === undefined || (!match.escaped && match.form === "env")) text += whole;
      else text += match.escaped ? whole.slice(1) : resolve(match.name);
      last = found.index + whole.length;
    }
    text += record.slice(last);
    return text === record ? record : text;
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: tool arguments are model-supplied JSON; other primitives carry no references.
  if (record === null || typeof record !== "object") return record;
  let changed = false;
  const rewrite = (item: JsonValue) => {
    const next = rewriteReferences(item, resolve);
    if (next !== item) changed = true;
    return next;
  };
  if (Array.isArray(record)) {
    const items = record.map(rewrite);
    return changed ? items : record;
  }
  const entries = Object.entries(record).map(([key, item]) => [key, rewrite(item)] as const);
  return changed ? Object.fromEntries(entries) : record;
}
