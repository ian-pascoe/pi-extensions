/**
 * The process-wide registry of held Secrets that Pi Secret fills and other packages, such as
 * Guardian, read to resolve and redact Secret References (ADR-0008). It lives on `globalThis`
 * under a registered symbol so every installed copy of pi-utils in one Pi process shares it.
 */

/** Environment-variable style: an uppercase letter or underscore, then uppercase letters, digits, or underscores. */
export const SECRET_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/** Whoever held a Secret; only the same owner object can revoke it. */
export interface SecretOwner {
  /** Names the holder in diagnostics, such as `pi-secret`. */
  readonly description: string;
}

interface HeldSecret {
  readonly value: string;
  readonly owner: SecretOwner;
  /** Milliseconds since the epoch after which the Secret no longer resolves, if it expires. */
  readonly expiresAt: number | undefined;
}

/** Secrets that resolve, by Secret Name. */
const HELD_KEY = Symbol.for("@ian-pascoe/pi-utils/secret-registry/held.v1");
/**
 * Every value ever held in this process, with the Secret Name it was held under, so output
 * printed after a Secret expires or is replaced is still redacted.
 */
const REDACTED_KEY = Symbol.for("@ian-pascoe/pi-utils/secret-registry/redacted.v1");

function globalMap<V>(key: symbol): Map<string, V> {
  const existing: unknown = Object.getOwnPropertyDescriptor(globalThis, key)?.value;
  // Only this module, in any copy, writes these slots, always with a Map of its kind.
  // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the slot's key names its value type, and only this module writes it.
  if (existing instanceof Map) return existing as Map<string, V>;
  const created = new Map<string, V>();
  Object.defineProperty(globalThis, key, { value: created, configurable: true });
  return created;
}

const held = (): Map<string, HeldSecret> => globalMap(HELD_KEY);
const redacted = (): Map<string, string> => globalMap(REDACTED_KEY);

/** The Secret Reference that stands in for a Secret's value in tool arguments and output. */
export function secretReference(name: string): string {
  return `{{secret:${name}}}`;
}

/** Throw unless `name` is a valid Secret Name. */
export function assertSecretName(name: string): void {
  if (!SECRET_NAME_PATTERN.test(name))
    throw new Error(
      `Invalid Secret Name ${JSON.stringify(name)}: use uppercase letters, digits, and underscores, not starting with a digit`,
    );
}

/**
 * Hold `value` under `name` for `owner`, replacing any value already held under that name. The
 * value resolves until revoked or until `expiresAt` (milliseconds since the epoch) passes, and is
 * redacted for the rest of the process.
 */
export function holdSecret(
  name: string,
  value: string,
  owner: SecretOwner,
  expiresAt?: number,
): void {
  assertSecretName(name);
  if (value === "") throw new Error(`Secret ${name} cannot be empty`);
  held().set(name, { value, owner, expiresAt });
  redacted().set(value, name);
}

/** Stop resolving `name` if `owner` holds it; its values are still redacted. */
export function revokeSecret(name: string, owner: SecretOwner): void {
  const secrets = held();
  if (secrets.get(name)?.owner === owner) secrets.delete(name);
}

/** Whether a held Secret still resolves: a timer revoking it may run late, such as after sleep. */
function current(secret: HeldSecret): boolean {
  return secret.expiresAt === undefined || secret.expiresAt > Date.now();
}

/** The value held under `name`, or undefined when no Secret by that name resolves. */
export function resolveSecret(name: string): string | undefined {
  const secret = held().get(name);
  return secret !== undefined && current(secret) ? secret.value : undefined;
}

/** Secret Names that currently resolve. */
export function heldSecretNames(): string[] {
  return [...held()].flatMap(([name, secret]) => (current(secret) ? [name] : []));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The pattern for the values redacted so far; values are only ever added, so size keys it. */
let cachedPattern: { size: number; pattern: RegExp } | undefined;

function redactionPattern(values: Map<string, string>): RegExp | undefined {
  if (values.size === 0) return undefined;
  if (cachedPattern?.size !== values.size) {
    const alternatives = [...values.keys()]
      .toSorted((a, b) => b.length - a.length)
      .map(escapeRegExp);
    cachedPattern = { size: values.size, pattern: new RegExp(alternatives.join("|"), "g") };
  }
  return cachedPattern.pattern;
}

function redactValue<T>(value: T, values: Map<string, string>, pattern: RegExp): T {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: walks arbitrary JSON-like tool data; only strings carry text to redact.
  if (typeof value === "string") {
    // One pass, so a Secret Reference inserted for one value is never matched by another.
    const text = value.replace(pattern, (match) => secretReference(values.get(match) ?? ""));
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: `T` is `string` in this branch, and a string is returned.
    return (text === value ? value : text) as T;
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: walks arbitrary JSON-like tool data; primitives other than strings carry no text.
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const next = redactValue(item, values, pattern);
      if (next !== item) changed = true;
      return next;
    });
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: an array of the same items, each redacted to its own type.
    return (changed ? items : value) as T;
  }
  // Class instances (buffers, dates, errors) are left alone: tool data is JSON-like.
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  let changed = false;
  const entries = Object.entries(value).map(([key, item]) => {
    const next = redactValue(item, values, pattern);
    if (next !== item) changed = true;
    return [key, next] as const;
  });
  // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: an object with the same keys, each value redacted to its own type.
  return (changed ? Object.fromEntries(entries) : value) as T;
}

/**
 * `value` with every occurrence of any value held in this process replaced by its Secret
 * Reference, in strings nested in plain objects and arrays. Returns `value` itself when nothing
 * was redacted, and never modifies it.
 */
export function redactSecrets<T>(value: T): T {
  const values = redacted();
  const pattern = redactionPattern(values);
  return pattern === undefined ? value : redactValue(value, values, pattern);
}
