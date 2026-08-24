// oxlint-disable anti-slop/no-conditional-empty-object-spread -- Exact optional properties require omitting absent credential fields from the persisted wire document.
// oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- This file owns the strict authentication JSON parser boundary; every accepted primitive and object field is refined here.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  forceReplaceLockedMcpJsonDocument,
  McpStoreError,
  type McpStoreJsonObject,
  type McpStoreResult,
  mutateLockedMcpJsonDocument,
} from "./mcp-settings-store.js";

const AUTH_DOCUMENT_VERSION = 1;
const AUTH_FILE_MODE = 0o600;
const SHA_256_HEX = /^[a-f0-9]{64}$/;

const McpAuthJsonValueSchema = Type.Cyclic(
  {
    McpAuthJsonValue: Type.Union([
      Type.Null(),
      Type.Boolean(),
      Type.Number(),
      Type.String(),
      Type.Array(Type.Ref("McpAuthJsonValue")),
      Type.Record(Type.String(), Type.Ref("McpAuthJsonValue"), { additionalProperties: false }),
    ]),
  },
  "McpAuthJsonValue",
);
const McpAuthJsonObjectSchema = Type.Unsafe<McpStoreJsonObject>(
  Type.Record(Type.String(), McpAuthJsonValueSchema, { additionalProperties: false }),
);
const McpStoredOAuthTokensSchema = Type.Object(
  {
    accessToken: Type.String(),
    expiresAt: Type.Optional(Type.Number()),
    refreshToken: Type.Optional(Type.String()),
    scope: Type.Optional(Type.String()),
    tokenType: Type.String(),
  },
  { additionalProperties: false },
);
const McpStoredOAuthClientInformationSchema = Type.Object(
  {
    clientId: Type.String(),
    clientIdIssuedAt: Type.Optional(Type.Number()),
    clientSecret: Type.Optional(Type.String()),
    clientSecretExpiresAt: Type.Optional(Type.Number()),
    metadataDocumentUrl: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
const McpStoredOAuthAuthorizationStateSchema = Type.Object(
  {
    codeVerifier: Type.Optional(Type.String()),
    state: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
const McpStoredOAuthDiscoverySchema = Type.Object(
  {
    authorizationServerMetadata: Type.Optional(McpAuthJsonObjectSchema),
    authorizationServerUrl: Type.Optional(Type.String()),
    protectedResourceMetadata: Type.Optional(McpAuthJsonObjectSchema),
    resourceMetadataUrl: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
const McpAuthEntryProperties = {
  authorization: Type.Optional(McpStoredOAuthAuthorizationStateSchema),
  clientInformation: Type.Optional(McpStoredOAuthClientInformationSchema),
  discovery: Type.Optional(McpStoredOAuthDiscoverySchema),
  tokens: Type.Optional(McpStoredOAuthTokensSchema),
};
const McpAuthEntrySchema = Type.Object(McpAuthEntryProperties, { additionalProperties: false });
const McpAuthEntryPatchSchema = Type.Object(
  {
    authorization: Type.Optional(Type.Union([McpStoredOAuthAuthorizationStateSchema, Type.Null()])),
    clientInformation: Type.Optional(
      Type.Union([McpStoredOAuthClientInformationSchema, Type.Null()]),
    ),
    discovery: Type.Optional(Type.Union([McpStoredOAuthDiscoverySchema, Type.Null()])),
    tokens: Type.Optional(Type.Union([McpStoredOAuthTokensSchema, Type.Null()])),
  },
  { additionalProperties: false },
);
const McpAuthStoredEntrySchema = Type.Object(
  {
    ...McpAuthEntryProperties,
    clientIdentityHash: Type.String({ pattern: SHA_256_HEX.source }),
    serverUrlHash: Type.String({ pattern: SHA_256_HEX.source }),
  },
  { additionalProperties: false },
);
const McpAuthDocumentSchema = Type.Object(
  {
    entries: Type.Record(Type.String({ pattern: SHA_256_HEX.source }), McpAuthStoredEntrySchema, {
      additionalProperties: false,
    }),
    version: Type.Literal(AUTH_DOCUMENT_VERSION),
  },
  { additionalProperties: false },
);

/** URL and OAuth client identity that jointly own one stored credential entry. */
export interface McpAuthBinding {
  readonly clientIdentity: string;
  readonly serverUrl: string;
}

/** OAuth tokens persisted exactly across refreshes and process restarts. */
export type McpStoredOAuthTokens = Readonly<Static<typeof McpStoredOAuthTokensSchema>>;

/** OAuth client registration or configured client identity persisted for reuse. */
export type McpStoredOAuthClientInformation = Readonly<
  Static<typeof McpStoredOAuthClientInformationSchema>
>;

/** PKCE verifier and authorization state persisted between remote callback steps. */
export type McpStoredOAuthAuthorizationState = Readonly<
  Static<typeof McpStoredOAuthAuthorizationStateSchema>
>;

/** OAuth discovery documents retained without interpreting RFC extension fields. */
export type McpStoredOAuthDiscovery = Readonly<Static<typeof McpStoredOAuthDiscoverySchema>>;

/** Complete authentication data associated with one URL/client binding. */
export type McpAuthEntry = Readonly<Static<typeof McpAuthEntrySchema>>;

/** Top-level authentication fields changed under one locked read-modify-write. */
export type McpAuthEntryPatch = Readonly<Static<typeof McpAuthEntryPatchSchema>>;

type McpAuthStoredEntry = Readonly<Static<typeof McpAuthStoredEntrySchema>>;
type McpAuthDocument = Readonly<Static<typeof McpAuthDocumentSchema>>;

type MutableMcpAuthStoredEntry = {
  -readonly [Field in keyof McpAuthStoredEntry]?: McpAuthStoredEntry[Field];
} & Pick<McpAuthStoredEntry, "clientIdentityHash" | "serverUrlHash">;

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

function parseAuthEntryPatch(value: McpAuthEntryPatch): McpAuthEntryPatch | undefined {
  if (!Value.Check(McpAuthEntryPatchSchema, value)) return undefined;
  try {
    const json: unknown = JSON.parse(JSON.stringify(value));
    return Value.Check(McpAuthEntryPatchSchema, json) ? json : undefined;
  } catch {
    return undefined;
  }
}

function parseAuthDocument(value: unknown): McpAuthDocument | undefined {
  if (!Value.Check(McpAuthDocumentSchema, value)) return undefined;
  for (const [key, entry] of Object.entries(value.entries)) {
    if (sha256(`${entry.serverUrlHash}\0${entry.clientIdentityHash}`) !== key) return undefined;
  }
  return value;
}

function authDocumentJson(document: McpAuthDocument): McpStoreJsonObject {
  const json: unknown = JSON.parse(JSON.stringify(document));
  if (!Value.Check(McpAuthJsonObjectSchema, json)) {
    throw new Error("Authentication document serialization produced non-JSON data");
  }
  return json;
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
