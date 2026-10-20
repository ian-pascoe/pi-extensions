import type {
  AvailableEntry,
  LocatorDescription,
  ProviderListing,
  ProviderSearch,
  SaveRequest,
  SecretProvider,
} from "../../src/secret-provider.js";

/** A Secret Provider over an in-memory map, with `fake://vault/item/field` locators. */
export class FakeProvider implements SecretProvider {
  readonly id = "fake";
  readonly label = "Fake Vault";
  readonly scheme = "fake";
  /** Values by locator; a function is called at each read, like a one-time password. */
  readonly values = new Map<string, string | (() => string)>();
  /** Every locator read, in order. */
  readonly reads: string[] = [];
  readonly saved: SaveRequest[] = [];
  /** Set to make every read and search fail, as a locked Secret Provider does. */
  locked = false;

  constructor(values: Record<string, string | (() => string)> = {}) {
    for (const [locator, value] of Object.entries(values)) this.values.set(locator, value);
  }

  private where(locator: string): LocatorDescription {
    const [vault = "", item = "", field = ""] = locator.replace("fake://", "").split("/");
    return { locator, vault, item, field, fieldType: "concealed" };
  }

  async describe(locator: string): Promise<LocatorDescription> {
    if (!this.values.has(locator)) throw new Error(`no field at ${locator}`);
    return this.where(locator);
  }

  async describeSave(request: Omit<SaveRequest, "value">): Promise<LocatorDescription> {
    if (this.values.has(request.locator)) throw new Error("that item already exists");
    return this.where(request.locator);
  }

  async read(locator: string): Promise<string> {
    this.reads.push(locator);
    if (this.locked) throw new Error("Fake Vault is locked");
    const value = this.values.get(locator);
    if (value === undefined) throw new Error(`no field at ${locator}`);
    return value instanceof Function ? value() : value;
  }

  async search(search: ProviderSearch): Promise<ProviderListing> {
    if (this.locked) throw new Error("Fake Vault is locked");
    const entries: AvailableEntry[] = [...this.values.keys()]
      .filter((locator) => search.query === undefined || locator.includes(search.query))
      .map((locator) => {
        const { vault, item, field } = this.where(locator);
        return search.item === undefined
          ? { kind: "item", provider: this.id, id: item, title: item, vault, category: "password" }
          : {
              kind: "field",
              provider: this.id,
              item,
              vault,
              label: field,
              type: "concealed",
              locator,
            };
      });
    return { entries: entries.slice(0, search.limit), truncated: entries.length > search.limit };
  }

  async save(request: SaveRequest): Promise<string> {
    this.saved.push(request);
    const locator = `fake://Dev/item-${this.saved.length}/credential`;
    this.values.set(locator, request.value);
    return locator;
  }
}
