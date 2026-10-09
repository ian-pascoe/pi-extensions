import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
  ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import type { LspSettingsDocumentInput } from "../src/pi-lsp-settings.js";
import { createPiLspExtension, type PiLspLifecycleEffects } from "../src/pi-lsp-extension.js";

/** The lifecycle events this harness delivers to the extension. */
type HarnessEvent =
  | ToolCallEvent
  | ToolResultEvent
  | { readonly type: "session_start"; readonly reason: "startup" }
  | { readonly type: "session_shutdown"; readonly reason: "quit" };
type Handler = (
  event: HarnessEvent,
  context: ExtensionContext,
) => Promise<ToolResultEventResult | undefined> | undefined;

/** One native `edit` call: replace `oldText` with `newText` in `path` (relative to the session's cwd). */
export interface EditCall {
  readonly toolCallId: string;
  readonly path: string;
  readonly oldText: string;
  readonly newText: string;
}

/** An `edit` call whose `tool_call` has run and whose file change and `tool_result` have not. */
export interface PendingEdit {
  /** Change the file, then deliver the `tool_result`; resolves to the text appended to the result. */
  finish(): Promise<string>;
}

/** One whole-file mutation call: set `path` (relative to the session's cwd) to `content`. */
export interface WriteCall {
  readonly toolCallId: string;
  readonly path: string;
  readonly content: string;
}

/** An extension instance driven through Pi's `tool_call` and `tool_result` events in a temporary project. */
export interface ExtensionSession {
  readonly cwd: string;
  /** Deliver an `edit` call's `tool_call` now and the rest of the call when `finish` runs. */
  beginEdit(call: EditCall): Promise<PendingEdit>;
  /** Run one `edit` call to completion and return the text appended to its result. */
  edit(call: EditCall): Promise<string>;
  /** Run one native `write` call to completion and return the text appended to its result. */
  write(call: WriteCall): Promise<string>;
  /** Run one Codex-style `apply_patch` call that rewrites a file; return the text appended to its result. */
  applyPatch(call: WriteCall): Promise<string>;
}

export interface ExtensionSessionOptions {
  /** Project files by path relative to the cwd. */
  readonly files: Readonly<Record<string, string>>;
  /** The `lsp` key of the global settings. */
  readonly lspSettings: NonNullable<
    Extract<LspSettingsDocumentInput, { readonly lsp?: unknown }>["lsp"]
  >;
  readonly effects?: Omit<PiLspLifecycleEffects, "getAgentDirectory">;
}

const temporaryDirectories: string[] = [];
const shutdowns: Array<() => Promise<ToolResultEventResult | undefined>> = [];

/** Shut down every started session and remove its temporary directories. */
export async function closeExtensionSessions(): Promise<void> {
  await Promise.all(shutdowns.splice(0).map((shutdown) => shutdown()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
}

/** Drive the extension factory exactly as Pi does, in a fresh temporary project. */
export async function startExtensionSession(
  options: ExtensionSessionOptions,
): Promise<ExtensionSession> {
  const cwd = await mkdtemp(resolve(tmpdir(), "pi-lsp-session-"));
  const agentDirectory = await mkdtemp(resolve(tmpdir(), "pi-lsp-session-agent-"));
  temporaryDirectories.push(cwd, agentDirectory);
  for (const [name, text] of Object.entries(options.files)) {
    await mkdir(dirname(resolve(cwd, name)), { recursive: true });
    await writeFile(resolve(cwd, name), text);
  }
  await writeFile(
    resolve(agentDirectory, "settings.json"),
    JSON.stringify({ lsp: options.lspSettings }),
  );

  const handlers = new Map<string, Handler>();
  const pi = {
    registerTool: () => undefined,
    registerCommand: () => undefined,
    registerEntryRenderer: () => undefined,
    appendEntry: () => undefined,
    on: (name: string, handler: Handler) => void handlers.set(name, handler),
  };
  await createPiLspExtension({ ...options.effects, getAgentDirectory: () => agentDirectory })(
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: The extension registers only the members above on this test double.
    pi as unknown as ExtensionAPI,
  );
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: The extension reads only these members from the context.
  const context = {
    cwd,
    signal: undefined,
    isProjectTrusted: () => false,
    ui: { notify: () => undefined },
    sessionManager: { getSessionDir: () => agentDirectory, getBranch: () => [] },
  } as unknown as ExtensionContext;
  const emit = async (event: HarnessEvent): Promise<ToolResultEventResult | undefined> =>
    await handlers.get(event.type)?.(event, context);
  await emit({ type: "session_start", reason: "startup" });
  shutdowns.push(async () => await emit({ type: "session_shutdown", reason: "quit" }));

  const beginEdit = async ({
    toolCallId,
    path,
    oldText,
    newText,
  }: EditCall): Promise<PendingEdit> => {
    const filePath = resolve(cwd, path);
    const input = { path: filePath, edits: [{ oldText, newText }] };
    const blocked = await emit({ type: "tool_call", toolCallId, toolName: "edit", input });
    // The handler never blocks or alters the call.
    if (blocked !== undefined) throw new Error("Expected the tool_call handler to return nothing");
    return {
      async finish() {
        await writeFile(filePath, (await readFile(filePath, "utf8")).replace(oldText, newText));
        const result = await emit({
          type: "tool_result",
          toolCallId,
          toolName: "edit",
          input,
          content: [{ type: "text", text: `Edited ${path}` }],
          details: undefined,
          isError: false,
        });
        return (result?.content ?? [])
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("");
      },
    };
  };
  const appendedText = (result: ToolResultEventResult | undefined): string =>
    (result?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
  /** Deliver a whole-file call's `tool_call`, write the file, then deliver its `tool_result`. */
  const runWholeFileCall = async (
    toolName: "write" | "apply_patch",
    { toolCallId, path, content }: WriteCall,
  ): Promise<string> => {
    const filePath = resolve(cwd, path);
    const input = toolName === "write" ? { path: filePath, content } : { input: content };
    const blocked = await emit({ type: "tool_call", toolCallId, toolName, input });
    if (blocked !== undefined) throw new Error("Expected the tool_call handler to return nothing");
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
    const details =
      toolName === "write"
        ? undefined
        : {
            status: "success",
            result: {
              changedFiles: [filePath],
              createdFiles: [],
              deletedFiles: [],
              movedFiles: [],
            },
          };
    return appendedText(
      await emit({
        type: "tool_result",
        toolCallId,
        toolName,
        input,
        content: [{ type: "text", text: `Wrote ${path}` }],
        details,
        isError: false,
      }),
    );
  };
  return {
    cwd,
    beginEdit,
    async edit(call) {
      return await (await beginEdit(call)).finish();
    },
    write: (call) => runWholeFileCall("write", call),
    applyPatch: (call) => runWholeFileCall("apply_patch", call),
  };
}
