import { parseArgs } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { LspServerManager, LspServerStatusEntry } from "./lsp-server-manager.js";
import { LSP_PRESETS } from "./lsp-presets.js";

/** One user-selected lifecycle action; startup remains lazy. */
export type LspCommand =
  | { readonly action: "update"; readonly serverId?: string }
  | { readonly action: "cancel-update" }
  | { readonly action: "stop"; readonly serverId: string; readonly rootPath?: string }
  | {
      readonly action: "enable" | "disable";
      readonly serverId: string;
      readonly scope: "session" | "global" | "project";
    };

type CommandStatusManager = Pick<LspServerManager, "getStatus" | "getEnablement">;

/** Use the same known Instance roots for completion and Stop target selection. */
export function knownLspServerRoots(manager: CommandStatusManager, serverId: string): string[] {
  return manager
    .getStatus()
    .servers.filter((server) => server.serverId === serverId)
    .flatMap((server) => (server.rootPath === undefined ? [] : [server.rootPath]));
}

/** Keep headless command feedback off stdout's JSON event stream and out of model context. */
export function notifyLspCommand(
  context: ExtensionContext,
  message: string,
  level: "info" | "warning" | "error",
): void {
  if (context.hasUI) context.ui.notify(message, level);
  else process.stderr.write(`${message}\n`);
}

function statusLabel(server: LspServerStatusEntry, manager: CommandStatusManager): string {
  const enablement = manager.getEnablement(server.serverId);
  return `${server.serverId} — ${server.state}${server.rootPath === undefined ? "" : ` — ${server.rootPath}`} — ${enablement.enabled ? "enabled" : "disabled"} (${enablement.scope})${server.error === undefined ? "" : ` — ${server.error}`}`;
}

/** Render command status without triggering lazy startup. */
export function formatLspCommandStatus(manager: CommandStatusManager): string {
  const status = manager.getStatus();
  return [
    status.servers.length === 0 ? "Pi LSP: no configured Server Definitions." : "Pi LSP:",
    ...status.servers.map((server) => statusLabel(server, manager)),
    ...status.warnings,
  ].join("\n");
}

/** Choose a known Server Instance or definition-wide toggle using Pi's native dialogs. */
export async function selectLspCommand(
  manager: CommandStatusManager,
  context: ExtensionContext,
  isCurrent: () => boolean,
): Promise<LspCommand | undefined> {
  const rows = new Map(
    manager.getStatus().servers.map((server) => [statusLabel(server, manager), server]),
  );
  if (rows.size === 0) {
    notifyLspCommand(context, "Pi LSP: no configured Server Definitions.", "info");
    return undefined;
  }
  const selected = await context.ui.select("Pi LSP: select a server", [...rows.keys()]);
  if (selected === undefined || !isCurrent()) return undefined;
  const server = rows.get(selected);
  if (server === undefined) return undefined;
  const actions =
    server.rootPath === undefined ? ["enable", "disable"] : ["stop", "enable", "disable"];
  const action = await context.ui.select(
    `${server.serverId}: stop this root, or enable/disable all roots`,
    actions,
  );
  if (action === undefined || !isCurrent()) return undefined;
  if (action === "stop" && server.rootPath !== undefined)
    return { action, serverId: server.serverId, rootPath: server.rootPath };
  if (action !== "enable" && action !== "disable") return undefined;
  const scope = await context.ui.select(`${action} ${server.serverId}: scope`, [
    "session",
    "project",
    "global",
  ]);
  if (!isCurrent() || (scope !== "session" && scope !== "project" && scope !== "global"))
    return undefined;
  return { action, serverId: server.serverId, scope };
}

