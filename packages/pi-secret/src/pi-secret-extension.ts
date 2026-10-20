import { accessSync, constants } from "node:fs";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, sep } from "node:path";
import type { JsonValue } from "@earendil-works/pi-ai";
import {
  defineTool,
  getAgentDir,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  type ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { acceptNullForOptionalArguments } from "@ian-pascoe/pi-utils/null-optional-arguments";
import {
  heldSecretNames,
  holdRefreshableSecret,
  holdSecret,
  isSecretHeld,
  redactSecrets,
  refreshSecret,
  resolveSecret,
  revokeSecret,
  SECRET_NAME_PATTERN,
  secretReference,
  type SecretOwner,
} from "@ian-pascoe/pi-utils/secret-registry";
import { noticeText } from "@ian-pascoe/pi-utils/ui";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { ApprovalDialog, type ApprovalDialogResult } from "./approval-dialog.js";
import { OnePasswordProvider } from "./one-password-provider.js";
import {
  lifetimeText,
  SecretDialog,
  SHORT_SECRET_LENGTH,
  type SecretDialogResult,
} from "./secret-dialog.js";
import {
  providerFor,
  type AvailableEntry,
  type LocatorDescription,
  type SaveRequest,
  type SecretProvider,
} from "./secret-provider.js";
import { renderSecretCall, renderSecretResult } from "./secret-render.js";
import {
  isSecretName,
  referencedSecretNames,
  rewriteReferences,
  secretEnvName,
} from "./secret-references.js";
import {
  DEFAULT_LIFETIME_MINUTES,
  readSecretSettings,
  type SecretSettings,
} from "./secret-settings.js";
import { keyFilePath, SealedSecretSchema, SecretVault, type SealedSecret } from "./secret-vault.js";
import { TROUBLESHOOTING_HINT } from "./troubleshooting-skill.js";

/** Custom session entry type holding one typed Secret's ciphertext. */
export const SECRET_ENTRY_TYPE = "pi-secret";
/** Custom session entry type holding one Secret Grant: a Secret Locator, never a value. */
export const GRANT_ENTRY_TYPE = "pi-secret-grant";
/** Custom session entry type recording that a Secret was forgotten, so it is not restored. */
export const FORGET_ENTRY_TYPE = "pi-secret-forget";

/** Static system prompt lines, so they never move the cache prefix within a session. */
export const SECRET_PROMPT_SNIPPET =
  "Ask the user for Secrets such as API keys and passwords; values never reach you";
export const SECRET_PROMPT_GUIDELINES = [
  "When a task needs a Secret such as an API key or password, call secret_ask instead of asking the user to paste it into the conversation.",
  "Use a held Secret as $PI_SECRET_NAME in shell commands, which keeps it off the command line, and as {{secret:NAME}} in other tool arguments. Tool output shows {{secret:NAME}} where a value was redacted.",
];
/** Added, once at load, only when a Secret Provider is available. */
export const SECRET_PROVIDER_GUIDELINE =
  "When a Secret may already be in a Secret Provider such as 1Password, find it with secret_list and request it with secret_ask_grant instead of asking the user to type it.";

const SECRET_TOOLS: readonly string[] = [
  "secret_ask",
  "secret_ask_grant",
  "secret_list",
  "secret_save",
  "secret_forget",
];

export interface PiSecretOptions {
  /** Pi's agent directory, which holds the key file; tests isolate it. */
  getAgentDirectory?: () => string;
  /** Milliseconds since the epoch; tests pass the Secret Lifetime instantly. */
  now?: () => number;
  /**
   * The Secret Providers, given the provider settings read at session start. By default, the
   * 1Password Secret Provider when `op` is on `PATH` at load.
   */
  providers?: (settings: () => SecretSettings["providers"]) => SecretProvider[];
}

/** How a held Secret got its value: typed by the user, or granted from a Secret Provider. */
type HeldSecretOrigin =
  | { readonly kind: "typed"; readonly keyId: string }
  | { readonly kind: "granted"; readonly locator: string; readonly provider: SecretProvider };

interface LiveSecret {
  readonly name: string;
  /** The value last entered or read; undefined until a restored grant is first used. */
  value: string | undefined;
  readonly origin: HeldSecretOrigin;
  readonly expiresAt: number;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** One Secret's outcome in a tool result; a type alias so it is assignable to JSON. */
type SecretOutcome = {
  name: string;
  status:
    | "provided"
    | "skipped"
    | "cancelled"
    | "granted"
    | "denied"
    | "failed"
    | "saved"
    | "held"
    | "forgotten"
    | "not_held";
  reference?: string;
  env?: string;
  expires_at?: string;
  locator?: string;
  error?: string;
  warning?: string;
};

const SecretNameSchema = Type.String({
  pattern: SECRET_NAME_PATTERN.source,
  description: "Secret Name in environment-variable style, such as OPENCODE_API_KEY",
});

const LocatorSchema = Type.String({
  minLength: 1,
  description: "Secret Locator, such as the 1Password Reference op://vault/item/field",
});

const AskParameters = Type.Object({
  names: Type.Array(SecretNameSchema, {
    minItems: 1,
    maxItems: 20,
    uniqueItems: true,
    description: "Secret Names to request from the user, one masked field each",
  }),
  reason: Type.Optional(
    Type.String({ description: "Why the Secrets are needed, shown to the user" }),
  ),
});

const AskGrantParameters = Type.Object({
  grants: Type.Array(Type.Object({ name: SecretNameSchema, locator: LocatorSchema }), {
    minItems: 1,
    maxItems: 20,
    description:
      "Secret Grants to request, each a Secret Name and the Secret Locator its value is read from; names must be unique",
  }),
  reason: Type.Optional(
    Type.String({ description: "Why the Secrets are needed, shown to the user" }),
  ),
});

const ListParameters = Type.Object({
  query: Type.Optional(
    Type.String({
      description:
        "Case-insensitive text matched against Secret Names, item titles, and field labels",
    }),
  ),
  provider: Type.Optional(
    Type.String({ description: "Only this Secret Provider, such as 1password" }),
  ),
  vault: Type.Optional(Type.String({ description: "Only available items in this vault" })),
  item: Type.Optional(
    Type.String({
      description: "List this item's fields, with the Secret Locator to request each by",
    }),
  ),
  status: Type.Optional(
    Type.Union([Type.Literal("held"), Type.Literal("available")], {
      description: "held: Secrets this session can use; available: items in Secret Providers",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 100,
      description: "Most available entries per Secret Provider (default 20)",
    }),
  ),
});

const SaveParameters = Type.Object({
  name: SecretNameSchema,
  locator: Type.String({
    minLength: 1,
    description:
      "Secret Locator of the new item's field, such as op://vault/new item title/credential; the item must not exist yet",
  }),
  category: Type.Optional(
    Type.String({ description: "Category of the new item (default API Credential)" }),
  ),
});

const ForgetParameters = Type.Object({
  names: Type.Array(SecretNameSchema, {
    minItems: 1,
    uniqueItems: true,
    description: "Secret Names to forget now, before their lifetime ends",
  }),
});

const SecretGrantSchema = Type.Object(
  {
    version: Type.Literal(1),
    name: Type.String(),
    locator: Type.String(),
    expiresAt: Type.Number(),
  },
  { additionalProperties: false },
);
type SecretGrant = Static<typeof SecretGrantSchema>;
const ForgottenSchema = Type.Object(
  { version: Type.Literal(1), name: Type.String() },
  { additionalProperties: false },
);

const DEFAULT_LIST_LIMIT = 20;

const WITHHELD_RESULT =
  "Pi Secret could not check this tool result for Secret values, so it was withheld. The tool did run.";
const ESCAPE_HINT =
  "To write a reference as literal text instead, put a backslash right before it; Pi Secret removes the backslash.";

function iso(time: number): string {
  return new Date(time).toISOString();
}

/**
 * Why a call referencing `names` cannot run, or undefined when every one is a held Secret. A
 * malformed name and a name this session does not hold each get their own advice.
 */
function unresolvedReason(names: readonly string[]): string | undefined {
  const malformed = names.filter((name) => !isSecretName(name));
  const unheld = names.filter((name) => isSecretName(name) && !isSecretHeld(name));
  const sentences = ["The call did not run."];
  if (malformed.length > 0) {
    const listed = malformed.map((name) => JSON.stringify(name)).join(", ");
    const verb =
      malformed.length === 1 ? "is not a valid Secret Name" : "are not valid Secret Names";
    sentences.push(
      `${listed} ${verb}: a Secret Name uses uppercase letters, digits, and underscores, and does not start with a digit.`,
    );
  }
  if (unheld.length > 0) {
    const listed = unheld.map((name) => secretReference(name)).join(", ");
    sentences.push(
      `It references ${listed}, which this session does not hold. The Secret expired, was forgotten, or was never provided. Call secret_ask to request it again.`,
    );
  }
  if (sentences.length === 1) return undefined;
  sentences.push(ESCAPE_HINT);
  return sentences.join(" ");
}

/** The reason to show the user, if the agent gave one that is not blank. */
function shownReason(reason: string | undefined): string | undefined {
  return reason?.trim() === "" ? undefined : reason;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Whether an executable named `command` is on `PATH`, without running it. */
function onPath(command: string): boolean {
  const names = process.platform === "win32" ? [`${command}.exe`, `${command}.cmd`] : [command];
  for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
    if (directory === "") continue;
    for (const name of names) {
      try {
        accessSync(join(directory, name), constants.X_OK);
        return true;
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return false;
}

function defaultProviders(settings: () => SecretSettings["providers"]): SecretProvider[] {
  return onPath("op") ? [new OnePasswordProvider(() => settings()["1password"] ?? {})] : [];
}

/** The fields through which Pi's tools point at a full output file. */
const OutputFileFieldsSchema = Type.Object({
  fullOutputPath: Type.Optional(Type.String({ minLength: 1 })),
  full_output_path: Type.Optional(Type.String({ minLength: 1 })),
});

/** Paths of full output files a tool result points at, which hooks cannot otherwise redact. */
function outputFiles(...values: unknown[]): string[] {
  const paths = new Set<string>();
  for (const value of values) {
    if (!Value.Check(OutputFileFieldsSchema, value)) continue;
    if (value.fullOutputPath !== undefined) paths.add(value.fullOutputPath);
    if (value.full_output_path !== undefined) paths.add(value.full_output_path);
  }
  return [...paths];
}

function isMissingFile(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

/**
 * Redact a full output file in place. Only regular files inside the OS temporary directory,
 * where Pi writes output files, are touched, so a tool cannot point this at a user's file.
 */
async function redactOutputFile(path: string): Promise<void> {
  let text: string;
  try {
    const file = await lstat(path);
    const directory = `${await realpath(tmpdir())}${sep}`;
    if (!file.isFile() || !(await realpath(path)).startsWith(directory)) return;
    text = await readFile(path, "utf8");
  } catch (cause) {
    if (isMissingFile(cause)) return;
    throw cause;
  }
  const redacted = redactSecrets(text);
  if (redacted !== text) await writeFile(path, redacted);
}

function usage(outcome: SecretOutcome): string {
  return `Use ${outcome.env === undefined ? "" : `$${outcome.env} in shell commands and `}${outcome.reference} in other tool arguments.`;
}

function outcomeLine(outcome: SecretOutcome): string {
  const warning = outcome.warning === undefined ? "" : ` Warning: ${outcome.warning}`;
  switch (outcome.status) {
    case "provided":
      return `${outcome.name}: provided. ${usage(outcome)} Expires ${outcome.expires_at}.${warning}`;
    case "granted":
      return `${outcome.name}: granted from ${outcome.locator}, read again at each use. ${usage(outcome)} Expires ${outcome.expires_at}.${warning}`;
    case "saved":
      return `${outcome.name}: saved to ${outcome.locator}, and now read from there at each use. ${usage(outcome)} Expires ${outcome.expires_at}.`;
    case "held": {
      const from = outcome.locator === undefined ? "" : ` from ${outcome.locator}`;
      return outcome.expires_at === undefined
        ? `${outcome.name}: held by another session in this process. Use $${outcome.env} or ${outcome.reference}.`
        : `${outcome.name}: held${from} until ${outcome.expires_at}. Use $${outcome.env} or ${outcome.reference}.`;
    }
    case "skipped":
      return `${outcome.name}: skipped by the user.`;
    case "denied":
      return `${outcome.name}: denied by the user.`;
    case "failed":
      return `${outcome.name}: not granted: ${outcome.error}`;
    case "cancelled":
      return `${outcome.name}: not provided; the user cancelled the request.`;
    case "forgotten":
      return `${outcome.name}: forgotten.`;
    case "not_held":
      return `${outcome.name}: not held by this session.`;
  }
}

function availableLine(entry: AvailableEntry): string {
  return entry.kind === "item"
    ? `- ${entry.title} (${entry.category}) in ${entry.vault}; list its fields with secret_list item="${entry.id}"`
    : `- ${entry.label} (${entry.type}) of ${entry.item}: ${entry.locator}`;
}

/** A `secret_*` result's details, never a value; a type alias so it is assignable to JSON. */
type SecretResultDetails = {
  secrets: SecretOutcome[];
  available?: AvailableEntry[];
  notes?: string[];
};

interface SecretResultParts {
  outcomes: SecretOutcome[];
  available: AvailableEntry[];
  notes: string[];
  lead?: string;
}

function secretResult({ outcomes, available, notes, lead }: SecretResultParts) {
  const lines = outcomes.map(outcomeLine);
  if (available.length > 0)
    lines.push("Available to request with secret_ask_grant:", ...available.map(availableLine));
  lines.push(...notes);
  const text = lead === undefined ? lines.join("\n") : [lead, ...lines].join("\n");
  const details: SecretResultDetails = { secrets: outcomes };
  if (available.length > 0) details.available = available;
  if (notes.length > 0) details.notes = notes;
  return {
    content: [{ type: "text" as const, text }],
    details,
    structuredContent: structuredClone(details),
  };
}

const outcomesResult = (outcomes: SecretOutcome[], lead?: string) =>
  secretResult(
    lead === undefined
      ? { outcomes, available: [], notes: [] }
      : { outcomes, available: [], notes: [], lead },
  );

function describeLocation(provider: SecretProvider, description: LocatorDescription): string {
  const account = description.account === undefined ? "" : ` (${description.account})`;
  const type = description.fieldType === undefined ? "" : ` · ${description.fieldType}`;
  return `${provider.label}${account} · ${description.vault} / ${description.item} / ${description.field}${type}`;
}

function shortValueWarning(value: string): string | undefined {
  return value.length < SHORT_SECRET_LENGTH
    ? `the value is shorter than ${SHORT_SECRET_LENGTH} characters, so redacting it may also hide unrelated output.`
    : undefined;
}

/** Compose Pi Secret with an injectable agent directory, clock, and Secret Providers. */
export function createPiSecretExtension(options: PiSecretOptions = {}): ExtensionFactory {
  const getAgentDirectory = options.getAgentDirectory ?? getAgentDir;
  const now = options.now ?? Date.now;

  return (pi: ExtensionAPI) => {
    const owner: SecretOwner = { description: "pi-secret" };
    const live = new Map<string, LiveSecret>();
    let lifetimeMinutes = DEFAULT_LIFETIME_MINUTES;
    let providerSettings: SecretSettings["providers"] = {};
    let generation = 0;
    const vault = () => new SecretVault(keyFilePath(getAgentDirectory()), now);
    // Decided once at load, so the tool set and system prompt never change within a session.
    const providers = (options.providers ?? defaultProviders)(() => providerSettings);

    /** Stop holding one Secret here; a typed Secret's key is left for the caller to handle. */
    function release(name: string): LiveSecret | undefined {
      const secret = live.get(name);
      if (secret === undefined) return undefined;
      live.delete(name);
      clearTimeout(secret.timer);
      revokeSecret(name, owner);
      const env = secretEnvName(name);
      if (secret.value !== undefined && process.env[env] === secret.value)
        Reflect.deleteProperty(process.env, env);
      return secret;
    }

    /** Release a Secret and destroy its key, if it is a typed one. */
    async function discard(name: string): Promise<void> {
      const released = release(name);
      if (released?.origin.kind === "typed") await vault().destroy([released.origin.keyId]);
    }

    async function expire(secret: LiveSecret): Promise<void> {
      if (live.get(secret.name) !== secret) return;
      release(secret.name);
      if (secret.origin.kind !== "typed") return;
      // A key that cannot be deleted now is swept at the next session start.
      await vault()
        .destroy([secret.origin.keyId])
        .catch(() => {});
    }

    function track(
      name: string,
      value: string | undefined,
      origin: HeldSecretOrigin,
      expiresAt: number,
    ): LiveSecret {
      release(name);
      const secret: LiveSecret = {
        name,
        value,
        origin,
        expiresAt,
        timer: setTimeout(() => void expire(secret), Math.max(0, expiresAt - now())),
      };
      secret.timer.unref();
      live.set(name, secret);
      if (value !== undefined) process.env[secretEnvName(name)] = value;
      return secret;
    }

    function adoptTyped(name: string, value: string, keyId: string, expiresAt: number): void {
      track(name, value, { kind: "typed", keyId }, expiresAt);
      holdSecret(name, value, owner, expiresAt);
    }

    /** Hold a Secret Grant, read again from its Secret Provider at each use (ADR-0001). */
    function adoptGrant(
      name: string,
      locator: string,
      provider: SecretProvider,
      expiresAt: number,
      value: string | undefined,
    ): void {
      const secret = track(name, value, { kind: "granted", locator, provider }, expiresAt);
      const refresh = async () => {
        const read = await provider.read(locator);
        if (live.get(name) === secret) {
          secret.value = read;
          process.env[secretEnvName(name)] = read;
        }
        return read;
      };
      holdRefreshableSecret(
        name,
        owner,
        value === undefined ? { refresh, expiresAt } : { refresh, expiresAt, value },
      );
    }

    /** Record a Secret Grant in the session: its locator and expiry, never its value. */
    function recordGrant(name: string, locator: string, expiresAt: number): void {
      const grant: SecretGrant = { version: 1, name, locator, expiresAt };
      pi.appendEntry(GRANT_ENTRY_TYPE, grant);
    }

    /** End every Secret whose lifetime has passed, as its timer would. */
    async function expireDue(): Promise<void> {
      const due = [...live.values()].filter((secret) => secret.expiresAt <= now());
      for (const secret of due) await expire(secret);
    }

    function releaseAll(): void {
      // Deleting the visited entry while iterating a Map is safe.
      for (const name of live.keys()) release(name);
    }

    type Recorded =
      | { readonly kind: "sealed"; readonly data: SealedSecret }
      | {
          readonly kind: "grant";
          readonly data: SecretGrant;
        }
      | { readonly kind: "forgotten" };

    async function restore(context: ExtensionContext): Promise<void> {
      const current = ++generation;
      releaseAll();
      const warn = (message: string) =>
        context.ui.notify(
          noticeText("Pi Secret", `${message}. Run /skill:pi-secret to diagnose.`),
          "warning",
        );
      const { settings, warning } = readSecretSettings({
        settingsManager: SettingsManager.create(context.cwd, getAgentDirectory(), {
          projectTrusted: context.isProjectTrusted(),
        }),
        sessionManager: context.sessionManager,
      });
      lifetimeMinutes = settings.lifetimeMinutes;
      providerSettings = settings.providers;
      if (warning !== undefined) warn(warning);
      // The newest entry for each name wins, whether it entered, granted, or forgot a Secret.
      const latest = new Map<string, Recorded>();
      for (const entry of context.sessionManager.getBranch()) {
        if (entry.type !== "custom") continue;
        if (entry.customType === SECRET_ENTRY_TYPE && Value.Check(SealedSecretSchema, entry.data))
          latest.set(entry.data.name, { kind: "sealed", data: entry.data });
        else if (
          entry.customType === GRANT_ENTRY_TYPE &&
          Value.Check(SecretGrantSchema, entry.data)
        )
          latest.set(entry.data.name, { kind: "grant", data: entry.data });
        else if (entry.customType === FORGET_ENTRY_TYPE && Value.Check(ForgottenSchema, entry.data))
          latest.set(entry.data.name, { kind: "forgotten" });
      }
      try {
        await vault().destroy([]);
      } catch (cause) {
        warn(`cannot delete expired Secret keys: ${errorMessage(cause)}`);
      }
      if (current !== generation) return;
      // Each Secret is restored on its own, so one unreadable entry cannot hide the others.
      for (const recorded of latest.values()) {
        if (recorded.kind === "forgotten") continue;
        if (recorded.kind === "grant") {
          const { name, locator, expiresAt } = recorded.data;
          if (expiresAt <= now()) continue;
          const provider = providerFor(providers, locator);
          if (provider === undefined) {
            warn(`cannot restore Secret Grant ${name}: no Secret Provider reads ${locator}`);
            continue;
          }
          // Read lazily, at first use, so resuming never prompts the Secret Provider.
          adoptGrant(name, locator, provider, expiresAt, undefined);
          continue;
        }
        const sealed = recorded.data;
        let value: string | undefined;
        try {
          value = await vault().open(sealed);
        } catch (cause) {
          warn(`cannot restore Secret ${sealed.name}: ${errorMessage(cause)}`);
        }
        if (current !== generation) return;
        if (value !== undefined) adoptTyped(sealed.name, value, sealed.keyId, sealed.expiresAt);
      }
    }

    pi.on("session_start", async (_event, context) => restore(context));
    pi.on("session_tree", async (_event, context) => restore(context));
    pi.on("session_shutdown", () => {
      generation++;
      releaseAll();
    });

    pi.on("tool_call", async (event) => {
      if (SECRET_TOOLS.includes(event.toolName)) return undefined;
      await expireDue();
      // SAFETY: tool arguments are parsed JSON, validated against the tool's schema.
      const input = event.input as { [key: string]: JsonValue };
      const names = referencedSecretNames(input);
      const reason = unresolvedReason([...names]);
      if (reason !== undefined) return { block: true, reason };
      // Granted Secrets are read again now, in either reference form (ADR-0001).
      for (const name of names) {
        let value: string | undefined;
        try {
          value = await refreshSecret(name);
        } catch (cause) {
          return {
            block: true,
            reason: `The call did not run. Pi Secret could not read ${secretReference(name)} from its Secret Provider: ${errorMessage(cause)}. Ask the user to unlock or sign in to it, or call secret_ask_grant again. ${TROUBLESHOOTING_HINT}`,
          };
        }
        if (value === undefined)
          return { block: true, reason: unresolvedReason([name]) ?? "The call did not run." };
      }
      // Pi passes the same arguments object on to the tool: rewrite in place.
      const rewritten = rewriteReferences(input, (name) => resolveSecret(name) ?? "");
      if (rewritten !== input) Object.assign(input, rewritten);
      return undefined;
    });

    pi.on("tool_result", async (event): Promise<ToolResultEventResult | undefined> => {
      try {
        const content = redactSecrets(event.content);
        const details = redactSecrets(event.details);
        const structuredContent = redactSecrets(event.structuredContent);
        for (const path of outputFiles(event.details, event.structuredContent))
          await redactOutputFile(path);
        if (
          content === event.content &&
          details === event.details &&
          structuredContent === event.structuredContent
        )
          return undefined;
        const result: ToolResultEventResult = { content };
        if (details !== undefined) result.details = details;
        if (structuredContent !== undefined) result.structuredContent = structuredContent;
        return result;
      } catch {
        // Fail closed: Pi would otherwise keep the unredacted result.
        return {
          content: [{ type: "text", text: `${WITHHELD_RESULT} ${TROUBLESHOOTING_HINT}` }],
          details: {},
          isError: true,
        };
      }
    });

    pi.on("context", (event) => {
      const messages = redactSecrets(event.messages);
      return messages === event.messages ? undefined : { messages };
    });

    const needsTerminal = (tool: string, what: string) =>
      new Error(
        `${tool} needs Pi's interactive terminal, where the user ${what}; it is unavailable in print, JSON, and RPC modes and in Child Agents. Ask the user how they want to provide the Secret.\n\n${TROUBLESHOOTING_HINT}`,
      );

    const ask = defineTool({
      name: "secret_ask",
      label: "Secret Ask",
      description:
        "Ask the user to enter Secrets (API keys, passwords, tokens) in a masked prompt. Returns how to reference each one; never its value.",
      promptSnippet: SECRET_PROMPT_SNIPPET,
      promptGuidelines: SECRET_PROMPT_GUIDELINES,
      parameters: AskParameters,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      executionMode: "sequential",
      renderCall: (params, theme, context) =>
        renderSecretCall("secret_ask", params, theme, context),
      renderResult: (result, options, theme, context) =>
        renderSecretResult(result, options, theme, context),
      async execute(_toolCallId, params, signal, _onUpdate, context) {
        if (context.mode !== "tui")
          throw needsTerminal("secret_ask", "enters values in a masked prompt");
        const reason = shownReason(params.reason);
        const answer = await context.ui.custom<SecretDialogResult>(
          (tui, theme, keybindings, done) => {
            const dialog = new SecretDialog({
              names: params.names,
              reason,
              lifetimeMinutes,
              theme,
              keybindings,
              requestRender: () => tui.requestRender(),
              done,
            });
            signal?.addEventListener("abort", () => dialog.cancel(), { once: true });
            return dialog;
          },
        );
        if (answer === undefined || answer.kind === "cancelled")
          return outcomesResult(
            params.names.map((name) => ({ name, status: "cancelled" })),
            "The user cancelled the Secret Request. Do not ask again unless they want to.",
          );
        const outcomes: SecretOutcome[] = [];
        for (const name of params.names) {
          const value = answer.values.get(name);
          if (value === undefined) {
            outcomes.push({ name, status: "skipped" });
            continue;
          }
          const expiresAt = now() + lifetimeMinutes * 60_000;
          let sealed: SealedSecret;
          try {
            sealed = await vault().seal(name, value, expiresAt);
            pi.appendEntry(SECRET_ENTRY_TYPE, sealed);
          } catch (cause) {
            // Secrets stored before the failure are held; say so rather than hide them.
            const stored = outcomes.filter((outcome) => outcome.status === "provided");
            const held =
              stored.length === 0
                ? ""
                : ` Already stored and held: ${stored.map((outcome) => `${outcome.name} (${outcome.reference})`).join(", ")}.`;
            throw new Error(
              `Cannot store Secret ${name}: ${errorMessage(cause)}.${held}\n\n${TROUBLESHOOTING_HINT}`,
              { cause },
            );
          }
          await discard(name);
          adoptTyped(name, value, sealed.keyId, expiresAt);
          outcomes.push({
            name,
            status: "provided",
            reference: secretReference(name),
            env: secretEnvName(name),
            expires_at: iso(expiresAt),
          });
        }
        return outcomesResult(outcomes);
      },
    });

    /** Ask the user to approve rows in one dialog; undefined when they cancel. */
    async function approve(
      context: Parameters<typeof ask.execute>[4],
      signal: AbortSignal | undefined,
      dialog: { title: string; reason: string | undefined; explanation: string },
      rows: { name: string; detail: string }[],
    ): Promise<ReadonlySet<number> | undefined> {
      const answer = await context.ui.custom<ApprovalDialogResult>(
        (tui, theme, keybindings, done) => {
          const component = new ApprovalDialog({
            ...dialog,
            rows,
            theme,
            keybindings,
            requestRender: () => tui.requestRender(),
            done,
          });
          signal?.addEventListener("abort", () => component.cancel(), { once: true });
          return component;
        },
      );
      return answer === undefined || answer.kind === "cancelled" ? undefined : answer.approved;
    }

    const schemes = () => providers.map((provider) => `${provider.scheme}://`).join(", ");

    const askGrant = defineTool({
      name: "secret_ask_grant",
      label: "Secret Ask Grant",
      description:
        "Ask the user to grant Secrets from a Secret Provider such as 1Password, each a Secret Name and the Secret Locator (such as op://vault/item/field) its value is read from at each use. Find locators with secret_list. Returns how to reference each one; never its value.",
      promptGuidelines: [SECRET_PROVIDER_GUIDELINE],
      parameters: AskGrantParameters,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      executionMode: "sequential",
      renderCall: (params, theme, context) =>
        renderSecretCall(
          "secret_ask_grant",
          { names: params.grants?.map((grant) => grant.name) ?? [], reason: params.reason },
          theme,
          context,
        ),
      renderResult: (result, options, theme, context) =>
        renderSecretResult(result, options, theme, context),
      async execute(_toolCallId, params, signal, _onUpdate, context) {
        if (context.mode !== "tui")
          throw needsTerminal("secret_ask_grant", "approves each Secret Grant");
        const names = params.grants.map((grant) => grant.name);
        const duplicate = names.find((name, index) => names.indexOf(name) !== index);
        if (duplicate !== undefined)
          throw new Error(`Secret Name ${duplicate} appears in more than one grant`);
        const outcomes: SecretOutcome[] = params.grants.map((grant) => ({
          name: grant.name,
          status: "failed",
          locator: grant.locator,
        }));
        const pending: {
          index: number;
          provider: SecretProvider;
          description: LocatorDescription;
        }[] = [];
        for (const [index, grant] of params.grants.entries()) {
          const outcome = outcomes[index];
          if (outcome === undefined) continue;
          const provider = providerFor(providers, grant.locator);
          if (provider === undefined) {
            outcome.error = `no Secret Provider reads ${JSON.stringify(grant.locator)}; available schemes: ${schemes()}`;
            continue;
          }
          try {
            pending.push({
              index,
              provider,
              description: await provider.describe(grant.locator, signal),
            });
          } catch (cause) {
            outcome.error = errorMessage(cause);
          }
        }
        if (pending.length === 0) return outcomesResult(outcomes);
        const approved = await approve(
          context,
          signal,
          {
            title: "Grant request",
            reason: shownReason(params.reason),
            explanation: `Each allowed Secret is read from its Secret Provider at each use for ${lifetimeText(lifetimeMinutes)}, and never shown to the model.`,
          },
          pending.map(({ index, provider, description }) => ({
            name: params.grants[index]?.name ?? "",
            detail: describeLocation(provider, description),
          })),
        );
        if (approved === undefined) {
          for (const { index } of pending) {
            const outcome = outcomes[index];
            if (outcome !== undefined) outcome.status = "cancelled";
          }
          return outcomesResult(
            outcomes,
            "The user cancelled the Grant Request. Do not ask again unless they want to.",
          );
        }
        for (const [row, { index, provider }] of pending.entries()) {
          const outcome = outcomes[index];
          const grant = params.grants[index];
          if (outcome === undefined || grant === undefined) continue;
          if (!approved.has(row)) {
            outcome.status = "denied";
            continue;
          }
          let value: string;
          try {
            // Read now, so a wrong locator or a locked Secret Provider shows up here.
            value = await provider.read(grant.locator, signal);
          } catch (cause) {
            outcome.error = errorMessage(cause);
            continue;
          }
          const expiresAt = now() + lifetimeMinutes * 60_000;
          recordGrant(grant.name, grant.locator, expiresAt);
          await discard(grant.name);
          adoptGrant(grant.name, grant.locator, provider, expiresAt, value);
          Object.assign(outcome, {
            status: "granted",
            reference: secretReference(grant.name),
            env: secretEnvName(grant.name),
            expires_at: iso(expiresAt),
          });
          const warning = shortValueWarning(value);
          if (warning !== undefined) outcome.warning = warning;
        }
        return outcomesResult(outcomes);
      },
    });

    const list = defineTool({
      name: "secret_list",
      label: "Secret List",
      description:
        "List the Secrets this session can use and when each expires, and search Secret Providers such as 1Password for items and fields to request with secret_ask_grant; never values.",
      parameters: ListParameters,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: providers.length > 0,
      },
      renderCall: (_params, theme, context) => renderSecretCall("secret_list", {}, theme, context),
      renderResult: (result, options, theme, context) =>
        renderSecretResult(result, options, theme, context),
      async execute(_toolCallId, params, signal) {
        await expireDue();
        const query = params.query?.toLowerCase();
        const matches = (...texts: (string | undefined)[]) =>
          query === undefined || texts.some((text) => text?.toLowerCase().includes(query));
        const outcomes: SecretOutcome[] =
          params.status === "available"
            ? []
            : heldSecretNames()
                .toSorted()
                .flatMap((name): SecretOutcome[] => {
                  const own = live.get(name);
                  const locator = own?.origin.kind === "granted" ? own.origin.locator : undefined;
                  const providerId =
                    own?.origin.kind === "granted" ? own.origin.provider.id : undefined;
                  if (params.provider !== undefined && params.provider !== providerId) return [];
                  if (!matches(name, locator)) return [];
                  const outcome: SecretOutcome = {
                    name,
                    status: "held",
                    reference: secretReference(name),
                    env: secretEnvName(name),
                  };
                  if (own !== undefined) outcome.expires_at = iso(own.expiresAt);
                  if (locator !== undefined) outcome.locator = locator;
                  return [outcome];
                });
        const available: AvailableEntry[] = [];
        const notes: string[] = [];
        if (params.status !== "held") {
          for (const provider of providers) {
            if (params.provider !== undefined && params.provider !== provider.id) continue;
            const search: Parameters<typeof provider.search>[0] = {
              limit: params.limit ?? DEFAULT_LIST_LIMIT,
            };
            const filters = { query: params.query, vault: params.vault, item: params.item };
            for (const [key, value] of Object.entries(filters))
              if (value !== undefined) Object.assign(search, { [key]: value });
            try {
              const listing = await provider.search(search, signal);
              available.push(...listing.entries);
              if (listing.truncated)
                notes.push(
                  `More ${provider.label} entries matched; narrow them with query, vault, or item, or raise limit.`,
                );
            } catch (cause) {
              notes.push(`Could not search ${provider.label}: ${errorMessage(cause)}`);
            }
          }
        }
        const empty = outcomes.length === 0 && available.length === 0 && notes.length === 0;
        const result: SecretResultParts = { outcomes, available, notes };
        if (empty)
          result.lead =
            providers.length === 0
              ? "No Secrets are held. Call secret_ask to request one."
              : "No Secrets matched. Call secret_ask to request one, or search a Secret Provider with other filters.";
        return secretResult(result);
      },
    });

    const save = defineTool({
      name: "secret_save",
      label: "Secret Save",
      description:
        "Save a Secret the user typed into this session into a new item in a Secret Provider such as 1Password, after the user approves. The Secret is then read from there at each use, with its original expiry.",
      parameters: SaveParameters,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      executionMode: "sequential",
      renderCall: (params, theme, context) =>
        renderSecretCall("secret_save", { names: [params.name] }, theme, context),
      renderResult: (result, options, theme, context) =>
        renderSecretResult(result, options, theme, context),
      async execute(_toolCallId, params, signal, _onUpdate, context) {
        if (context.mode !== "tui") throw needsTerminal("secret_save", "approves each save");
        await expireDue();
        const secret = live.get(params.name);
        if (secret?.origin.kind !== "typed" || secret.value === undefined)
          throw new Error(
            `${params.name} is not a Secret the user typed into this session; only those can be saved. Granted Secrets already live in a Secret Provider.`,
          );
        const { value, expiresAt, origin } = secret;
        const provider = providerFor(providers, params.locator);
        if (provider === undefined)
          throw new Error(
            `No Secret Provider saves to ${JSON.stringify(params.locator)}; available schemes: ${schemes()}`,
          );
        const request: Omit<SaveRequest, "value"> =
          params.category === undefined
            ? { locator: params.locator }
            : { locator: params.locator, category: params.category };
        const description = await provider.describeSave(request, signal);
        const approved = await approve(
          context,
          signal,
          {
            title: "Save Secret",
            reason: undefined,
            explanation: `Pi Secret will create a new ${provider.label} item holding this value. The Secret is then read from there at each use, and still expires at ${iso(expiresAt)}.`,
          },
          [{ name: params.name, detail: describeLocation(provider, description) }],
        );
        if (approved === undefined || !approved.has(0))
          return outcomesResult([
            { name: params.name, status: approved === undefined ? "cancelled" : "denied" },
          ]);
        const locator = await provider.save({ ...request, value }, signal);
        recordGrant(params.name, locator, expiresAt);
        adoptGrant(params.name, locator, provider, expiresAt, value);
        // The typed copy is no longer needed. The newer grant entry wins on restore either way, so a
        // key that cannot be deleted now only waits for its expiry sweep.
        await vault()
          .destroy([origin.keyId])
          .catch(() => {});
        return outcomesResult([
          {
            name: params.name,
            status: "saved",
            locator,
            reference: secretReference(params.name),
            env: secretEnvName(params.name),
            expires_at: iso(expiresAt),
          },
        ]);
      },
    });

    async function forget(names: readonly string[]): Promise<SecretOutcome[]> {
      const outcomes: SecretOutcome[] = [];
      const destroyed: string[] = [];
      for (const name of names) {
        const released = release(name);
        if (released === undefined) {
          outcomes.push({ name, status: "not_held" });
          continue;
        }
        if (released.origin.kind === "typed") destroyed.push(released.origin.keyId);
        pi.appendEntry(FORGET_ENTRY_TYPE, { version: 1, name });
        outcomes.push({ name, status: "forgotten" });
      }
      try {
        if (destroyed.length > 0) await vault().destroy(destroyed);
      } catch (cause) {
        throw new Error(
          `Forgot ${names.join(", ")} in this session, but cannot delete their keys: ${errorMessage(cause)}\n\n${TROUBLESHOOTING_HINT}`,
          { cause },
        );
      }
      return outcomes;
    }

    const forgetTool = defineTool({
      name: "secret_forget",
      label: "Secret Forget",
      description: "Forget Secrets, typed or granted, now, before their lifetime ends.",
      parameters: ForgetParameters,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      renderCall: (params, theme, context) =>
        renderSecretCall("secret_forget", params, theme, context),
      renderResult: (result, options, theme, context) =>
        renderSecretResult(result, options, theme, context),
      async execute(_toolCallId, params) {
        await expireDue();
        return outcomesResult(await forget(params.names));
      },
    });

    pi.registerTool(acceptNullForOptionalArguments(ask));
    if (providers.length > 0) pi.registerTool(acceptNullForOptionalArguments(askGrant));
    pi.registerTool(acceptNullForOptionalArguments(list));
    if (providers.length > 0) pi.registerTool(acceptNullForOptionalArguments(save));
    pi.registerTool(acceptNullForOptionalArguments(forgetTool));

    pi.registerCommand("secret", {
      description: "List or forget this session's Secrets",
      getArgumentCompletions: (prefix) => {
        const options = [
          { value: "list", label: "list", description: "List held Secrets" },
          { value: "forget all", label: "forget all", description: "Forget every Secret" },
          ...[...live.keys()].map((name) => ({
            value: `forget ${name}`,
            label: `forget ${name}`,
            description: `Forget ${name}`,
          })),
        ].filter((option) => option.value.startsWith(prefix.trim()));
        return options.length > 0 ? options : null;
      },
      handler: async (args, context) => {
        await expireDue();
        const [action = "list", ...rest] = args.trim().split(/\s+/).filter(Boolean);
        if (action === "list") {
          const lines = [...live.values()]
            .toSorted((a, b) => a.name.localeCompare(b.name))
            .map((secret) => {
              const from = secret.origin.kind === "granted" ? ` from ${secret.origin.locator}` : "";
              return `${secret.name}${from}: expires ${iso(secret.expiresAt)}`;
            });
          context.ui.notify(lines.length === 0 ? "No Secrets are held" : lines.join("\n"), "info");
          return;
        }
        if (action === "forget" && rest.length > 0) {
          const names = rest.length === 1 && rest[0] === "all" ? [...live.keys()] : rest;
          const outcomes = await forget(names);
          context.ui.notify(outcomes.map(outcomeLine).join("\n") || "No Secrets are held", "info");
          return;
        }
        context.ui.notify("Usage: /secret [list | forget <NAME…> | forget all]", "info");
      },
    });
  };
}
