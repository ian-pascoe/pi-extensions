/**
 * The internal seam between Pi Secret and the Secret Providers it reads Secret Grants from and
 * saves typed Secrets into. Each Secret Provider owns one Secret Locator scheme, such as `op` for
 * 1Password References. Providers never return a value except from {@link SecretProvider.read}.
 */

import type { Static } from "typebox";
import type { AvailableEntrySchema } from "./secret-outputs.js";

/** Where a Secret Locator points, as the user sees it when approving a grant or a save. */
export interface LocatorDescription {
  /** The Secret Locator, in the form a grant records it, such as with `~` expanded. */
  readonly locator: string;
  readonly vault: string;
  readonly item: string;
  readonly field: string;
  /** The field's type, such as `concealed` or `text`, when known. */
  readonly fieldType?: string;
  /** The account the provider reads from, when it names one. */
  readonly account?: string;
  /** A risk the user should see before approving, such as an Env File git does not ignore. */
  readonly warning?: string;
}

/** A Secret Provider search; every filter is optional and case-insensitive. */
export interface ProviderSearch {
  /** Matches item titles or field labels. */
  readonly query?: string;
  readonly vault?: string;
  /** List this item's fields instead of items. */
  readonly item?: string;
  readonly limit: number;
}

/**
 * One searchable entry: an item, or a field of one item with the locator to request it by. Its
 * schema is part of `secret_list`'s value.
 */
export type AvailableEntry = Readonly<Static<typeof AvailableEntrySchema>>;

/** What a search found, and whether more matched than `limit`. */
export interface ProviderListing {
  readonly entries: AvailableEntry[];
  readonly truncated: boolean;
}

/** A typed Secret to save into a new item or key. */
export interface SaveRequest {
  readonly locator: string;
  readonly value: string;
  readonly category?: string;
}

export interface SecretProvider {
  /** Stable id the agent filters by, such as `1password`. */
  readonly id: string;
  /** Display name, such as `1Password`. */
  readonly label: string;
  /** The Secret Locator scheme this provider owns, without `://`, such as `op`. */
  readonly scheme: string;
  /** A locator to read from, for tool descriptions, such as `the 1Password Reference op://…`. */
  readonly locatorExample: string;
  /** A locator to save to, for tool descriptions, with what it must not exist as yet. */
  readonly saveExample: string;
  /** Check that a locator points at an existing, permitted field, and say where it points. */
  describe(locator: string, signal?: AbortSignal): Promise<LocatorDescription>;
  /** Check that a save can create what the locator names, and say where it would go. */
  describeSave(
    request: Omit<SaveRequest, "value">,
    signal?: AbortSignal,
  ): Promise<LocatorDescription>;
  /** The current value at a locator. */
  read(locator: string, signal?: AbortSignal): Promise<string>;
  search(search: ProviderSearch, signal?: AbortSignal): Promise<ProviderListing>;
  /** Save the value somewhere new, and return the locator to read it from. */
  save(request: SaveRequest, signal?: AbortSignal): Promise<string>;
}

/** The provider that owns a locator's scheme, if any. */
export function providerFor(
  providers: readonly SecretProvider[],
  locator: string,
): SecretProvider | undefined {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(locator)?.[1]?.toLowerCase();
  return providers.find((provider) => provider.scheme === scheme);
}
