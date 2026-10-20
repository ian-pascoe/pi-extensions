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
  /** The value last held or read; undefined until a refreshable Secret is first read. */
  value: string | undefined;
  readonly owner: SecretOwner;
  /** Milliseconds since the epoch after which the Secret no longer resolves, if it expires. */
  readonly expiresAt: number | undefined;
  /** Reads the current value from where it lives, such as a Secret Provider (ADR-0010). */
  readonly refresh: (() => Promise<string>) | undefined;
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
  held().set(name, { value, owner, expiresAt, refresh: undefined });
  redacted().set(value, name);
}

export interface RefreshableSecretOptions {
  /** Reads the current value; every value it returns is redacted for the rest of the process. */
  refresh: () => Promise<string>;
  /** A value already read, if any; otherwise nothing resolves until the first refresh. */
  value?: string;
  /** Milliseconds since the epoch after which the Secret no longer resolves. */
  expiresAt?: number;
}

/**
 * Hold a Secret whose value lives elsewhere, such as in a Secret Provider, for `owner`, replacing
 * any value already held under `name`. {@link refreshSecret} reads it again through `refresh`, so
 * every session in the process, including Child Agents, uses the current value (ADR-0010).
 */
export function holdRefreshableSecret(
  name: string,
  owner: SecretOwner,
  options: RefreshableSecretOptions,
): void {
  assertSecretName(name);
  const value = options.value === "" ? undefined : options.value;
  held().set(name, { value, owner, expiresAt: options.expiresAt, refresh: options.refresh });
  if (value !== undefined) redacted().set(value, name);
}

/**
 * Read the current value of the Secret held under `name` through its refresh callback, keep it,
 * and return it; a Secret without one returns its held value. Undefined when no Secret by that
 * name is held. Rejects, keeping the last value read, when the refresh fails or reads nothing.
 */
export async function refreshSecret(name: string): Promise<string | undefined> {
  const secret = held().get(name);
  if (secret === undefined || !current(secret)) return undefined;
  if (secret.refresh === undefined) return secret.value;
  const value = await secret.refresh();
  if (value === "") throw new Error(`Secret ${name} read as empty`);
  redacted().set(value, name);
  // The Secret may have been revoked or replaced while it was read.
  if (held().get(name) !== secret) return undefined;
  secret.value = value;
  return value;
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

/** Whether a Secret by that name is held, even one not read yet. */
export function isSecretHeld(name: string): boolean {
  const secret = held().get(name);
  return secret !== undefined && current(secret);
}

/** Secret Names that currently resolve. */
export function heldSecretNames(): string[] {
  return [...held()].flatMap(([name, secret]) => (current(secret) ? [name] : []));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Values shorter than this are redacted only as written: their encoded forms are short enough to
 * occur by chance in unrelated output, such as a hash or another base64 blob.
 */
export const MIN_ENCODED_REDACTION_LENGTH = 8;

/**
 * The base64 characters that encode `bytes` whatever bytes surround them, for each of the three
 * alignments `bytes` can start at inside a longer encoded payload, such as `user:password` in an
 * HTTP Basic `Authorization` header. The characters that mix in neighbouring bytes are left out.
 */
function base64Cores(bytes: Buffer): string[] {
  return [0, 1, 2].map((offset) => {
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString("base64");
    const firstBit = offset * 8;
    const endBit = (offset + bytes.length) * 8;
    return encoded.slice(Math.ceil(firstBit / 6), Math.floor(endBit / 6));
  });
}

/**
 * The common encodings a program prints a value in: JSON string escaping, percent-encoding, hex,
 * and base64 and base64url at every alignment. Values shorter than
 * {@link MIN_ENCODED_REDACTION_LENGTH} get none.
 */
function encodedForms(value: string): string[] {
  if (value.length < MIN_ENCODED_REDACTION_LENGTH) return [];
  const bytes = Buffer.from(value, "utf8");
  const hex = bytes.toString("hex");
  const base64 = base64Cores(bytes);
  const forms = [
    JSON.stringify(value).slice(1, -1),
    encodeURIComponent(value),
    hex,
    hex.toUpperCase(),
    ...base64,
    ...base64.map((core) => core.replaceAll("+", "-").replaceAll("/", "_")),
  ];
  return forms.filter((form) => form !== value && form.length >= MIN_ENCODED_REDACTION_LENGTH);
}

interface RedactionPattern {
  /** How many values were redacted when the pattern was built; values are only ever added. */
  readonly size: number;
  readonly pattern: RegExp;
  /** The held value each matchable text stands for, whether written as is or encoded. */
  readonly sources: ReadonlyMap<string, string>;
}

let cachedPattern: RedactionPattern | undefined;

function redactionPattern(values: Map<string, string>): RedactionPattern | undefined {
  if (values.size === 0) return undefined;
  if (cachedPattern?.size !== values.size) {
    const sources = new Map<string, string>();
    for (const value of values.keys())
      for (const form of encodedForms(value)) if (!sources.has(form)) sources.set(form, value);
    // A value as written wins over another value's encoded form that happens to equal it.
    for (const value of values.keys()) sources.set(value, value);
    const alternatives = [...sources.keys()]
      .toSorted((a, b) => b.length - a.length)
      .map(escapeRegExp);
    cachedPattern = {
      size: values.size,
      pattern: new RegExp(alternatives.join("|"), "g"),
      sources,
    };
  }
  return cachedPattern;
}

function redactValue<T>(value: T, values: Map<string, string>, pattern: RedactionPattern): T {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: walks arbitrary JSON-like tool data; only strings carry text to redact.
  if (typeof value === "string") {
    // One pass, so a Secret Reference inserted for one value is never matched by another.
    // The name is looked up now, not when the pattern was built: a value held again under
    // another name keeps the map's size.
    const text = value.replace(pattern.pattern, (match) =>
      secretReference(values.get(pattern.sources.get(match) ?? "") ?? ""),
    );
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
 * `value` with every occurrence of any value held in this process, written as is or in one of its
 * common encodings (JSON string escaping, percent-encoding, hex, base64, base64url), replaced by
 * its Secret Reference, in strings nested in plain objects and arrays. Returns `value` itself when nothing
 * was redacted, and never modifies it.
 */
export function redactSecrets<T>(value: T): T {
  const values = redacted();
  const pattern = redactionPattern(values);
  return pattern === undefined ? value : redactValue(value, values, pattern);
}
