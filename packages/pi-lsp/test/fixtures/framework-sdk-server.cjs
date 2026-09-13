const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = require(
  process.env.PI_FRAMEWORK_PROTOCOL,
);
const { join } = require("node:path");
const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
);
let version;
connection.onRequest("initialize", (params) => {
  version =
    process.env.PI_FRAMEWORK_SVELTE === "1"
      ? require("typescript").version
      : require(join(params.initializationOptions.typescript.tsdk, "typescript.js")).version;
  return { capabilities: { textDocumentSync: 1, hoverProvider: true } };
});
connection.onRequest("textDocument/hover", () => ({ contents: `TypeScript SDK ${version}` }));
connection.onRequest("shutdown", () => null);
connection.onNotification("exit", () => process.exit(0));
connection.listen();