function quoteCommandToken(value: string, preferred?: string): string {
  if (preferred === "'") return `'${value.replaceAll("'", "'\\''")}'`;
  return preferred === '"' || /[\s"'\\]/u.test(value)
    ? `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    : value;
}

/** Complete action names, configured server IDs, known roots, and explicit persistence scopes. */
export function completeLspCommandArguments(
  prefix: string,
  manager: CommandStatusManager | undefined,
): AutocompleteItem[] | null {
  const normalized = prefix.trimStart();
  const actionMatch = /^(stop|enable|disable|update)\s+/u.exec(normalized);
  let candidates: AutocompleteItem[] = [];
  if (actionMatch === null) {
    candidates = ["stop", "enable", "disable", "update"].map((value) => ({ value, label: value }));
  } else if (actionMatch[1] === "update") {
    candidates = ["cancel", ...LSP_PRESETS.map(({ id }) => id)].map((id) => ({
      value: `${actionMatch[0]}${id}`,
      label: id,
    }));
  } else if (manager !== undefined) {
    const actionPrefix = actionMatch[0];
    const argument = normalized.slice(actionPrefix.length);
    const status = manager.getStatus();
    for (const serverId of new Set(status.servers.map((server) => server.serverId))) {
      const id = quoteCommandToken(serverId, argument[0]);
      const serverPrefix = `${actionPrefix}${id}`;
      if (normalized.startsWith(`${serverPrefix} `)) {
        const tail = normalized.slice(serverPrefix.length + 1);
        const values =
          actionMatch[1] === "stop"
            ? knownLspServerRoots(manager, serverId)
            : ["--global", "--project"];
        candidates.push(
          ...values.map((value) => ({
            value: `${serverPrefix} ${quoteCommandToken(value, tail[0])}`,
            label: value,
          })),
        );
      } else {
        const enablement = manager.getEnablement(serverId);
        candidates.push({
          value: serverPrefix,
          label: serverId,
          description: `${enablement.enabled ? "enabled" : "disabled"} (${enablement.scope})`,
        });
      }
    }
  }
  const matches = candidates.filter((item) => item.value.startsWith(normalized));
  return matches.length === 0 ? null : matches;
}

const USAGE =
  "Pi LSP: usage: /lsp stop <server-id> [root] | enable|disable <server-id> [--global|--project] | update [preset-id|cancel]";

function commandTokens(args: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote = "";
  let started = false;
  for (let index = 0; index < args.length; index += 1) {
    const character = args[index] ?? "";
    if (character === "\\" && quote !== "'") {
      const next = args[index + 1];
      if (next === undefined) throw new Error(`${USAGE}\nTrailing escape.`);
      if (/[\s\\"']/u.test(next)) {
        token += next;
        index += 1;
      } else token += character;
    } else if (quote !== "") {
      if (character === quote) quote = "";
      else token += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/u.test(character)) {
      if (started) tokens.push(token);
      token = "";
      started = false;
      continue;
    } else token += character;
    started = true;
  }
  if (quote !== "") throw new Error(`${USAGE}\nUnclosed quote.`);
  if (started) tokens.push(token);
  return tokens;
}

/** Parse lifecycle arguments without shell evaluation, accepting quoted IDs and workspace roots. */
export function parseLspCommandArguments(args: string): LspCommand {
  const { values, positionals, tokens } = parseArgs({
    args: commandTokens(args),
    options: { global: { type: "boolean" }, project: { type: "boolean" } },
    allowPositionals: true,
    strict: true,
    tokens: true,
  });
  const [action, serverId, rootPath, ...rest] = positionals;
  if (action === "update" && rootPath === undefined && !values.global && !values.project) {
    if (serverId === "cancel") return { action: "cancel-update" };
    return serverId === undefined ? { action } : { action, serverId };
  }
  if (
    !serverId ||
    rootPath === "" ||
    rest.length > 0 ||
    tokens.filter((token) => token.kind === "option").length > 1
  ) {
    throw new Error(USAGE);
  }
  if (action === "stop" && !values.global && !values.project) {
    return rootPath === undefined ? { action, serverId } : { action, serverId, rootPath };
  }
  if ((action === "enable" || action === "disable") && rootPath === undefined) {
    return {
      action,
      serverId,
      scope: values.global ? "global" : values.project ? "project" : "session",
    };
  }
  throw new Error(USAGE);
}
