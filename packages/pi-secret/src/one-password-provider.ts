import { spawn } from "node:child_process";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type {
  AvailableEntry,
  LocatorDescription,
  ProviderListing,
  ProviderSearch,
  SaveRequest,
  SecretProvider,
} from "./secret-provider.js";

/** The `secret.providers.1password` settings. */
export interface OnePasswordSettings {
  /** The account `op` signs in to; `op`'s default when unset. */
  account?: string;
  /** Vault names or IDs the agent may search, request, and save into; every vault when unset, none when empty. */
  vaults?: string[];
}

/** Runs `op` with arguments, piping `input` to stdin when given, and resolves its stdout. */
export type OpRunner = (
  args: readonly string[],
  options: { input?: string | undefined; signal?: AbortSignal | undefined },
) => Promise<string>;

const OP_TIMEOUT_MS = 60_000;

/** `[ERROR] 2026/10/20 06:26:28 account is not signed in` → `account is not signed in`. */
function opErrorText(stderr: string): string {
  const text = stderr
    .trim()
    .replace(/^\[ERROR\]\s+\S+\s+\S+\s+/, "")
    .trim();
  return text === "" ? "op failed without a message" : text;
}

/** Run the `op` CLI without a shell, so no argument is interpreted. */
export const runOp: OpRunner = (args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn("op", [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      signal: options.signal,
      timeout: OP_TIMEOUT_MS,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (cause) =>
      reject(
        "code" in cause && cause.code === "ENOENT"
          ? new Error("the 1Password CLI (op) is not installed or not on PATH")
          : cause,
      ),
    );
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else reject(new Error(opErrorText(Buffer.concat(stderr).toString("utf8"))));
    });
    child.stdin.end(options.input ?? "");
  });

const VaultSchema = Type.Object({ id: Type.String(), name: Type.Optional(Type.String()) });
const ItemSummarySchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  category: Type.Optional(Type.String()),
  vault: VaultSchema,
});
const ItemListSchema = Type.Array(ItemSummarySchema);
const FieldSchema = Type.Object({
  id: Type.String(),
  label: Type.Optional(Type.String()),
  type: Type.Optional(Type.String()),
  reference: Type.Optional(Type.String()),
  section: Type.Optional(
    Type.Object({ id: Type.Optional(Type.String()), label: Type.Optional(Type.String()) }),
  ),
});
const ItemSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  category: Type.Optional(Type.String()),
  vault: VaultSchema,
  fields: Type.Optional(Type.Array(FieldSchema)),
});
type Vault = Static<typeof VaultSchema>;
type Field = Static<typeof FieldSchema>;

function parseJson<T extends TSchema>(schema: T, text: string, what: string): Static<T> {
  const parsed: unknown = JSON.parse(text);
  if (!Value.Check(schema, parsed)) throw new Error(`op returned an unexpected ${what}`);
  return parsed;
}

/** The parts of a 1Password Reference: `op://vault/item/[section/]field[?query]`. */
interface ParsedReference {
  readonly vault: string;
  readonly item: string;
  readonly section: string | undefined;
  readonly field: string;
  readonly attribute: string | undefined;
}

const SCHEME = "op://";

function parseReference(locator: string): ParsedReference {
  if (!locator.startsWith(SCHEME))
    throw new Error(
      `${JSON.stringify(locator)} is not a 1Password Reference (op://vault/item/field)`,
    );
  const [path = "", query = ""] = locator.slice(SCHEME.length).split("?", 2);
  const parts = path.split("/");
  if (parts.length < 3 || parts.length > 4 || parts.some((part) => part.trim() === ""))
    throw new Error(
      `${JSON.stringify(locator)} is not a 1Password Reference: use op://vault/item/field or op://vault/item/section/field`,
    );
  const [vault = "", item = "", ...rest] = parts;
  const field = rest.at(-1) ?? "";
  const section = rest.length === 2 ? rest[0] : undefined;
  const attribute = new URLSearchParams(query).get("attribute") ?? undefined;
  return { vault, item, section, field, attribute };
}

/** Whether two 1Password names or IDs are equal; 1Password matches them case-insensitively. */
const sameName = (a: string | undefined, b: string | undefined) =>
  a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();

/** A vault as the user knows it: its name, or its ID when op omits the name. */
const vaultLabel = (vault: Vault): string => vault.name ?? vault.id;

