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

/** One Eligible Model, named `provider/id`, with Pi's display name when known. */
export interface SubagentModel {
  model: string;
  displayName?: string;
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

/** Subagent Model Catalogue: the Eligible Models and Model Roles a reference can name. */
export interface SubagentModelCatalogue {
  models: readonly SubagentModel[];
  roles: readonly SubagentModelRole[];
  /** Each name that converts, mapped to what it points at. */
  targets: ReadonlyMap<string, SubagentModelTarget>;
}

type SubagentModelTarget = { kind: "model"; model: string } | { kind: "role"; role: string };

/**
 * A model a link can carry verbatim: no escaping in its destination or title, and an ending the
 * Prose Span grammar treats as the end of the token.
 */
const SAFE_MODEL = new RegExp(`^${NAME_CHARACTER}*[A-Za-z0-9]$`, "u");
/** A role name that can also be typed: it starts and ends with a letter or digit. */
const TYPEABLE_ROLE = new RegExp(`^[A-Za-z0-9](?:${NAME_CHARACTER}*[A-Za-z0-9])?$`, "u");

/** The id of a `provider/id` model without its provider; the id itself may contain `/`. */
const bareId = (model: string): string => model.slice(model.indexOf("/") + 1);

export function buildSubagentModelCatalogue(input: {
  eligibleModelIds: readonly string[];
  models: readonly { provider: string; id: string; name?: string }[];
  modelRoles: readonly SubagentModelRole[];
}): SubagentModelCatalogue {
  const displayNames = new Map<string, string>(
    input.models.flatMap(({ provider, id, name }) =>
      name === undefined ? [] : [[`${provider}/${id}`, name] as const],
    ),
  );
  const models = input.eligibleModelIds
    .filter((model) => SAFE_MODEL.test(model))
    .map((model): SubagentModel => {
      const displayName = displayNames.get(model);
      return displayName === undefined ? { model } : { model, displayName };
    });
  // Precedence: a full `provider/id`, then a Model Role, then a bare id one Eligible Model has.
  const targets = new Map<string, SubagentModelTarget>(
    models.map(({ model }) => [model, { kind: "model", model }]),
  );
  const roles = input.modelRoles.filter(
    (role) => TYPEABLE_ROLE.test(role.name) && !targets.has(role.name),
  );
  for (const role of roles) targets.set(role.name, { kind: "role", role: role.name });
  // Count every Eligible Model, including left-out ones, so a shared bare id stays ambiguous.
  const bareIds = new Map<string, string[]>();
  for (const model of input.eligibleModelIds) {
    bareIds.set(bareId(model), [...(bareIds.get(bareId(model)) ?? []), model]);
  }
  for (const [id, [model, ...others]] of bareIds) {
    if (model === undefined || others.length > 0 || targets.has(id) || !SAFE_MODEL.test(model)) {
      continue;
    }
    targets.set(id, { kind: "model", model });
  }
  return { models, roles, targets };
}

/**
 * Completion items for `query`: Model Roles by name, then Eligible Models by `provider/id` or
 * display name, case-insensitively. Within each group, names that start with the query come
 * first, then alphabetical order. Models insert their full `provider/id`.
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
  return [
    ...ranked(
      catalogue.roles,
      (role) => role.name,
      (role) => [role.name],
    ).map((role) =>
      item(
        role.name,
        [
          "Subagent role",
          role.thinkingLevel === undefined ? role.model : `${role.model}:${role.thinkingLevel}`,
          ...(role.hint === undefined ? [] : [role.hint]),
        ].join(" \u00b7 "),
      ),
    ),
    ...ranked(
      catalogue.models,
      ({ model }) => model,
      ({ model, displayName }) => [model, bareId(model), ...(displayName ? [displayName] : [])],
    ).map(({ model, displayName }) =>
      item(
        model,
        displayName === undefined ? "Subagent model" : `Subagent model \u00b7 ${displayName}`,
      ),
    ),
  ];
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
 * Converts `%name` shorthand for a catalogue entry into a link that names the `subagent` argument,
 * inside Prose Spans. Unknown names, code, links, and names followed by `:text` stay literal.
 */
export function transformSubagentModelReferences(
  text: string,
  catalogue: SubagentModelCatalogue,
): string {
  const names = [...catalogue.targets.keys()]
    .sort((left, right) => right.length - left.length)
    .map(escapeRegex);
  if (names.length === 0) return text;
  return replaceProseReferences(text, {
    sigil: SUBAGENT_MODEL_SIGIL,
    // `%large:high`, `%large@x`, and `%large~x` name something longer, so they stay literal.
    name: `(?:${names.join("|")})(?![:@~]\\S)`,
    resolve: (typed) => {
      const target = catalogue.targets.get(typed);
      if (target === undefined) return undefined;
      const label = `${SUBAGENT_MODEL_SIGIL}${typed}`;
      return target.kind === "model"
        ? `[${label}](model://${target.model} "Subagent model: model=${target.model}")`
        : `[${label}](model-role://${target.role} "Subagent model role: role=${target.role}")`;
    },
  });
}
