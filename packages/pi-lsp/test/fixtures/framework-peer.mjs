import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  ResponseError,
} from "vscode-languageserver-protocol/node";

const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
);
let owner;
let descendant;
connection.onRequest("initialize", async (params) => {
  owner = params.initializationOptions?.hostInfo === "pi-lsp-vue" ? "host" : "vue";
  if (owner === "host" && process.env.PI_FRAMEWORK_HANG_SHUTDOWN === "1") {
    descendant = spawn(
      process.execPath,
      [
        "-e",
        'process.on("SIGTERM",()=>{});process.stdout.write("ready");setInterval(()=>{},1000);',
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    await once(descendant.stdout, "data");
  }
  return {
    capabilities: {
      textDocumentSync: 1,
      codeActionProvider: { resolveProvider: true },
      executeCommandProvider: { commands: [`${owner}.fix`] },
    },
  };
});
connection.onRequest("textDocument/codeAction", () =>
  owner === "host" ? [] : [{ title: "Vue fix", data: "vue-token" }],
);
connection.onRequest("codeAction/resolve", async (action) => {
  if (owner !== "vue" || action.data !== "vue-token") throw new Error("Wrong resolution owner");
  const edit = {
    changes: {
      [process.env.PI_FRAMEWORK_FIX_URI]: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
          newText: "good",
        },
      ],
    },
  };
  const apply = await connection.sendRequest("workspace/applyEdit", { edit });
  if (apply.applied) throw new Error("Mutation bypassed preview");
  return { ...action, edit, command: { title: "Vue fix", command: "vue.fix", arguments: [edit] } };
});
connection.onRequest("workspace/executeCommand", async (params) => {
  if (params.command !== `${owner}.fix`) throw new ResponseError(-32602, "Wrong command owner");
  const apply = await connection.sendRequest("workspace/applyEdit", { edit: params.arguments[0] });
  if (apply.applied) throw new Error("Command bypassed preview");
  return null;
});
connection.onRequest("fixture/descendant", () => descendant?.pid);
connection.onRequest("shutdown", () => (descendant ? new Promise(() => {}) : null));
connection.onNotification("exit", () => process.exit(0));
connection.listen();