/** One field of an item JSON template, as `op item create` reads it on stdin. */
interface TemplateField {
  id: string;
  label: string;
  type: "CONCEALED";
  value: string;
  purpose?: string;
}

/** Built-in fields a template sets by purpose rather than as custom fields. */
const FIELD_PURPOSES = new Map([
  ["username", "USERNAME"],
  ["password", "PASSWORD"],
  ["notesplain", "NOTES"],
]);

/** A field's 1Password Reference; a one-time password field reads its current code. */
function fieldLocator(field: Field): string | undefined {
  if (field.reference === undefined) return undefined;
  return sameName(field.type, "OTP") && !field.reference.includes("?")
    ? `${field.reference}?attribute=otp`
    : field.reference;
}

/** `API Credential`, `api credential`, or `API_CREDENTIAL` → `API_CREDENTIAL`. */
function categoryId(category: string | undefined): string {
  return (category ?? "API Credential")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
}

/** The 1Password Secret Provider, through the user's signed-in `op` CLI. */
export class OnePasswordProvider implements SecretProvider {
  readonly id = "1password";
  readonly label = "1Password";
  readonly scheme = "op";

  constructor(
    private readonly settings: () => OnePasswordSettings,
    private readonly run: OpRunner = runOp,
  ) {}

  private op(
    args: string[],
    options: { input?: string | undefined; signal?: AbortSignal | undefined } = {},
  ) {
    const account = this.settings().account;
    // A global flag, before the subcommand: after `--`, op would read it as an argument.
    return this.run(account === undefined ? args : ["--account", account, ...args], options);
  }

  private allowed(vault: Vault): boolean {
    const vaults = this.settings().vaults;
    return (
      vaults === undefined ||
      vaults.some((entry) => sameName(entry, vault.id) || sameName(entry, vault.name))
    );
  }

  /** Vaults resolved by the name or ID a locator uses, so each is looked up once. */
  private readonly vaults = new Map<string, Vault>();

  private assertAllowed(vault: Vault): void {
    // The vault is not named: the agent may not learn which vaults exist outside the list.
    if (!this.allowed(vault))
      throw new Error("that item is not in a vault listed in secret.providers.1password.vaults");
  }

  /** Refuse a locator's vault unless it is allowed; free when every vault is. */
  private async assertVaultAllowed(vault: string, signal?: AbortSignal): Promise<void> {
    if (this.settings().vaults === undefined) return;
    let resolved = this.vaults.get(vault);
    if (resolved === undefined) {
      resolved = parseJson(
        VaultSchema,
        await this.op(["vault", "get", "--format", "json", "--", vault], { signal }),
        "vault",
      );
      this.vaults.set(vault, resolved);
    }
    this.assertAllowed(resolved);
  }

  private async item(vault: string, item: string, signal?: AbortSignal) {
    const text = await this.op(["item", "get", "--vault", vault, "--format", "json", "--", item], {
      signal,
    });
    const parsed = parseJson(ItemSchema, text, "item");
    this.assertAllowed(parsed.vault);
    return parsed;
  }

  async describe(locator: string, signal?: AbortSignal): Promise<LocatorDescription> {
    const reference = parseReference(locator);
    const item = await this.item(reference.vault, reference.item, signal);
    const field = (item.fields ?? []).find(
      (candidate: Field) =>
        (sameName(candidate.label, reference.field) || sameName(candidate.id, reference.field)) &&
        (reference.section === undefined ||
          sameName(candidate.section?.label, reference.section) ||
          sameName(candidate.section?.id, reference.section)),
    );
    if (field === undefined)
      throw new Error(
        `item ${JSON.stringify(item.title)} has no field ${JSON.stringify(reference.field)}`,
      );
    const description: LocatorDescription = {
      locator,
      vault: vaultLabel(item.vault),
      item: item.title,
      field: field.label ?? field.id,
      fieldType: (reference.attribute ?? field.type ?? "unknown").toLowerCase(),
    };
    const account = this.settings().account;
    return account === undefined ? description : { ...description, account };
  }

