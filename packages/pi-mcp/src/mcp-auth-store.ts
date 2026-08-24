// oxlint-disable anti-slop/no-conditional-empty-object-spread -- Exact optional properties require omitting absent credential fields from the persisted wire document.
// oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- This file owns the strict authentication JSON parser boundary; every accepted primitive and object field is refined here.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  forceReplaceLockedMcpJsonDocument,
  McpStoreError,
  type McpStoreJsonObject,
  type McpStoreJsonValue,
  type McpStoreResult,
  mutateLockedMcpJsonDocument,
} from "./mcp-settings-store.js";

const AUTH_DOCUMENT_VERSION = 1;
const AUTH_FILE_MODE = 0o600;
const SHA_256_HEX = /^[a-f0-9]{64}$/;

/** URL and OAuth client identity that jointly own one stored credential entry. */
export interface McpAuthBinding {
  readonly clientIdentity: string;
  readonly serverUrl: string;
}

/** OAuth tokens persisted exactly across refreshes and process restarts. */
export interface McpStoredOAuthTokens {
  readonly accessToken: string;
  readonly expiresAt?: number;
  readonly refreshToken?: string;
  readonly scope?: string;
  readonly tokenType: string;
}

/** OAuth client registration or configured client identity persisted for reuse. */
export interface McpStoredOAuthClientInformation {
  readonly clientId: string;
  readonly clientIdIssuedAt?: number;
  readonly clientSecret?: string;
  readonly clientSecretExpiresAt?: number;
  readonly metadataDocumentUrl?: string;
}

/** PKCE verifier and authorization state persisted between remote callback steps. */
export interface McpStoredOAuthAuthorizationState {
  readonly codeVerifier?: string;
  readonly state?: string;
}

/** OAuth discovery documents retained without interpreting RFC extension fields. */
export interface McpStoredOAuthDiscovery {
  readonly authorizationServerMetadata?: McpStoreJsonObject;
  readonly authorizationServerUrl?: string;
  readonly protectedResourceMetadata?: McpStoreJsonObject;
  readonly resourceMetadataUrl?: string;
}

/** Complete authentication data associated with one URL/client binding. */
export interface McpAuthEntry {
  readonly authorization?: McpStoredOAuthAuthorizationState;
  readonly clientInformation?: McpStoredOAuthClientInformation;
  readonly discovery?: McpStoredOAuthDiscovery;
  readonly tokens?: McpStoredOAuthTokens;
}

/** Top-level authentication fields changed under one locked read-modify-write. */
export interface McpAuthEntryPatch {
  readonly authorization?: McpStoredOAuthAuthorizationState | null;
  readonly clientInformation?: McpStoredOAuthClientInformation | null;
  readonly discovery?: McpStoredOAuthDiscovery | null;
  readonly tokens?: McpStoredOAuthTokens | null;
}

interface McpAuthStoredEntry extends McpAuthEntry {
  readonly clientIdentityHash: string;
  readonly serverUrlHash: string;
}

type MutableMcpAuthStoredEntry = {
  -readonly [Field in keyof McpAuthStoredEntry]?: McpAuthStoredEntry[Field];
} & Pick<McpAuthStoredEntry, "clientIdentityHash" | "serverUrlHash">;

interface McpAuthDocument {
  readonly entries: Readonly<Record<string, McpAuthStoredEntry>>;
  readonly version: 1;
}

function ok<Value>(value: Value): McpStoreResult<Value> {
  return { ok: true, value };
}

function err<Value>(error: McpStoreError): McpStoreResult<Value> {
  return { error, ok: false };
}

function isNodeErrorCode(cause: unknown, code: string): boolean {
  return cause instanceof Error && "code" in cause && cause.code === code;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseMcpAuthBinding(binding: McpAuthBinding):
  | {
      readonly clientIdentityHash: string;
      readonly key: string;
      readonly serverUrlHash: string;
    }
  | undefined {
  if (
    typeof binding !== "object" ||
    binding === null ||
    typeof binding.clientIdentity !== "string" ||
    binding.clientIdentity.length === 0 ||
    typeof binding.serverUrl !== "string"
  ) {
    return undefined;
  }
  let normalizedUrl: string;
  try {
    const url = new URL(binding.serverUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    normalizedUrl = url.href;
  } catch {
    return undefined;
  }
  const serverUrlHash = sha256(normalizedUrl);
  const clientIdentityHash = sha256(binding.clientIdentity);
  return {
    clientIdentityHash,
    key: sha256(`${serverUrlHash}\0${clientIdentityHash}`),
    serverUrlHash,
  };
}

function isJsonValue(value: unknown): value is McpStoreJsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value).every(isJsonValue);
}

