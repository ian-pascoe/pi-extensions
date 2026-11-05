import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
  replaceProseReferences,
  stackProseReferenceAutocomplete,
} from "@ian-pascoe/pi-utils/prose-references";

export const SUBAGENT_MODEL_SIGIL = "%";

/** Characters a model or role name may hold: none needs escaping in a link or its title. */
const NAME_CHARACTER = "[A-Za-z0-9._:/~@+-]";

/** Characters a partially typed model or role name may hold. */
export const SUBAGENT_MODEL_PARTIAL_NAME = `${NAME_CHARACTER}*`;

/**
 * One Eligible Model, named `provider/id`, with Pi's display name when known and the thinking
 * levels it supports, in Pi's order.
 */
export interface SubagentModel {
  model: string;
  displayName?: string;
  thinkingLevels: readonly string[];
}

/**
 * The fields of a configured Model Role a reference reads. Declared here rather than imported, so
 * the grammar stays independent of the settings and Registry modules.
 */
export interface SubagentModelRole {
  name: string;
  model: string;
  thinkingLevel?: string;
  hint?: string;
}

/** A model Pi knows, as the catalogue reads it. */
export interface SubagentModelInput {
  provider: string;
  id: string;
  name?: string;
  /** The thinking levels the model supports, in Pi's order; none when unknown. */
  thinkingLevels?: readonly string[];
}

/** Subagent Model Catalogue: the Eligible Models and Model Roles a reference can name. */
export interface SubagentModelCatalogue {
  models: readonly SubagentModel[];
  roles: readonly SubagentModelRole[];
  /** Each name that converts, mapped to what it points at. */
  targets: ReadonlyMap<string, SubagentModelTarget>;
  /**
   * Every name an Eligible Model or Model Role goes by, including ambiguous and left-out ones, so
   * no such name is read as a shorter name plus a `:level`.
   */
  names: ReadonlySet<string>;
}

/** What a name points at, with the thinking levels a `:level` suffix may name. */
type SubagentModelTarget = ({ kind: "model"; model: string } | { kind: "role"; role: string }) & {
  thinkingLevels: readonly string[];
};

/**
 * A model a link can carry verbatim: no escaping in its destination or title, and an ending the
 * Prose Span grammar treats as the end of the token.
 */
const SAFE_MODEL = new RegExp(`^${NAME_CHARACTER}*[A-Za-z0-9]$`, "u");
/** A role name that can also be typed: it starts and ends with a letter or digit. */
const TYPEABLE_ROLE = new RegExp(`^[A-Za-z0-9](?:${NAME_CHARACTER}*[A-Za-z0-9])?$`, "u");

/** The id of a `provider/id` model without its provider; the id itself may contain `/`. */
const bareId = (model: string): string => model.slice(model.indexOf("/") + 1);

/** The name before a final `:level` and the level, or undefined without a colon. */
function splitLevel(typed: string): { base: string; level: string } | undefined {
  const colon = typed.lastIndexOf(":");
  return colon < 0 ? undefined : { base: typed.slice(0, colon), level: typed.slice(colon + 1) };
}

export function buildSubagentModelCatalogue(input: {
  eligibleModelIds: readonly string[];
  models: readonly SubagentModelInput[];
  modelRoles: readonly SubagentModelRole[];
}): SubagentModelCatalogue {
  const known = new Map(input.models.map((model) => [`${model.provider}/${model.id}`, model]));
  const models = input.eligibleModelIds
    .filter((model) => SAFE_MODEL.test(model))
    .map((model): SubagentModel => {
      const { name: displayName, thinkingLevels = [] } = known.get(model) ?? {};
      return displayName === undefined
        ? { model, thinkingLevels }
        : { model, displayName, thinkingLevels };
    });
  const levelsOf = (model: string) => known.get(model)?.thinkingLevels ?? [];
  // Precedence: a full `provider/id`, then a Model Role, then a bare id one Eligible Model has.
  const targets = new Map<string, SubagentModelTarget>(
    models.map(({ model, thinkingLevels }) => [model, { kind: "model", model, thinkingLevels }]),
  );
  const roles = input.modelRoles.filter(
    (role) => TYPEABLE_ROLE.test(role.name) && !targets.has(role.name),
  );
  for (const role of roles) {
    targets.set(role.name, { kind: "role", role: role.name, thinkingLevels: levelsOf(role.model) });
  }
  // Count every Eligible Model, including left-out ones, so a shared bare id stays ambiguous.
  const bareIds = new Map<string, string[]>();
  for (const model of input.eligibleModelIds) {
    bareIds.set(bareId(model), [...(bareIds.get(bareId(model)) ?? []), model]);
  }
  for (const [id, [model, ...others]] of bareIds) {
    if (model === undefined || others.length > 0 || targets.has(id) || !SAFE_MODEL.test(model)) {
      continue;
    }
    targets.set(id, { kind: "model", model, thinkingLevels: levelsOf(model) });
  }
  const names = new Set([
    ...input.eligibleModelIds.flatMap((model) => [model, bareId(model)]),
    ...input.modelRoles.map((role) => role.name),
  ]);
  return { models, roles, targets, names };
}

