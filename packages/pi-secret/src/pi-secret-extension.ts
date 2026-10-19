import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { sep } from "node:path";
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
  holdSecret,
  redactSecrets,
  resolveSecret,
  revokeSecret,
  SECRET_NAME_PATTERN,
  secretReference,
  type SecretOwner,
} from "@ian-pascoe/pi-utils/secret-registry";
import { noticeText } from "@ian-pascoe/pi-utils/ui";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { SecretDialog, type SecretDialogResult } from "./secret-dialog.js";
import { renderSecretCall, renderSecretResult } from "./secret-render.js";
import {
  isSecretName,
  referencedSecretNames,
  resolvePlaceholders,
  secretEnvName,
} from "./secret-references.js";
import { DEFAULT_LIFETIME_MINUTES, readSecretSettings } from "./secret-settings.js";
import { keyFilePath, SealedSecretSchema, SecretVault, type SealedSecret } from "./secret-vault.js";
import { TROUBLESHOOTING_HINT } from "./troubleshooting-skill.js";

/** Custom session entry type holding one Secret's ciphertext. */
export const SECRET_ENTRY_TYPE = "pi-secret";

/** Static system prompt lines, so they never move the cache prefix within a session. */
export const SECRET_PROMPT_SNIPPET =
  "Ask the user for Secrets such as API keys and passwords; values never reach you";
export const SECRET_PROMPT_GUIDELINES = [
  "When a task needs a Secret such as an API key or password, call secret_ask instead of asking the user to paste it into the conversation.",
  "Use a held Secret as $PI_SECRET_NAME in shell commands, which keeps it off the command line, and as {{secret:NAME}} in other tool arguments. Tool output shows {{secret:NAME}} where a value was redacted.",
];

const SECRET_TOOLS: readonly string[] = ["secret_ask", "secret_list", "secret_forget"];

export interface PiSecretOptions {
  /** Pi's agent directory, which holds the key file; tests isolate it. */
  getAgentDirectory?: () => string;
  /** Milliseconds since the epoch; tests pass the Secret Lifetime instantly. */
  now?: () => number;
}

