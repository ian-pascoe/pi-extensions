// Offline external mise process: acquisitions publish runnable formatter fixtures.
const {
  chmodSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  copyFileSync,
  readFileSync,
} = require("node:fs");
const { join, delimiter } = require("node:path");
const [command, ...args] = process.argv.slice(2);
const tools = args.filter((arg) => arg !== "--json");
const controlPath = join(process.cwd(), "..", "fixture.json");
const control = existsSync(controlPath) ? JSON.parse(readFileSync(controlPath, "utf8")) : {};
function directory(tool) {
  if (tool.includes("@path:")) return tool.slice(tool.indexOf("@path:") + 6);
  return join(process.env.MISE_DATA_DIR, "installs", Buffer.from(tool).toString("hex"));
}
if (command === "latest") console.log(control.version ?? "1.0.0");
else if (command === "install") {
  while (control.wait && !existsSync(join(process.cwd(), "..", "release"))) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  if (control.fail) throw new Error("Fixture acquisition failed");
  for (const tool of tools) {
    const path = directory(tool);
    mkdirSync(join(path, "bin"), { recursive: true });
    if (tool.startsWith("core:node@")) {
      mkdirSync(join(path, "bin"), { recursive: true });
      const node = join(path, process.platform === "win32" ? "node.exe" : "bin/node");
      if (!existsSync(node)) copyFileSync(process.execPath, node);
    } else if (tool.startsWith("npm:prettier-plugin-")) {
      const match = tool.match(/^npm:(prettier-plugin-(svelte|astro))@(.+)$/);
      const plugin = join(path, "node_modules", match[1]);
      mkdirSync(plugin, { recursive: true });
      writeFileSync(
        join(plugin, "package.json"),
        JSON.stringify({
          name: match[1],
          version: match[3],
          main: "plugin.js",
          peerDependencies: { prettier: "^3.0.0", [match[2]]: control.frameworkRange ?? "^5.0.0" },
        }),
      );
      writeFileSync(join(plugin, "plugin.js"), "module.exports={}");
    } else if (tool.startsWith("npm:")) {
      const entry = tool.startsWith("npm:prettier@")
        ? "prettier/bin/prettier.cjs"
        : "@biomejs/biome/bin/biome";
      const script = join(path, "node_modules", entry);
      mkdirSync(require("node:path").dirname(script), { recursive: true });
      writeFileSync(
        script,
        tool.startsWith("npm:prettier@")
          ? "require('node:fs').appendFileSync(process.argv.at(-1), ':managed')"
          : `require(${JSON.stringify(join(__dirname, "biome.cjs"))})('managed')`,
      );
    } else {
      const native = (name) => (process.platform === "win32" ? `${name}.exe` : name);
      const launch = tool.startsWith("pipx:black@")
        ? [
            process.platform === "win32" ? "black/Scripts/python.exe" : "black/bin/python",
            ["-m", "black"],
          ]
        : tool.startsWith("aqua:astral-sh/ruff@")
          ? [join("bin", native("ruff")), ["format"]]
          : tool.startsWith("core:go@")
            ? [join("bin", native("gofmt")), ["-w"]]
            : tool.startsWith("core:rust@")
              ? [native("rustfmt"), ["--config", "skip_children=true"]]
              : tool.startsWith("aqua:mvdan/sh@")
                ? [join("bin", native("shfmt")), ["-w"]]
                : tool.startsWith("aqua:hashicorp/terraform@")
                  ? [join("bin", native("terraform")), ["fmt"]]
                  : tool.startsWith("core:deno@")
                    ? [join("bin", native("deno")), ["fmt"]]
                    : undefined;
      if (launch) {
        const command = join(path, launch[0]);
        mkdirSync(require("node:path").dirname(command), { recursive: true });
        writeFileSync(command, "offline native executable boundary");
        chmodSync(command, 0o755);
        writeFileSync(
          `${command}.cjs`,
          `const args=process.argv.slice(2);if(JSON.stringify(args.slice(0,-1))!==${JSON.stringify(JSON.stringify(launch[1]))})throw new Error('wrong native formatter argv');require('node:fs').appendFileSync(args.at(-1),':managed');`,
        );
      }
    }
  }
} else if (command === "where") console.log(directory(tools[0]));
else if (command === "env")
  console.log(
    JSON.stringify({
      PATH: [...tools.map((tool) => join(directory(tool), "bin")), process.env.PATH].join(
        delimiter,
      ),
    }),
  );
else throw new Error(`Unexpected external mise operation: ${command}`);
