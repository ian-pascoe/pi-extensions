// External mise stand-in. Actual ToolInstaller performs locking, resolution and publication.
// Installed entrypoints use the sibling packages' real protocol fixtures.
const fs = require("node:fs");
const { dirname, join, delimiter } = require("node:path");
const [command, ...args] = process.argv.slice(2);
const control = JSON.parse(fs.readFileSync(join(process.cwd(), "..", "fixture.json"), "utf8"));
const tools = args.filter((arg) => arg !== "--json");
function directory(tool) {
  const at = tool.lastIndexOf("@");
  return join(
    process.env.MISE_DATA_DIR,
    "installs",
    Buffer.from(tool.slice(0, at)).toString("hex"),
    tool.slice(at + 1),
  );
}
function script(path, content) {
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, content);
}
if (command === "latest") console.log(control.version ?? "7.0.2");
else if (command === "where") console.log(directory(tools[0]));
else if (command === "env")
  console.log(
    JSON.stringify({
      PATH: [...tools.map((tool) => join(directory(tool), "bin")), process.env.PATH].join(
        delimiter,
      ),
      PI_DAP_FIXTURE: control.dapFixture,
    }),
  );
else if (command === "install") {
  for (const tool of tools) {
    const path = directory(tool);
    fs.mkdirSync(join(path, "bin"), { recursive: true });
    if (tool.startsWith("core:node@")) {
      const node = join(path, process.platform === "win32" ? "node.exe" : "bin/node");
      if (!fs.existsSync(node)) fs.copyFileSync(process.execPath, node);
      fs.chmodSync(node, 0o755);
    } else if (tool.startsWith("npm:typescript@")) {
      script(
        join(path, "node_modules/typescript/bin/tsc"),
        `import(${JSON.stringify(control.server)});\n`,
      );
    } else if (tool.startsWith("npm:prettier@")) {
      script(
        join(path, "node_modules/prettier/bin/prettier.cjs"),
        "require('node:fs').appendFileSync(process.argv.at(-1), '// formatted-by-managed-prettier\\n');\n",
      );
    } else if (tool.startsWith("github:microsoft/vscode-js-debug[")) {
      script(join(path, "src/dapDebugServer.js"), `import(${JSON.stringify(control.adapter)});\n`);
    } else throw new Error(`Unexpected fixture tool ${tool}`);
  }
} else throw new Error(`Unexpected mise command ${command}`);
