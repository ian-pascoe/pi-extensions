import type { JsonValue } from "@earendil-works/pi-ai";
import { SECRET_NAME_PATTERN } from "@ian-pascoe/pi-utils/secret-registry";

/** Prefix of the environment variable a held Secret is exported as. */
export const SECRET_ENV_PREFIX = "PI_SECRET_";

/** The environment variable that carries a Secret's value into spawned processes. */
export function secretEnvName(name: string): string {
  return `${SECRET_ENV_PREFIX}${name}`;
}

/** `{{secret:NAME}}`, with anything between the colon and the braces, so malformed names are caught. */
const PLACEHOLDER = /\{\{secret:([^{}]*)\}\}/g;
/** `PI_SECRET_NAME` as a whole word, however a shell or program spells the expansion around it.
 * The bare prefix names no Secret, so a command that only mentions it, such as `env | grep` for the
 * prefix, is not a reference.
 */
const ENV_REFERENCE = /(?<![A-Za-z0-9_])PI_SECRET_([A-Za-z0-9_]+)/g;

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

/**
 * Every Secret Name a value references, in either form, including names that are not valid Secret
 * Names (such as `{{secret:lower}}`), so a call naming one can be refused rather than run as typed.
 */
export function referencedSecretNames(value: JsonValue): Set<string> {
  const names = new Set<string>();
  visitStrings(value, (text) => {
    for (const match of text.matchAll(PLACEHOLDER)) names.add(match[1] ?? "");
    for (const match of text.matchAll(ENV_REFERENCE)) names.add(match[1] ?? "");
  });
  return names;
}

/** Whether `name` is a valid Secret Name. */
export function isSecretName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name);
}

/**
 * A copy of `record` with every `{{secret:NAME}}` replaced by `resolve(NAME)`. Environment
 * references are left as written: the process environment resolves them.
 */
export function resolvePlaceholders(
  record: JsonValue,
  resolve: (name: string) => string,
): JsonValue {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: tool arguments are model-supplied JSON; only strings carry references.
  if (typeof record === "string") {
    return record.replace(PLACEHOLDER, (_match, name: string) => resolve(name));
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: tool arguments are model-supplied JSON; other primitives carry no references.
  if (record === null || typeof record !== "object") return record;
  if (Array.isArray(record)) return record.map((item) => resolvePlaceholders(item, resolve));
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, resolvePlaceholders(item, resolve)]),
  );
}
