import type { JsonValue } from "@earendil-works/pi-ai";
import type { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TObject } from "typebox";
import { Value } from "typebox/value";

/** Native layer an authored option is written to or replayed from. */
export type LayeredSettingScope = "session" | "global" | "project";
/** Native layer supplying an effective option. */
export type LayeredSettingSource = "default" | LayeredSettingScope;
/** Authored scopes cached at startup/reload; a failed scope keeps its error until corrected. */
export interface LayeredSettingsLayers<Options> {
  global: Options | Error;
  project: Options | Error;
}
/** A validated authored mutation, independent of its persistence scope. */
export type LayeredSettingChange<Options> =
  | { action: "set"; key: keyof Options; patch: Options }
  | { action: "inherit"; key: keyof Options };

/**
 * Merges one layer's value for a key into the value accumulated from lower layers, instead of
 * replacing it. Called once per layer that authored the key, lowest precedence first.
 */
export type LayeredSettingMerge<Options, Config, Key extends keyof Options & keyof Config> = (
  current: Config[Key],
  next: Exclude<Options[Key], undefined>,
  source: LayeredSettingScope,
) => Config[Key];
/** Per-key merge hooks; keys without one are replaced by the highest-precedence layer. */
export type LayeredSettingMerges<Options, Config> = {
  [Key in keyof Options & keyof Config]?: LayeredSettingMerge<Options, Config, Key>;
};

/** Input for {@link resolveLayeredOptions}. */
export interface ResolveLayeredOptionsInput<Options, Config> {
  defaults: Config;
  /** Keys resolved, in order: each key is merged across every layer before the next key. */
  optionKeys: readonly (keyof Options & keyof Config)[];
  /** Layers lowest precedence first. */
  layers: readonly (readonly [LayeredSettingScope, Options])[];
  merge?: LayeredSettingMerges<Options, Config> | undefined;
}
/** Effective settings and the source that supplied each key. */
export interface ResolvedLayeredSettings<Config> {
  settings: Config;
  sources: Record<string, LayeredSettingSource>;
}

/**
 * Resolve effective settings: defaults, then each layer in order. A key a layer authors replaces
 * the lower value, or is passed to that key's merge hook. A key authored as `undefined` inherits
 * like an absent one. Also reports which source supplied each key. Pure: validation and trust gating belong to whoever built the layers.
 */
export function resolveLayeredOptions<Options extends object, Config extends object>(
  input: ResolveLayeredOptionsInput<Options, Config>,
): ResolvedLayeredSettings<Config> {
  const settings = structuredClone(input.defaults);
  const sources: Record<string, LayeredSettingSource> = {};
  const apply = <Key extends keyof Options & keyof Config>(
    key: Key,
    layer: Options,
    source: LayeredSettingScope,
  ) => {
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the fold below checked that the layer authored this key with a value other than `undefined`, which TypeBox accepts for optional properties and in-process session overrides keep.
    const next = layer[key] as Exclude<Options[Key], undefined>;
    const hook = input.merge?.[key];
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: without a hook the authored value replaces the default, so its type matches `Config[Key]` by the caller's contract; `defineLayeredSettings` enforces that contract at the type level.
    settings[key] = hook ? hook(settings[key], next, source) : (next as Config[Key]);
  };
  for (const key of input.optionKeys) {
    sources[String(key)] = "default";
    for (const [source, layer] of input.layers) {
      // An explicit `undefined` inherits, as an absent key does; merge hooks never receive it.
      if (!Object.hasOwn(layer, key) || layer[key] === undefined) continue;
      apply(key, layer, source);
      sources[String(key)] = source;
    }
  }
  return { settings, sources };
}

/** A JSON object as stored in Pi's settings documents. */
export type SettingsJsonObject = Record<string, JsonValue>;

