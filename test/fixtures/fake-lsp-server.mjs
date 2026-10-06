// A content-aware fake language server for the combined Formatter + LSP test. It keeps the text of
// every synchronized document and reports a diagnostic whose line and message depend on that text,
// so a result shows whether diagnostics were computed before or after formatting.
import process from "node:process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const documents = new Map();
let input = Buffer.alloc(0);

function send(message) {
  const json = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

function documentText(uri) {
  return documents.get(uri) ?? readFileSync(fileURLToPath(uri), "utf8");
}

/** One diagnostic on the line holding `TODO`; the message says whether the formatter header exists. */
function diagnosticsFor(text) {
  const lines = text.split("\n");
  const line = lines.findIndex((candidate) => candidate.includes("TODO"));
  if (line < 0) return [];
  const formatted = lines[0] === "// formatted";
  return [
    {
      range: { start: { line, character: 0 }, end: { line, character: 4 } },
      severity: 2,
      message: `TODO left in ${formatted ? "formatted" : "unformatted"} source`,
      source: "fake",
    },
  ];
}

/** Rename the `oldName` identifier; the edit targets the text the server last saw. */
function renameEdit(uri, newName) {
  const lines = documentText(uri).split("\n");
  const line = lines.findIndex((candidate) => candidate.includes("oldName"));
  const character = lines[line].indexOf("oldName");
  return {
    changes: {
      [uri]: [
        {
          range: {
            start: { line, character },
            end: { line, character: character + "oldName".length },
          },
          newText: newName,
        },
      ],
    },
  };
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function handleRequest(message) {
  switch (message.method) {
    case "initialize":
      respond(message.id, {
        serverInfo: { name: "combined-fake-lsp", version: "1.0.0" },
        capabilities: {
          positionEncoding: "utf-8",
          renameProvider: true,
          textDocumentSync: { openClose: true, change: 1 },
          diagnosticProvider: {
            identifier: "fake",
            interFileDependencies: false,
            workspaceDiagnostics: false,
          },
        },
      });
      return;
    case "textDocument/diagnostic":
      respond(message.id, {
        kind: "full",
        items: diagnosticsFor(documentText(message.params.textDocument.uri)),
      });
      return;
    case "textDocument/rename":
      respond(message.id, renameEdit(message.params.textDocument.uri, message.params.newName));
      return;
    case "shutdown":
      respond(message.id, null);
      return;
    default:
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `Method not found: ${message.method}` },
      });
  }
}

function handleNotification(message) {
  switch (message.method) {
    case "textDocument/didOpen":
      documents.set(message.params.textDocument.uri, message.params.textDocument.text);
      return;
    case "textDocument/didChange":
      documents.set(message.params.textDocument.uri, message.params.contentChanges.at(-1).text);
      return;
    case "textDocument/didClose":
      documents.delete(message.params.textDocument.uri);
      return;
    case "exit":
      process.exit(0);
  }
}

process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  for (;;) {
    const headerEnd = input.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const length = Number(
      /Content-Length: (\d+)/i.exec(input.subarray(0, headerEnd).toString("ascii"))?.[1],
    );
    const bodyStart = headerEnd + 4;
    if (input.length < bodyStart + length) return;
    const message = JSON.parse(input.subarray(bodyStart, bodyStart + length).toString("utf8"));
    input = input.subarray(bodyStart + length);
    if (message.method === undefined) continue;
    if (message.id !== undefined) handleRequest(message);
    else handleNotification(message);
  }
});