function isJsonObject(value: unknown): value is McpStoreJsonObject {
  return isJsonValue(value) && value !== null && !Array.isArray(value);
}

function hasOnlyFields(value: McpStoreJsonObject, fields: readonly string[]): boolean {
  const allowed = new Set(fields);
  return Object.keys(value).every((field) => allowed.has(field));
}

function optionalString(value: McpStoreJsonValue | undefined): string | undefined | false {
  return value === undefined || typeof value === "string" ? value : false;
}

function optionalNumber(value: McpStoreJsonValue | undefined): number | undefined | false {
  return value === undefined || (typeof value === "number" && Number.isFinite(value))
    ? value
    : false;
}

function parseStoredTokens(value: McpStoreJsonValue | undefined): McpStoredOAuthTokens | undefined {
  if (
    !isJsonObject(value) ||
    !hasOnlyFields(value, ["accessToken", "expiresAt", "refreshToken", "scope", "tokenType"]) ||
    typeof value.accessToken !== "string" ||
    typeof value.tokenType !== "string"
  ) {
    return undefined;
  }
  const expiresAt = optionalNumber(value.expiresAt);
  const refreshToken = optionalString(value.refreshToken);
  const scope = optionalString(value.scope);
  if (expiresAt === false || refreshToken === false || scope === false) return undefined;
  return {
    accessToken: value.accessToken,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(scope === undefined ? {} : { scope }),
    tokenType: value.tokenType,
  };
}

function parseClientInformation(
  value: McpStoreJsonValue | undefined,
): McpStoredOAuthClientInformation | undefined {
  if (
    !isJsonObject(value) ||
    !hasOnlyFields(value, [
      "clientId",
      "clientIdIssuedAt",
      "clientSecret",
      "clientSecretExpiresAt",
      "metadataDocumentUrl",
    ]) ||
    typeof value.clientId !== "string"
  ) {
    return undefined;
  }
  const clientIdIssuedAt = optionalNumber(value.clientIdIssuedAt);
  const clientSecret = optionalString(value.clientSecret);
  const clientSecretExpiresAt = optionalNumber(value.clientSecretExpiresAt);
  const metadataDocumentUrl = optionalString(value.metadataDocumentUrl);
  if (
    clientIdIssuedAt === false ||
    clientSecret === false ||
    clientSecretExpiresAt === false ||
    metadataDocumentUrl === false
  ) {
    return undefined;
  }
  return {
    clientId: value.clientId,
    ...(clientIdIssuedAt === undefined ? {} : { clientIdIssuedAt }),
    ...(clientSecret === undefined ? {} : { clientSecret }),
    ...(clientSecretExpiresAt === undefined ? {} : { clientSecretExpiresAt }),
    ...(metadataDocumentUrl === undefined ? {} : { metadataDocumentUrl }),
  };
}

function parseAuthorizationState(
  value: McpStoreJsonValue | undefined,
): McpStoredOAuthAuthorizationState | undefined {
  if (!isJsonObject(value) || !hasOnlyFields(value, ["codeVerifier", "state"])) {
    return undefined;
  }
  const codeVerifier = optionalString(value.codeVerifier);
  const state = optionalString(value.state);
  if (codeVerifier === false || state === false) return undefined;
  return {
    ...(codeVerifier === undefined ? {} : { codeVerifier }),
    ...(state === undefined ? {} : { state }),
  };
}

function parseDiscovery(value: McpStoreJsonValue | undefined): McpStoredOAuthDiscovery | undefined {
  if (
    !isJsonObject(value) ||
    !hasOnlyFields(value, [
      "authorizationServerMetadata",
      "authorizationServerUrl",
      "protectedResourceMetadata",
      "resourceMetadataUrl",
    ])
  ) {
    return undefined;
  }
  const authorizationServerUrl = optionalString(value.authorizationServerUrl);
  const resourceMetadataUrl = optionalString(value.resourceMetadataUrl);
  if (authorizationServerUrl === false || resourceMetadataUrl === false) return undefined;
  const authorizationServerMetadata = value.authorizationServerMetadata;
  const protectedResourceMetadata = value.protectedResourceMetadata;
  if (
    (authorizationServerMetadata !== undefined && !isJsonObject(authorizationServerMetadata)) ||
    (protectedResourceMetadata !== undefined && !isJsonObject(protectedResourceMetadata))
  ) {
    return undefined;
  }
  return {
    ...(authorizationServerMetadata === undefined ? {} : { authorizationServerMetadata }),
    ...(authorizationServerUrl === undefined ? {} : { authorizationServerUrl }),
    ...(protectedResourceMetadata === undefined ? {} : { protectedResourceMetadata }),
    ...(resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl }),
  };
}