/**
 * Completion items for `query`: after `name:`, the thinking levels `name` supports; then Model
 * Roles by name, then Eligible Models by `provider/id` or display name, case-insensitively. Within
 * each group, names that start with the query come first, then alphabetical order. Models insert
 * their full `provider/id`, and each entry's description lists its thinking levels.
 */
export function suggestSubagentModelReferences(
  catalogue: SubagentModelCatalogue,
  query: string,
): AutocompleteItem[] {
  const wanted = query.toLowerCase();
  const rank = (fields: readonly string[]): number | undefined => {
    const lowered = fields.map((field) => field.toLowerCase());
    if (lowered.some((field) => field.startsWith(wanted))) return 0;
    return lowered.some((field) => field.includes(wanted)) ? 1 : undefined;
  };
  const ranked = <Entry>(
    entries: readonly Entry[],
    key: (entry: Entry) => string,
    fields: (entry: Entry) => string[],
  ): Entry[] =>
    entries
      .flatMap((entry) => {
        const order = rank(fields(entry));
        return order === undefined ? [] : [{ entry, order }];
      })
      .sort(
        (left, right) =>
          left.order - right.order || key(left.entry).localeCompare(key(right.entry), "en"),
      )
      .map(({ entry }) => entry);
  const item = (name: string, description: string): AutocompleteItem => {
    const value = `${SUBAGENT_MODEL_SIGIL}${name}`;
    return { value, label: value, description };
  };
  const describeLevels = (name: string): string[] => {
    const levels = catalogue.targets.get(name)?.thinkingLevels ?? [];
    return levels.length === 0 ? [] : [levels.join("/")];
  };
  const displayNames = new Map(
    catalogue.models.flatMap(({ model, displayName }) =>
      displayName === undefined ? [] : [[model, displayName] as const],
    ),
  );
  const describeModel = (model: string, levels: readonly string[] = []): string => {
    const displayName = displayNames.get(model);
    return ["Subagent model", ...(displayName === undefined ? [] : [displayName]), ...levels].join(
      " \u00b7 ",
    );
  };
  // A role reads `provider/model:thinking`, with the typed level in place of the role's own.
  const describeRole = (
    role: SubagentModelRole,
    thinkingLevel = role.thinkingLevel,
    levels: readonly string[] = [],
  ): string =>
    [
      "Subagent role",
      thinkingLevel === undefined ? role.model : `${role.model}:${thinkingLevel}`,
      ...levels,
      ...(role.hint === undefined ? [] : [role.hint]),
    ].join(" \u00b7 ");
  const roles = new Map(catalogue.roles.map((role) => [role.name, role]));
  return [
    ...suggestThinkingLevels(catalogue, query).map(({ name, target, thinkingLevel }) => {
      const role = target.kind === "role" ? roles.get(target.role) : undefined;
      return item(
        name,
        role !== undefined
          ? describeRole(role, thinkingLevel)
          : describeModel(target.kind === "model" ? target.model : name),
      );
    }),
    ...ranked(
      catalogue.roles,
      (role) => role.name,
      (role) => [role.name],
    ).map((role) =>
      item(role.name, describeRole(role, role.thinkingLevel, describeLevels(role.name))),
    ),
    ...ranked(
      catalogue.models,
      ({ model }) => model,
      ({ model, displayName }) => [model, bareId(model), ...(displayName ? [displayName] : [])],
    ).map(({ model }) => item(model, describeModel(model, describeLevels(model)))),
  ];
}

/**
 * After `name:`, the thinking levels `name` supports that start with what follows the colon, in
 * Pi's order. A level is skipped when `name:level` is itself a model or role name, which never
 * reads as `name` with a level.
 */
