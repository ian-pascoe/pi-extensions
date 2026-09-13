// External acquisition fixture: produce a loadable SDK, not mocked installer methods.
const { mkdirSync, writeFileSync } = require("node:fs");
const { join, delimiter } = require("node:path");
const [command, ...args] = process.argv.slice(2);
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
if (command === "where") console.log(directory(tools[0]));
else if (command === "env")
  console.log(
    JSON.stringify({
      PATH: [...tools.map((tool) => join(directory(tool), "bin")), process.env.PATH].join(
        delimiter,
      ),
    }),
  );
else if (command === "install") {
  for (const tool of tools) {
    if (!tool.startsWith("npm:typescript@")) throw new Error(`Unexpected fixture tool ${tool}`);
    const version = tool.slice(tool.lastIndexOf("@") + 1);
    const root = directory(tool);
    const pkg = join(root, "node_modules", "typescript");
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(pkg, "lib"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "typescript", version }));
    writeFileSync(
      join(pkg, "lib", "typescript.js"),
      `module.exports = { version: ${JSON.stringify(version)} };\n`,
    );
  }
} else throw new Error(`Unexpected fixture command ${command}`);