function parseStoredEntry(value: McpStoreJsonValue, key: string): McpAuthStoredEntry | undefined {
  if (
    !isJsonObject(value) ||
    !hasOnlyFields(value, [
      "authorization",
      "clientIdentityHash",
      "clientInformation",
      "discovery",
      "serverUrlHash",
      "tokens",
    ]) ||
    typeof value.clientIdentityHash !== "string" ||
    typeof value.serverUrlHash !== "string" ||
    !SHA_256_HEX.test(value.clientIdentityHash) ||
    !SHA_256_HEX.test(value.serverUrlHash) ||
    sha256(`${value.serverUrlHash}\0${value.clientIdentityHash}`) !== key
  ) {
    return undefined;
  }

  const tokens = value.tokens === undefined ? undefined : parseStoredTokens(value.tokens);
  const clientInformation =
    value.clientInformation === undefined
      ? undefined
      : parseClientInformation(value.clientInformation);
  const authorization =
    value.authorization === undefined ? undefined : parseAuthorizationState(value.authorization);
  const discovery = value.discovery === undefined ? undefined : parseDiscovery(value.discovery);
  if (
    (value.tokens !== undefined && tokens === undefined) ||
    (value.clientInformation !== undefined && clientInformation === undefined) ||
    (value.authorization !== undefined && authorization === undefined) ||
    (value.discovery !== undefined && discovery === undefined)
  ) {
    return undefined;
  }
  return {
    ...(authorization === undefined ? {} : { authorization }),
    clientIdentityHash: value.clientIdentityHash,
    ...(clientInformation === undefined ? {} : { clientInformation }),
    ...(discovery === undefined ? {} : { discovery }),
    serverUrlHash: value.serverUrlHash,
    ...(tokens === undefined ? {} : { tokens }),
  };
}

function parseAuthEntryPatch(value: McpAuthEntryPatch): McpAuthEntryPatch | undefined {
  if (
    !isJsonObject(value) ||
    !hasOnlyFields(value, ["authorization", "clientInformation", "discovery", "tokens"])
  ) {
    return undefined;
  }
  const authorization =
    value.authorization === null ? null : parseAuthorizationState(value.authorization);
  const clientInformation =
    value.clientInformation === null ? null : parseClientInformation(value.clientInformation);
  const discovery = value.discovery === null ? null : parseDiscovery(value.discovery);
  const tokens = value.tokens === null ? null : parseStoredTokens(value.tokens);
  if (
    (value.authorization !== undefined && authorization === undefined) ||
    (value.clientInformation !== undefined && clientInformation === undefined) ||
    (value.discovery !== undefined && discovery === undefined) ||
    (value.tokens !== undefined && tokens === undefined)
  ) {
    return undefined;
  }
  return {
    ...(authorization === undefined ? {} : { authorization }),
    ...(clientInformation === undefined ? {} : { clientInformation }),
    ...(discovery === undefined ? {} : { discovery }),
    ...(tokens === undefined ? {} : { tokens }),
  };
}

function parseAuthDocument(value: unknown): McpAuthDocument | undefined {
  if (
    !isJsonObject(value) ||
    !hasOnlyFields(value, ["entries", "version"]) ||
    value.version !== AUTH_DOCUMENT_VERSION ||
    !isJsonObject(value.entries)
  ) {
    return undefined;
  }
  const entries: Record<string, McpAuthStoredEntry> = {};
  for (const [key, entry] of Object.entries(value.entries)) {
    if (!SHA_256_HEX.test(key)) return undefined;
    const parsed = parseStoredEntry(entry, key);
    if (parsed === undefined) return undefined;
    entries[key] = parsed;
  }
  return { entries, version: AUTH_DOCUMENT_VERSION };
}

function storedTokensDocument(tokens: McpStoredOAuthTokens): McpStoreJsonObject {
  return {
    accessToken: tokens.accessToken,
    ...(tokens.expiresAt === undefined ? {} : { expiresAt: tokens.expiresAt }),
    ...(tokens.refreshToken === undefined ? {} : { refreshToken: tokens.refreshToken }),
    ...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
    tokenType: tokens.tokenType,
  };
}