interface LiveSecret {
  readonly name: string;
  readonly value: string;
  readonly keyId: string;
  readonly expiresAt: number;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** One Secret's outcome in a tool result; a type alias so it is assignable to JSON. */
type SecretOutcome = {
  name: string;
  status: "provided" | "skipped" | "cancelled" | "held" | "forgotten" | "not_held";
  reference?: string;
  env?: string;
  expires_at?: string;
};

const SecretNameSchema = Type.String({
  pattern: SECRET_NAME_PATTERN.source,
  description: "Secret Name in environment-variable style, such as OPENCODE_API_KEY",
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

const ForgetParameters = Type.Object({
  names: Type.Array(SecretNameSchema, {
    minItems: 1,
    uniqueItems: true,
    description: "Secret Names to forget now, before their lifetime ends",
  }),
});

const WITHHELD_RESULT =
  "Pi Secret could not check this tool result for Secret values, so it was withheld. The tool did run.";

function iso(time: number): string {
  return new Date(time).toISOString();
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
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

function outcomeLine(outcome: SecretOutcome): string {
  switch (outcome.status) {
    case "provided":
      return `${outcome.name}: provided. Use ${outcome.env === undefined ? "" : `$${outcome.env} in shell commands and `}${outcome.reference} in other tool arguments. Expires ${outcome.expires_at}.`;
    case "held":
      return outcome.expires_at === undefined
        ? `${outcome.name}: held by another session in this process. Use $${outcome.env} or ${outcome.reference}.`
        : `${outcome.name}: held until ${outcome.expires_at}. Use $${outcome.env} or ${outcome.reference}.`;
    case "skipped":
      return `${outcome.name}: skipped by the user.`;
    case "cancelled":
      return `${outcome.name}: not provided; the user cancelled the Secret Request.`;
    case "forgotten":
      return `${outcome.name}: forgotten.`;
    case "not_held":
      return `${outcome.name}: not held by this session.`;
  }
}

function outcomeResult(outcomes: SecretOutcome[], lead?: string) {
  const lines = outcomes.map(outcomeLine);
  const text = lead === undefined ? lines.join("\n") : [lead, ...lines].join("\n");
  const details = { secrets: outcomes };
  return {
    content: [{ type: "text" as const, text }],
    details,
    structuredContent: structuredClone(details),
  };
}

/** Compose Pi Secret with an injectable agent directory and clock. */
export function createPiSecretExtension(options: PiSecretOptions = {}): ExtensionFactory {
  const getAgentDirectory = options.getAgentDirectory ?? getAgentDir;
  const now = options.now ?? Date.now;

  return (pi: ExtensionAPI) => {
    const owner: SecretOwner = { description: "pi-secret" };
    const live = new Map<string, LiveSecret>();
    let lifetimeMinutes = DEFAULT_LIFETIME_MINUTES;
    let generation = 0;
    const vault = () => new SecretVault(keyFilePath(getAgentDirectory()), now);

    /** Stop holding one Secret here; its key is left for the caller to destroy or keep. */
    function release(name: string): LiveSecret | undefined {
      const secret = live.get(name);
      if (secret === undefined) return undefined;
      live.delete(name);
      clearTimeout(secret.timer);
      revokeSecret(name, owner);
      const env = secretEnvName(name);
      if (process.env[env] === secret.value) Reflect.deleteProperty(process.env, env);
      return secret;
    }

    async function expire(name: string, keyId: string): Promise<void> {
      if (live.get(name)?.keyId !== keyId) return;
      release(name);
      // A key that cannot be deleted now is swept at the next session start.
      await vault()
        .destroy([keyId])
        .catch(() => {});
    }

    function adopt(name: string, value: string, keyId: string, expiresAt: number): void {
      release(name);
      const timer = setTimeout(() => void expire(name, keyId), Math.max(0, expiresAt - now()));
      timer.unref();
      live.set(name, { name, value, keyId, expiresAt, timer });
      holdSecret(name, value, owner, expiresAt);
      process.env[secretEnvName(name)] = value;
    }

    /** End every Secret whose lifetime has passed, as its timer would. */
    async function expireDue(): Promise<void> {
      const due = [...live.values()].filter((secret) => secret.expiresAt <= now());
      for (const secret of due) await expire(secret.name, secret.keyId);
    }

    function releaseAll(): void {
      // Deleting the visited entry while iterating a Map is safe.
      for (const name of live.keys()) release(name);
    }

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
      if (warning !== undefined) warn(warning);
      const latest = new Map<string, SealedSecret>();
      for (const entry of context.sessionManager.getBranch()) {
        if (entry.type !== "custom" || entry.customType !== SECRET_ENTRY_TYPE) continue;
        if (Value.Check(SealedSecretSchema, entry.data)) latest.set(entry.data.name, entry.data);
      }
      try {
        await vault().destroy([]);
      } catch (cause) {
        warn(`cannot delete expired Secret keys: ${errorMessage(cause)}`);
      }
      // Each Secret is restored on its own, so one unreadable entry cannot hide the others.
      for (const sealed of latest.values()) {
        let value: string | undefined;
        try {
          value = await vault().open(sealed);
        } catch (cause) {
          warn(`cannot restore Secret ${sealed.name}: ${errorMessage(cause)}`);
        }
        if (current !== generation) return;
        if (value !== undefined) adopt(sealed.name, value, sealed.keyId, sealed.expiresAt);
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
      if (names.size === 0) return undefined;
      const missing = [...names].filter(
        (name) => !isSecretName(name) || resolveSecret(name) === undefined,
      );
      if (missing.length > 0) {
        const listed = missing.map((name) => secretReference(name)).join(", ");
        return {
          block: true,
          reason: `The call did not run: it references ${listed}, which this session does not hold. The Secret expired, was forgotten, or was never provided. Call secret_ask to request it again.`,
        };
      }
      // Pi passes the same arguments object on to the tool: resolve in place.
      Object.assign(
        input,
        resolvePlaceholders(input, (name) => resolveSecret(name) ?? ""),
      );
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
          throw new Error(
            `secret_ask needs Pi's interactive terminal, where values are entered in a masked prompt; it is unavailable in print, JSON, and RPC modes and in Child Agents. Ask the user how they want to provide the Secret.\n\n${TROUBLESHOOTING_HINT}`,
          );
        const reason = params.reason?.trim() === "" ? undefined : params.reason;
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
          return outcomeResult(
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
          const replaced = release(name);
          if (replaced !== undefined) await vault().destroy([replaced.keyId]);
          adopt(name, value, sealed.keyId, expiresAt);
          outcomes.push({
            name,
            status: "provided",
            reference: secretReference(name),
            env: secretEnvName(name),
            expires_at: iso(expiresAt),
          });
        }
        return outcomeResult(outcomes);
      },
    });

    const list = defineTool({
      name: "secret_list",
      label: "Secret List",
      description:
        "List the Secrets this session can use and when each expires; never their values.",
      parameters: Type.Object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      renderCall: (_params, theme, context) => renderSecretCall("secret_list", {}, theme, context),
      renderResult: (result, options, theme, context) =>
        renderSecretResult(result, options, theme, context),
      async execute() {
        await expireDue();
        const outcomes: SecretOutcome[] = heldSecretNames()
          .toSorted()
          .map((name) => {
            const own = live.get(name);
            const outcome: SecretOutcome = {
              name,
              status: "held",
              reference: secretReference(name),
              env: secretEnvName(name),
            };
            if (own !== undefined) outcome.expires_at = iso(own.expiresAt);
            return outcome;
          });
        return outcomeResult(
          outcomes,
          outcomes.length === 0
            ? "No Secrets are held. Call secret_ask to request one."
            : undefined,
        );
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
        destroyed.push(released.keyId);
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
      description: "Forget Secrets now, before their lifetime ends.",
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
        return outcomeResult(await forget(params.names));
      },
    });

    pi.registerTool(acceptNullForOptionalArguments(ask));
    pi.registerTool(acceptNullForOptionalArguments(list));
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
            .map((secret) => `${secret.name}: expires ${iso(secret.expiresAt)}`);
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