function isJsonObject(value: JsonValue | undefined): value is SettingsJsonObject {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON.parse already established JSON data; distinguish object roots and namespaces from primitives and arrays.
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Why {@link rewriteNamespaceDocument} refused a stored settings document. */
export type InvalidSettingsDocument = "malformed" | "root" | "namespace";

/** Input for {@link rewriteNamespaceDocument}. */
export interface RewriteNamespaceDocumentInput {
  /** Current file text, or `undefined` when the file is absent. */
  current: string | undefined;
  namespace: string;
  /** Receives a copy of the stored namespace options and returns its replacement. */
  update: (options: SettingsJsonObject) => SettingsJsonObject;
  /** Builds the error thrown instead of overwriting a document that cannot be safely rewritten. */
  invalid: (reason: InvalidSettingsDocument, cause: Error | undefined) => Error;
}

/**
 * Rewrite one namespace of a Pi settings document, preserving every other setting. Strips a
 * leading BOM, refuses documents whose root or namespace is not an object, and removes an empty
 * namespace. Transport-independent: callers run it inside whichever lock and writer they use.
 * @returns The replacement file text.
 */
export function rewriteNamespaceDocument(input: RewriteNamespaceDocumentInput): string {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse((input.current ?? "{}").replace(/^\uFEFF/, ""));
  } catch (cause) {
    throw input.invalid("malformed", cause instanceof Error ? cause : undefined);
  }
  if (!isJsonObject(parsed)) throw input.invalid("root", undefined);
  const stored = parsed[input.namespace];
  if (stored !== undefined && !isJsonObject(stored)) throw input.invalid("namespace", undefined);
  const updated = input.update({ ...stored });
  if (Object.keys(updated).length === 0) delete parsed[input.namespace];
  else parsed[input.namespace] = updated;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

/**
 * Definition of one extension's layered settings namespace. `Options` is `Static<S>`; `Merge`
 * holds the per-key merge hooks and `Entry` the session entry type, both inferred.
 */
export interface LayeredSettingsDefinition<
  S extends TObject,
  Config extends object,
  Merge extends LayeredSettingMerges<Static<S>, Config> = {},
  Entry extends string | undefined = undefined,
> {
  /** Key under which authored options live in Pi's settings documents, e.g. `advisor`. */
  namespace: string;
  /** Name used in error messages, e.g. `Advisor`. */
  label: string;
  /** Schema of the authored options; every property must be optional so absent values inherit. */
  schema: S;
  defaults: Config;
  /** Custom session entry type holding `{ version: 1, overrides }`; omit for no session layer. */
  sessionEntryType?: Entry;
  /** Per-key merge hooks for keys that merge across layers instead of replacing. */
  merge?: Merge;
}

/**
 * Option keys the definition's `Config` cannot hold: a key `Config` lacks, or an unhooked key whose
 * authored value type is not assignable to its `Config` type.
 */
export type LayeredSettingsConfigMismatch<Options, Config, Hooked extends PropertyKey> = {
  [Key in keyof Options]-?: Key extends keyof Config
    ? Key extends Hooked
      ? never
      : [Exclude<Options[Key], undefined>] extends [Config[Key]]
        ? never
        : Key
    : Key;
}[keyof Options];
/** Adds a type error naming the mismatched keys; `unknown` (no constraint) when there are none. */
type LayeredSettingsConfigCheck<Options, Config, Hooked extends PropertyKey> = [
  LayeredSettingsConfigMismatch<Options, Config, Hooked>,
] extends [never]
  ? unknown
  : { configMismatch: LayeredSettingsConfigMismatch<Options, Config, Hooked> };

/** Settings operations for one namespace; `Options` is `Static<S>`. */
export interface LayeredSettings<S extends TObject, Config extends object> {
  /** Reject inherited or unknown property names before applying an authored change. */
  optionKey(input: string): keyof Static<S> & string;
  /** Schema property names, in schema order. */
  optionKeys: readonly (keyof Static<S> & string)[];
  /** Validate authored options read from, or about to be written to, a scope. */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: Native settings contain arbitrary authored JSON; the schema validates it before use.
  parseOptions(value: unknown, source: LayeredSettingScope): Static<S>;
  /** Read Pi's stored layers, preserving configuration failures until corrected. */
  readLayers(manager: SettingsManager): LayeredSettingsLayers<Static<S>>;
  /** Resolve stored scopes without changing Pi's effective runtime overrides. */
  readSettings(
    session: {
      settingsManager: SettingsManager;
      sessionManager: Pick<SessionManager, "getBranch">;
    },
    authored?: LayeredSettingsLayers<Static<S>>,
  ): ResolvedLayeredSettings<Config>;
  /** Use Pi's actual backend: its generic storage API is not exported. */
  writeSettings(
    manager: SettingsManager,
    scope: "global" | "project",
    change: LayeredSettingChange<Static<S>>,
    isCurrent: () => boolean,
  ): Promise<Static<S> | undefined>;
}
/** Layered settings with a session layer, so overrides can be replayed from a session branch. */
export interface SessionLayeredSettings<
  S extends TObject,
  Config extends object,
> extends LayeredSettings<S, Config> {
  /** Replay only the selected branch's last complete override snapshot. */
  readOverrides(manager: Pick<SessionManager, "getBranch">): Static<S>;
}

const optionalText = Type.Union([Type.String(), Type.Undefined()]);
const storageSchema = Type.Object({
  withLock: Type.Function(
    [
      Type.Union([Type.Literal("global"), Type.Literal("project")]),
      Type.Function([optionalText], optionalText),
    ],
    Type.Void(),
  ),
});

/** `SessionLayeredSettings` when `Entry` is a session entry type, else `LayeredSettings`. */
export type DefinedLayeredSettings<
  S extends TObject,
  Config extends object,
  Entry extends string | undefined,
> = [Entry] extends [string] ? SessionLayeredSettings<S, Config> : LayeredSettings<S, Config>;

/**
 * Define layered settings: authored options from Pi's global settings, trusted-project settings
 * and (optionally) session overrides, resolved over defaults with precedence
 * default < global < trusted project < session. The authored options are `Static<S>`; `Config`
 * must hold every option key, with a type the authored value is assignable to unless the key
 * has a merge hook. `readOverrides` exists only when `sessionEntryType` is given.
 */
export function defineLayeredSettings<
  S extends TObject,
  Config extends object,
  Merge extends LayeredSettingMerges<Static<S>, Config> = {},
  Entry extends string | undefined = undefined,
>(
  definition: LayeredSettingsDefinition<S, Config, Merge, Entry> &
    LayeredSettingsConfigCheck<Static<S>, Config, keyof Merge>,
): DefinedLayeredSettings<S, Config, Entry> {
  type Options = Static<S>;
  type OptionKey = keyof Options & keyof Config & string;
  type Layers = LayeredSettingsLayers<Options>;
  type Change = LayeredSettingChange<Options>;
  const { namespace, label, schema, defaults, sessionEntryType, merge } = definition;
  if (!Value.Check(schema, {}))
    throw new Error(`${label} settings schema must make every option optional`);
  const keySchema = Type.KeyOf(schema);
  const sessionSchema = Type.Object(
    { version: Type.Literal(1), overrides: schema },
    { additionalProperties: false },
  );

  function isOptionKey(input: string): input is OptionKey {
    return Value.Check(keySchema, input);
  }
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: Native settings contain arbitrary authored JSON; this guard validates it with the option schema before use.
  function isOptions(value: unknown): value is Options {
    return Value.Check(schema, value);
  }
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: Session entry data is arbitrary JSON; this guard validates the versioned envelope before replay.
  function isSessionData(value: unknown): value is { version: 1; overrides: Options } {
    return Value.Check(sessionSchema, value);
  }

  function optionKey(input: string): OptionKey {
    if (!isOptionKey(input)) throw new Error(`Unknown ${label} option: ${input}`);
    return input;
  }
  const optionKeys = Object.keys(schema.properties).map(optionKey);

  /** The options of a layer that authored nothing. */
  function noOptions(): Options {
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the schema accepts `{}` (asserted above), so the empty object is a valid `Options`.
    return {} as Options;
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: Native settings contain arbitrary authored JSON; the option schema validates it before use. SDK command tests exercise the boundary.
  function parseOptions(value: unknown, source: LayeredSettingScope): Options {
    if (value === undefined) return noOptions();
    if (!isOptions(value)) {
      const issue = Value.Errors(schema, value)[0];
      throw new Error(
        `Invalid ${source} ${label} settings${issue?.instancePath ?? ""}: ${issue?.message ?? "invalid options"}`,
      );
    }
    return structuredClone(value);
  }

  /** Replay only the selected branch's last complete override snapshot. */
  function readOverrides(manager: Pick<SessionManager, "getBranch">): Options {
    const entry = manager
      .getBranch()
      .findLast((item) => item.type === "custom" && item.customType === sessionEntryType);
    if (!entry || entry.type !== "custom") return noOptions();
    if (!isSessionData(entry.data)) throw new Error(`Invalid ${label} session settings`);
    return structuredClone(entry.data.overrides);
  }

  /** Read Pi's stored layers, preserving configuration failures until corrected. */
  function readLayers(manager: SettingsManager): Layers {
    const layers: Layers = { global: noOptions(), project: noOptions() };
    for (const scope of ["global", "project"] as const) {
      try {
        if (scope === "project" && !manager.isProjectTrusted()) continue;
        const document =
          scope === "global" ? manager.getGlobalSettings() : manager.getProjectSettings();
        layers[scope] = parseOptions(
          namespace in document
            ? Object.getOwnPropertyDescriptor(document, namespace)?.value
            : undefined,
          scope,
        );
      } catch (cause) {
        layers[scope] = cause instanceof Error ? cause : new Error(String(cause));
      }
    }
    return layers;
  }

  /** Resolve stored scopes without changing Pi's effective runtime overrides. */
  function readSettings(
    session: {
      settingsManager: SettingsManager;
      sessionManager: Pick<SessionManager, "getBranch">;
    },
    authored = readLayers(session.settingsManager),
  ) {
    if (authored.global instanceof Error) throw authored.global;
    const trusted = session.settingsManager.isProjectTrusted();
    if (trusted && authored.project instanceof Error) throw authored.project;
    const layers: (readonly [LayeredSettingScope, Options])[] = [
      ["global", authored.global],
      ["project", trusted && !(authored.project instanceof Error) ? authored.project : noOptions()],
    ];
    if (sessionEntryType !== undefined)
      layers.push(["session", readOverrides(session.sessionManager)]);
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: `OptionKey` is `keyof Options & keyof Config`, which the definition's config check guarantees for every option key.
    const keys = optionKeys as readonly OptionKey[];
    return resolveLayeredOptions<Options, Config>({ defaults, optionKeys: keys, layers, merge });
  }

  /** Use Pi's actual backend: its generic storage API is not exported. */
  async function writeSettings(
    manager: SettingsManager,
    scope: "global" | "project",
    change: Change,
    isCurrent: () => boolean,
  ): Promise<Options | undefined> {
    const untrusted = () => new Error(`${label} project settings require a trusted project`);
    if (scope === "project" && !manager.isProjectTrusted()) throw untrusted();
    const candidate: unknown = Object.getOwnPropertyDescriptor(manager, "storage")?.value;
    if (!Value.Check(storageSchema, candidate)) {
      throw new Error(
        `Unsupported Pi settings backend: ${label} cannot safely write scoped settings`,
      );
    }
    const storage: Parameters<typeof SettingsManager.fromStorage>[0] = candidate;
    await manager.flush();
    if (!isCurrent()) return undefined;
    if (scope === "project" && !manager.isProjectTrusted()) throw untrusted();
    let updated: Options | undefined;
    storage.withLock(scope, (current) =>
      rewriteNamespaceDocument({
        current,
        namespace,
        invalid: (reason, cause) =>
          reason === "malformed" && cause
            ? cause
            : new Error(`Invalid ${scope} settings document; refusing to overwrite it`),
        update: (stored) => {
          const next = { ...stored };
          if (change.action === "inherit") Reflect.deleteProperty(next, change.key);
          else Object.assign(next, change.patch);
          updated = parseOptions(next, scope);
          return next;
        },
      }),
    );
    return updated;
  }

  const settings: LayeredSettings<S, Config> = {
    optionKey,
    optionKeys,
    parseOptions,
    readLayers,
    readSettings,
    writeSettings,
  };
  // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the conditional return type selects the session variant exactly when `sessionEntryType` is a string, which is when `readOverrides` is added.
  return (
    sessionEntryType === undefined ? settings : { ...settings, readOverrides }
  ) as DefinedLayeredSettings<S, Config, Entry>;
}