function clientInformationDocument(client: McpStoredOAuthClientInformation): McpStoreJsonObject {
  return {
    clientId: client.clientId,
    ...(client.clientIdIssuedAt === undefined ? {} : { clientIdIssuedAt: client.clientIdIssuedAt }),
    ...(client.clientSecret === undefined ? {} : { clientSecret: client.clientSecret }),
    ...(client.clientSecretExpiresAt === undefined
      ? {}
      : { clientSecretExpiresAt: client.clientSecretExpiresAt }),
    ...(client.metadataDocumentUrl === undefined
      ? {}
      : { metadataDocumentUrl: client.metadataDocumentUrl }),
  };
}

function authorizationDocument(
  authorization: McpStoredOAuthAuthorizationState,
): McpStoreJsonObject {
  return {
    ...(authorization.codeVerifier === undefined
      ? {}
      : { codeVerifier: authorization.codeVerifier }),
    ...(authorization.state === undefined ? {} : { state: authorization.state }),
  };
}

function discoveryDocument(discovery: McpStoredOAuthDiscovery): McpStoreJsonObject {
  return {
    ...(discovery.authorizationServerMetadata === undefined
      ? {}
      : { authorizationServerMetadata: discovery.authorizationServerMetadata }),
    ...(discovery.authorizationServerUrl === undefined
      ? {}
      : { authorizationServerUrl: discovery.authorizationServerUrl }),
    ...(discovery.protectedResourceMetadata === undefined
      ? {}
      : { protectedResourceMetadata: discovery.protectedResourceMetadata }),
    ...(discovery.resourceMetadataUrl === undefined
      ? {}
      : { resourceMetadataUrl: discovery.resourceMetadataUrl }),
  };
}

function entryDocument(entry: McpAuthStoredEntry): McpStoreJsonObject {
  return {
    ...(entry.authorization === undefined
      ? {}
      : { authorization: authorizationDocument(entry.authorization) }),
    clientIdentityHash: entry.clientIdentityHash,
    ...(entry.clientInformation === undefined
      ? {}
      : { clientInformation: clientInformationDocument(entry.clientInformation) }),
    ...(entry.discovery === undefined ? {} : { discovery: discoveryDocument(entry.discovery) }),
    serverUrlHash: entry.serverUrlHash,
    ...(entry.tokens === undefined ? {} : { tokens: storedTokensDocument(entry.tokens) }),
  };
}

function authDocumentJson(document: McpAuthDocument): McpStoreJsonObject {
  const entries: Record<string, McpStoreJsonValue> = {};
  for (const [key, entry] of Object.entries(document.entries)) entries[key] = entryDocument(entry);
  return { entries, version: AUTH_DOCUMENT_VERSION };
}

function publicEntry(entry: McpAuthStoredEntry): McpAuthEntry {
  return {
    ...(entry.authorization === undefined
      ? {}
      : { authorization: structuredClone(entry.authorization) }),
    ...(entry.clientInformation === undefined
      ? {}
      : { clientInformation: structuredClone(entry.clientInformation) }),
    ...(entry.discovery === undefined ? {} : { discovery: structuredClone(entry.discovery) }),
    ...(entry.tokens === undefined ? {} : { tokens: structuredClone(entry.tokens) }),
  };
}

function applyPatch(current: McpAuthStoredEntry, patch: McpAuthEntryPatch): McpAuthStoredEntry {
  const next: MutableMcpAuthStoredEntry = {
    ...current,
    clientIdentityHash: current.clientIdentityHash,
    serverUrlHash: current.serverUrlHash,
  };
  if (patch.authorization === null) delete next.authorization;
  if (patch.authorization !== undefined && patch.authorization !== null) {
    next.authorization = { ...current.authorization, ...structuredClone(patch.authorization) };
  }
  if (patch.clientInformation === null) delete next.clientInformation;
  if (patch.clientInformation !== undefined && patch.clientInformation !== null) {
    next.clientInformation = {
      ...current.clientInformation,
      ...structuredClone(patch.clientInformation),
    };
  }
  if (patch.discovery === null) delete next.discovery;
  if (patch.discovery !== undefined && patch.discovery !== null) {
    next.discovery = { ...current.discovery, ...structuredClone(patch.discovery) };
  }
  if (patch.tokens === null) delete next.tokens;
  if (patch.tokens !== undefined && patch.tokens !== null) {
    next.tokens = { ...current.tokens, ...structuredClone(patch.tokens) };
  }
  return next;
}

/** Strict, mode-0600 persistence for OAuth state shared by URL aliases. */
export class McpAuthStore {
  /** Absolute path to the versioned authentication document. */
  readonly path: string;

  /** Bind authentication storage to Pi's agent directory. */
  constructor(agentDirectory: string) {
    this.path = join(agentDirectory, "mcp-auth.json");
  }