function suggestThinkingLevels(
  catalogue: SubagentModelCatalogue,
  query: string,
): { name: string; target: SubagentModelTarget; thinkingLevel: string }[] {
  const split = splitLevel(query);
  const target = split === undefined ? undefined : catalogue.targets.get(split.base);
  if (split === undefined || target === undefined) return [];
  const wanted = split.level.toLowerCase();
  return target.thinkingLevels
    .filter((level) => level.startsWith(wanted) && !catalogue.names.has(`${split.base}:${level}`))
    .map((thinkingLevel) => ({ name: `${split.base}:${thinkingLevel}`, target, thinkingLevel }));
}

/**
 * Registers Subagent Model Reference conversion for user input and, in the terminal UI, the `%`
 * completion popup. `getCatalogue` is read on every use and returns undefined while references
 * are unavailable, which leaves input literal and hides the popup.
 */
export function registerSubagentModelReferences(
  pi: Pick<ExtensionAPI, "on">,
  getCatalogue: () => SubagentModelCatalogue | undefined,
): void {
  pi.on("session_start", (_event, context) => {
    if (context.mode !== "tui") return;
    context.ui.addAutocompleteProvider((current) =>
      stackProseReferenceAutocomplete(current, {
        sigil: SUBAGENT_MODEL_SIGIL,
        partialName: SUBAGENT_MODEL_PARTIAL_NAME,
        suggest: (query) => {
          const catalogue = getCatalogue();
          return catalogue === undefined ? [] : suggestSubagentModelReferences(catalogue, query);
        },
      }),
    );
  });

  pi.on("input", (event) => {
    const catalogue = getCatalogue();
    if (event.source === "extension" || catalogue === undefined) return { action: "continue" };
    const text = transformSubagentModelReferences(event.text, catalogue);
    if (text === event.text) return { action: "continue" };
    return event.images === undefined
      ? { action: "transform", text }
      : { action: "transform", text, images: event.images };
  });
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The catalogue entry and thinking level a typed name points at. The whole name is tried first,
 * against every model and role name, so an id that itself ends in `:text` keeps it, and stays
 * literal when ambiguous; otherwise a final `:level` must be one its model supports.
 */
function resolveTyped(
  catalogue: SubagentModelCatalogue,
  typed: string,
): { target: SubagentModelTarget; thinkingLevel?: string } | undefined {
  const exact = catalogue.targets.get(typed);
  if (exact !== undefined) return { target: exact };
  const split = catalogue.names.has(typed) ? undefined : splitLevel(typed);
  const target = split === undefined ? undefined : catalogue.targets.get(split.base);
  return split !== undefined && target?.thinkingLevels.includes(split.level)
    ? { target, thinkingLevel: split.level }
    : undefined;
}

/**
 * Converts `%name` and `%name:level` shorthand for a catalogue entry into a link that names the
 * `subagent` arguments, inside Prose Spans. Unknown names and levels, code, links, and names
 * followed by other `:text` stay literal.
 */
export function transformSubagentModelReferences(
  text: string,
  catalogue: SubagentModelCatalogue,
): string {
  const names = [...catalogue.targets.keys()]
    .sort((left, right) => right.length - left.length)
    .map(escapeRegex);
  if (names.length === 0) return text;
  const levels = [...new Set([...catalogue.targets.values()].flatMap((t) => t.thinkingLevels))]
    .sort((left, right) => right.length - left.length)
    .map(escapeRegex);
  const level = levels.length === 0 ? "" : `(?::(?:${levels.join("|")}))?`;
  return replaceProseReferences(text, {
    sigil: SUBAGENT_MODEL_SIGIL,
    // `%large:ultra`, `%large@x`, and `%large~x` name something longer, so they stay literal.
    name: `(?:${names.join("|")})${level}(?![:@~]\\S)`,
    resolve: (typed) => {
      const resolved = resolveTyped(catalogue, typed);
      if (resolved === undefined) return undefined;
      const { target, thinkingLevel } = resolved;
      const label = `${SUBAGENT_MODEL_SIGIL}${typed}`;
      const thinking = thinkingLevel === undefined ? "" : `, thinking_level=${thinkingLevel}`;
      return target.kind === "model"
        ? `[${label}](model://${target.model} "Subagent model: model=${target.model}${thinking}")`
        : `[${label}](model-role://${target.role} "Subagent model role: role=${target.role}${thinking}")`;
    },
  });
}
