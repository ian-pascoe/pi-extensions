import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Value } from "typebox/value";

const ObjectSchema = Type.Record(Type.String(), Type.Any());
const PositionSchema = Type.Object({
  line: Type.Integer({ minimum: 1 }),
  offset: Type.Integer({ minimum: 1 }),
});
const TsDiagnosticsSchema = Type.Object({
  body: Type.Array(
    Type.Object({
      message: Type.String(),
      code: Type.Integer(),
      category: Type.String(),
      startLocation: PositionSchema,
      endLocation: PositionSchema,
    }),
  ),
});
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-languageserver-protocol/node";

const [vueScript, sdk, plugin, hostScript] = process.argv.slice(2);
if (!vueScript || !sdk || !plugin || !hostScript)
  throw new Error("Vue bridge requires server, SDK, plugin, and TypeScript host paths");
const parent = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
);
const children = [vueScript, hostScript].map((script) => {
  const process = spawn(
    globalThis.process.execPath,
    [script, "--stdio", ...(script === vueScript ? [`--tsdk=${sdk}`] : [])],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  const connection = createMessageConnection(
    new StreamMessageReader(process.stdout),
    new StreamMessageWriter(process.stdin),
  );
  return { process, connection };
});
const [vue, host] = children;
const commandOwners = new Map();
let stopping = false;
let shutDown = false;
function fail(error) {
  console.error(error);
  void stop(1);
}
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  const force = setTimeout(() => {
    for (const child of children) child.process.kill("SIGKILL");
  }, 1000);
  await Promise.all(
    children.map(async ({ connection, process: child }) => {
      try {
        if (!shutDown) await connection.sendRequest("shutdown");
        await connection.sendNotification("exit");
      } catch {
        child.kill();
      }
    }),
  );
  clearTimeout(force);
  for (const child of children) {
    child.process.kill();
    child.connection.dispose();
  }
  parent.dispose();
  process.stdin.destroy();
  process.exitCode = code;
}
for (const child of children) {
  child.process.once("error", fail);
  child.process.once("exit", (code) => {
    if (!stopping) void stop(code ?? 1);
  });
  child.connection.onRequest((method, params, token) => parent.sendRequest(method, params, token));
  child.connection.onNotification((method, params) => {
    // Unversioned TypeScript pushes can race a newer SFC report. Serve the fresh
    // combined document pull below instead of publishing incomplete diagnostics.
    if (method !== "textDocument/publishDiagnostics" && !method.startsWith("$/"))
      void parent.sendNotification(method, params).catch(fail);
  });
  child.connection.listen();
}
vue.connection.onNotification("tsserver/request", ([id, command, args]) => {
  void host.connection
    .sendRequest("workspace/executeCommand", {
      command: "typescript.tsserverRequest",
      arguments: [command, args, { executionTarget: 0 }],
    })
    .then((response) =>
      vue.connection.sendNotification("tsserver/response", [id, response?.body ?? null]),
    )
    .catch(fail);
});
parent.onRequest(async (method, params, token) => {
  if (method === "initialize") {
    const initialization = Value.Parse(ObjectSchema, params);
    const hostParams = {
      ...initialization,
      initializationOptions: {
        hostInfo: "pi-lsp-vue",
        disableAutomaticTypingAcquisition: true,
        tsserver: { path: join(sdk, "tsserver.js"), useSyntaxServer: "never" },
        plugins: [{ name: "@vue/typescript-plugin", location: plugin, languages: ["vue"] }],
      },
    };
    const [vueResult, hostResult] = await Promise.all([
      vue.connection.sendRequest(method, params, token),
      host.connection.sendRequest(method, hostParams, token),
    ]);
    for (const [owner, result] of [
      [host, hostResult],
      [vue, vueResult],
    ]) {
      const commands = Value.Parse(
        Type.Array(Type.String()),
        result.capabilities.executeCommandProvider?.commands ?? [],
      );
      for (const command of commands)
        if (!commandOwners.has(command)) commandOwners.set(command, owner);
    }
    return {
      ...vueResult,
      capabilities: {
        ...vueResult.capabilities,
        ...hostResult.capabilities,
        positionEncoding: "utf-16",
        executeCommandProvider: { commands: [...commandOwners.keys()] },
        diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: false },
      },
    };
  }
  if (method === "shutdown") {
    await Promise.all(children.map(({ connection }) => connection.sendRequest("shutdown")));
    shutDown = true;
    return null;
  }
  if (method === "textDocument/diagnostic") {
    const input = Value.Parse(ObjectSchema, params);
    const file = fileURLToPath(input.textDocument.uri);
    const reports = await Promise.all(
      ["syntacticDiagnosticsSync", "semanticDiagnosticsSync"].map(async (command) => {
        const response = await host.connection.sendRequest(
          "workspace/executeCommand",
          {
            command: "typescript.tsserverRequest",
            arguments: [command, { file, includeLinePosition: true }, { executionTarget: 0 }],
          },
          token,
        );
        return Value.Parse(TsDiagnosticsSchema, response).body.map((diagnostic) => ({
          range: {
            start: {
              line: diagnostic.startLocation.line - 1,
              character: diagnostic.startLocation.offset - 1,
            },
            end: {
              line: diagnostic.endLocation.line - 1,
              character: diagnostic.endLocation.offset - 1,
            },
          },
          code: diagnostic.code,
          message: diagnostic.message,
          source: "typescript",
          severity: diagnostic.category === "error" ? 1 : diagnostic.category === "warning" ? 2 : 3,
        }));
      }),
    );
    const vueReport = await vue.connection.sendRequest(method, params, token);
    if (vueReport?.kind !== "full" || !Array.isArray(vueReport.items))
      throw new Error("Vue did not return fresh SFC diagnostics");
    return { kind: "full", items: [...vueReport.items, ...reports.flat()] };
  }
  if (method.endsWith("/resolve") && params?.data?.piVueOwner) {
    const input = Value.Parse(ObjectSchema, params);
    const { piVueOwner, original } = input.data;
    const owner = piVueOwner === "vue" ? vue : host;
    const item = { ...input, data: original };
    return owner.connection.sendRequest(method, item, token);
  }
  if (method === "workspace/executeCommand" && commandOwners.has(params?.command))
    return commandOwners.get(params.command).connection.sendRequest(method, params, token);
  // TypeScript owns semantic operations; Vue owns SFC structure and formatting.
  const first = [
    "textDocument/documentSymbol",
    "textDocument/formatting",
    "textDocument/rangeFormatting",
    "textDocument/foldingRange",
  ].includes(method)
    ? vue
    : host;
  const second = first === vue ? host : vue;
  let result;
  try {
    result = await first.connection.sendRequest(method, params, token);
  } catch (error) {
    if (error.code !== -32601) throw error;
  }
  let owner = first;
  if (result == null || (Array.isArray(result) && result.length === 0)) {
    try {
      result = await second.connection.sendRequest(method, params, token);
      owner = second;
    } catch (error) {
      if (error.code !== -32601) throw error;
    }
  }
  if (
    [
      "textDocument/completion",
      "textDocument/codeAction",
      "textDocument/codeLens",
      "textDocument/documentLink",
      "textDocument/inlayHint",
    ].includes(method)
  ) {
    const items = Array.isArray(result) ? result : result?.items;
    if (Array.isArray(items))
      for (const item of items) {
        item.data = { piVueOwner: owner === vue ? "vue" : "host", original: item.data };
      }
  }
  return result ?? null;
});
parent.onNotification((method, params) => {
  if (method === "exit") {
    void stop();
    return;
  }
  for (const child of children) void child.connection.sendNotification(method, params).catch(fail);
});
parent.onClose(() => {
  void stop();
});
parent.listen();
process.once("SIGTERM", () => {
  void stop();
});
process.once("SIGINT", () => {
  void stop();
});