  async describeSave(
    request: Omit<SaveRequest, "value">,
    signal?: AbortSignal,
  ): Promise<LocatorDescription> {
    const reference = parseReference(request.locator);
    if (reference.section !== undefined || reference.attribute !== undefined)
      throw new Error("save to op://vault/item/field, without a section or query");
    const vault = parseJson(
      VaultSchema,
      await this.op(["vault", "get", "--format", "json", "--", reference.vault], { signal }),
      "vault",
    );
    this.assertAllowed(vault);
    const items = parseJson(
      ItemListSchema,
      await this.op(["item", "list", "--vault", vault.id, "--format", "json"], { signal }),
      "item list",
    );
    if (items.some((item) => sameName(item.title, reference.item)))
      throw new Error(
        `vault ${JSON.stringify(vaultLabel(vault))} already has an item titled ${JSON.stringify(reference.item)}; secret_save only creates new items`,
      );
    const description: LocatorDescription = {
      locator: request.locator,
      vault: vaultLabel(vault),
      item: reference.item,
      field: reference.field,
      fieldType: `concealed, new ${categoryId(request.category).toLowerCase().replaceAll("_", " ")} item`,
    };
    const account = this.settings().account;
    return account === undefined ? description : { ...description, account };
  }

  async read(locator: string, signal?: AbortSignal): Promise<string> {
    // Checked at every read, so narrowing the vaults also stops grants already held or restored.
    await this.assertVaultAllowed(parseReference(locator).vault, signal);
    const value = await this.op(["read", "--no-newline", "--", locator], { signal });
    if (value === "") throw new Error(`${locator} is empty`);
    return value;
  }

  async search(search: ProviderSearch, signal?: AbortSignal): Promise<ProviderListing> {
    const query = search.query?.toLowerCase();
    let entries: AvailableEntry[];
    if (search.item !== undefined) {
      const item = await this.findItem(search.item, search.vault, signal);
      // Values are dropped here: only labels, types, and references leave this method.
      entries = (item.fields ?? []).flatMap((field: Field): AvailableEntry[] => {
        const label = field.label ?? field.id;
        const locator = fieldLocator(field);
        if (locator === undefined) return [];
        if (query !== undefined && !label.toLowerCase().includes(query)) return [];
        return [
          {
            kind: "field",
            provider: this.id,
            item: item.title,
            vault: vaultLabel(item.vault),
            label,
            type: (field.type ?? "unknown").toLowerCase(),
            locator,
          },
        ];
      });
    } else {
      const args = ["item", "list", "--format", "json"];
      if (search.vault !== undefined) args.push("--vault", search.vault);
      const items = parseJson(ItemListSchema, await this.op(args, { signal }), "item list");
      entries = items
        .filter((item) => this.allowed(item.vault))
        .filter((item) => query === undefined || item.title.toLowerCase().includes(query))
        .map((item) => ({
          kind: "item",
          provider: this.id,
          id: item.id,
          title: item.title,
          vault: vaultLabel(item.vault),
          category: (item.category ?? "unknown").toLowerCase().replaceAll("_", " "),
        }));
    }
    return { entries: entries.slice(0, search.limit), truncated: entries.length > search.limit };
  }

  /**
   * One item by title or ID, looked up only in allowed vaults, so an item elsewhere is never
   * fetched and op's errors never name one.
   */
  private async findItem(item: string, vault: string | undefined, signal?: AbortSignal) {
    const vaults = vault === undefined ? this.settings().vaults : [vault];
    if (vaults === undefined) {
      const text = await this.op(["item", "get", "--format", "json", "--", item], { signal });
      return parseJson(ItemSchema, text, "item");
    }
    let lastError = new Error("no vault is listed in secret.providers.1password.vaults");
    for (const candidate of vaults) {
      try {
        return await this.item(candidate, item, signal);
      } catch (cause) {
        lastError = cause instanceof Error ? cause : new Error(String(cause));
      }
    }
    throw lastError;
  }

  async save(request: SaveRequest, signal?: AbortSignal): Promise<string> {
    await this.describeSave(request, signal);
    const reference = parseReference(request.locator);
    const purpose = FIELD_PURPOSES.get(reference.field.toLowerCase());
    const field: TemplateField = {
      id: reference.field,
      label: reference.field,
      type: "CONCEALED",
      value: request.value,
    };
    if (purpose !== undefined) field.purpose = purpose;
    const template = {
      title: reference.item,
      category: categoryId(request.category),
      fields: [field],
    };
    // The value reaches op on stdin, never on its command line, where other processes can see it.
    const created = parseJson(
      ItemSchema,
      await this.op(["item", "create", "--vault", reference.vault, "--format", "json", "-"], {
        input: JSON.stringify(template),
        signal,
      }),
      "created item",
    );
    return `${SCHEME}${created.vault.id}/${created.id}/${reference.field}`;
  }
}
