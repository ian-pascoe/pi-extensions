import process from "node:process";

let input = Buffer.alloc(0);
let nextRequestId = 1000;
const pendingServerRequests = new Map();
const cancelledRequests = new Set();
const state = {
  initializationOptions: null,
  settingsNotifications: [],
  opened: [],
  changed: [],
  saved: [],
  closed: [],
  cancellations: 0,
  configuration: null,
  workspaceFolders: null,
  progressCreated: false,
  diagnosticsRefreshed: false,
  applyEdit: null,
};
let clientRequestsReady = Promise.resolve();

function send(message) {
  const json = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

function sendRequest(method, params) {
  const id = nextRequestId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve, reject) => pendingServerRequests.set(id, { resolve, reject }));
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function diagnostics(message = "fake diagnostic") {
  return process.env.FAKE_DIAGNOSTICS === "one"
    ? [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          severity: 1,
          message,
          source: "fake",
        },
      ]
    : [];
}

async function exerciseClientRequests() {
  const results = await Promise.all([
    sendRequest("workspace/configuration", {
      items: [{ section: "typescript.preferences" }, {}],
    }),
    sendRequest("workspace/workspaceFolders"),
    sendRequest("window/workDoneProgress/create", { token: "fake-progress" }),
    sendRequest("client/registerCapability", {
      registrations: [{ id: "fake-folding", method: "textDocument/foldingRange" }],
    }),
    sendRequest("workspace/diagnostic/refresh"),
    sendRequest("workspace/applyEdit", {
      label: "fake edit",
      edit: {
        changes: {
          "file:///fake.ts": [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              newText: "fake",
            },
          ],
        },
      },
    }),
  ]);
  state.configuration = results[0];
  state.workspaceFolders = results[1];
  state.progressCreated = results[2] === null;
  state.diagnosticsRefreshed = results[4] === null;
  state.applyEdit = results[5];
  send({
    jsonrpc: "2.0",
    method: "window/logMessage",
    params: { type: 3, message: "fake server ready" },
  });
}

async function handleRequest(message) {
  switch (message.method) {
    case "initialize":
      state.initializationOptions = message.params?.initializationOptions ?? null;
      const capabilities = {
        positionEncoding: "utf-8",
        renameProvider: { prepareProvider: true },
        textDocumentSync: { openClose: true, change: 2, save: { includeText: true } },
        hoverProvider: true,
      };
      if (process.env.FAKE_NO_PULL !== "1") {
        capabilities.diagnosticProvider = {
          identifier: "fake",
          interFileDependencies: false,
          workspaceDiagnostics: true,
        };
      }
      respond(message.id, {
        serverInfo: { name: "pi-lsp-fake", version: "1.0.0" },
        capabilities,
      });
      return;
    case "textDocument/diagnostic":
      if (process.env.FAKE_DELAY_DIAGNOSTICS === "1") return;
      respond(message.id, {
        kind: "full",
        resultId: "fake-document-result",
        items: diagnostics(),
      });
      return;
    case "workspace/diagnostic":
      if (process.env.FAKE_DELAY_DIAGNOSTICS === "1") return;
      respond(message.id, {
        items: state.opened.map((document) => ({
          uri: document.uri,
          version: document.version,
          kind: "full",
          resultId: "fake-workspace-result",
          items: diagnostics(),
        })),
      });
      return;
    case "fake/delay":
      return;
    case "fake/publishDiagnostics":
      send({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: {
          uri: message.params.uri,
          version: message.params.version,
          diagnostics: diagnostics("unsynchronized diagnostic"),
        },
      });
      respond(message.id, null);
      return;
    case "fake/state":
      await clientRequestsReady;
      respond(message.id, state);
      return;
    case "shutdown":
      respond(message.id, null);
      return;
    default:
      respondError(message.id, -32601, `Method not found: ${message.method}`);
  }
}

function publishDiagnostics(document) {
  if (process.env.FAKE_PUSH === "none") return;
  if (process.env.FAKE_STALE_PUSH === "1" || process.env.FAKE_STALE_PUSH === "only") {
    send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: document.uri,
        version: document.version - 1,
        diagnostics: diagnostics("stale diagnostic"),
      },
    });
    if (process.env.FAKE_STALE_PUSH === "only") return;
    setTimeout(
      () =>
        send({
          jsonrpc: "2.0",
          method: "textDocument/publishDiagnostics",
          params: {
            uri: document.uri,
            version: document.version,
            diagnostics: diagnostics("fresh diagnostic"),
          },
        }),
      10,
    );
    return;
  }
  send({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: { uri: document.uri, version: document.version, diagnostics: diagnostics() },
  });
}

function handleNotification(message) {
  switch (message.method) {
    case "initialized":
      clientRequestsReady = exerciseClientRequests();
      return;
    case "workspace/didChangeConfiguration":
      state.settingsNotifications.push(message.params?.settings ?? null);
      return;
    case "textDocument/didOpen":
      state.opened.push(message.params.textDocument);
      publishDiagnostics(message.params.textDocument);
      return;
    case "textDocument/didChange": {
      const document = message.params.textDocument;
      state.changed.push({ ...document, contentChanges: message.params.contentChanges });
      publishDiagnostics(document);
      return;
    }
    case "textDocument/didSave":
      state.saved.push(message.params);
      return;
    case "textDocument/didClose":
      state.closed.push(message.params.textDocument);
      return;
    case "$/cancelRequest":
      state.cancellations++;
      cancelledRequests.add(message.params.id);
      respondError(message.params.id, -32800, "Request cancelled");
      return;
    case "exit":
      process.exit(0);
  }
}

function handleMessage(message) {
  if (message.method !== undefined) {
    if (message.id !== undefined) void handleRequest(message);
    else handleNotification(message);
    return;
  }
  const pending = pendingServerRequests.get(message.id);
  if (pending === undefined) return;
  pendingServerRequests.delete(message.id);
  if (message.error !== undefined) pending.reject(new Error(message.error.message));
  else pending.resolve(message.result);
}

function parseInput() {
  while (true) {
    const headerEnd = input.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = input.subarray(0, headerEnd).toString("ascii");
    const lengthMatch = /Content-Length: (\d+)/i.exec(header);
    if (lengthMatch === null) process.exit(2);
    const length = Number(lengthMatch[1]);
    const bodyStart = headerEnd + 4;
    if (input.length < bodyStart + length) return;
    const body = input.subarray(bodyStart, bodyStart + length).toString("utf8");
    input = input.subarray(bodyStart + length);
    handleMessage(JSON.parse(body));
  }
}

process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  parseInput();
});

const stderrBytes = Number(process.env.FAKE_STDERR_BYTES ?? "0");
if (stderrBytes > 0) {
  process.stderr.write(`${"x".repeat(stderrBytes)}END`);
}