  /** Read one credential entry only when its resolved URL and client identity still match. */
  async readEntry(binding: McpAuthBinding): Promise<McpStoreResult<McpAuthEntry | undefined>> {
    const normalized = parseMcpAuthBinding(binding);
    if (normalized === undefined) {
      return err(new McpStoreError("invalid_mutation", "resolve auth binding", this.path));
    }
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (cause) {
      if (isNodeErrorCode(cause, "ENOENT")) return ok(undefined);
      return err(new McpStoreError("io_failure", "read auth document", this.path, cause));
    }
    let parsedValue: unknown;
    try {
      parsedValue = JSON.parse(text);
    } catch {
      return err(new McpStoreError("invalid_document", "parse auth document", this.path));
    }
    const document = parseAuthDocument(parsedValue);
    if (document === undefined) {
      return err(new McpStoreError("invalid_document", "parse auth document", this.path));
    }
    const entry = document.entries[normalized.key];
    if (
      entry === undefined ||
      entry.serverUrlHash !== normalized.serverUrlHash ||
      entry.clientIdentityHash !== normalized.clientIdentityHash
    ) {
      return ok(undefined);
    }
    return ok(publicEntry(entry));
  }

  /** Merge authentication fields under the file lock without losing concurrent refresh data. */
  async updateEntry(
    binding: McpAuthBinding,
    patch: McpAuthEntryPatch,
  ): Promise<McpStoreResult<McpAuthEntry>> {
    const normalized = parseMcpAuthBinding(binding);
    if (normalized === undefined) {
      return err(new McpStoreError("invalid_mutation", "resolve auth binding", this.path));
    }
    const parsedPatch = parseAuthEntryPatch(patch);
    if (parsedPatch === undefined) {
      return err(new McpStoreError("invalid_mutation", "parse auth entry patch", this.path));
    }
    let updated: McpAuthStoredEntry | undefined;
    const mutation = await mutateLockedMcpJsonDocument(
      this.path,
      (current) => {
        const parsed =
          current === undefined
            ? ({ entries: {}, version: AUTH_DOCUMENT_VERSION } satisfies McpAuthDocument)
            : parseAuthDocument(current);
        if (parsed === undefined) throw new Error("Authentication document is malformed");
        const existing = parsed.entries[normalized.key] ?? {
          clientIdentityHash: normalized.clientIdentityHash,
          serverUrlHash: normalized.serverUrlHash,
        };
        updated = applyPatch(existing, parsedPatch);
        return authDocumentJson({
          entries: { ...parsed.entries, [normalized.key]: updated },
          version: AUTH_DOCUMENT_VERSION,
        });
      },
      { forceMode: AUTH_FILE_MODE },
    );
    if (!mutation.ok) {
      if (mutation.error.code === "invalid_mutation") {
        return err(
          new McpStoreError(
            "invalid_document",
            "update auth document",
            this.path,
            mutation.error.cause,
          ),
        );
      }
      return mutation;
    }
    if (updated === undefined) {
      return err(new McpStoreError("invalid_mutation", "update auth document", this.path));
    }
    return ok(publicEntry(updated));
  }

  /** Remove one URL/client credential entry while preserving every other binding. */
  async removeEntry(
    binding: McpAuthBinding,
  ): Promise<McpStoreResult<{ readonly changed: boolean }>> {
    const normalized = parseMcpAuthBinding(binding);
    if (normalized === undefined) {
      return err(new McpStoreError("invalid_mutation", "resolve auth binding", this.path));
    }
    const mutation = await mutateLockedMcpJsonDocument(
      this.path,
      (current) => {
        if (current === undefined) return undefined;
        const parsed = parseAuthDocument(current);
        if (parsed === undefined) throw new Error("Authentication document is malformed");
        if (!(normalized.key in parsed.entries)) return undefined;
        const entries = { ...parsed.entries };
        delete entries[normalized.key];
        return authDocumentJson({ entries, version: AUTH_DOCUMENT_VERSION });
      },
      { forceMode: AUTH_FILE_MODE },
    );
    if (!mutation.ok && mutation.error.code === "invalid_mutation") {
      return err(
        new McpStoreError("invalid_document", "remove auth entry", this.path, mutation.error.cause),
      );
    }
    return mutation;
  }

  /** Explicitly replace even malformed authentication bytes with an empty versioned store. */
  forceReset(): Promise<McpStoreResult<void>> {
    return forceReplaceLockedMcpJsonDocument(
      this.path,
      authDocumentJson({ entries: {}, version: AUTH_DOCUMENT_VERSION }),
      { forceMode: AUTH_FILE_MODE },
    );
  }
}
