// External acquisition executable. The real ToolInstaller owns locking and publication.
const fs = require("node:fs");
const { dirname, join, delimiter } = require("node:path");
const [command, ...args] = process.argv.slice(2);
const controlPath = join(process.cwd(), "..", "fixture.json");
const readControl = () => JSON.parse(fs.readFileSync(controlPath, "utf8"));
const tools = args.filter((argument) => argument !== "--json");
function directory(tool) {
  const at = tool.lastIndexOf("@");
  const version = tool.slice(at + 1);
  if (version.startsWith("path:")) return version.slice(5);
  return join(
    process.env.MISE_DATA_DIR,
    "installs",
    Buffer.from(tool.slice(0, at)).toString("hex"),
    version,
  );
}
function script(path, content) {
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, content);
}
function binary(path) {
  fs.mkdirSync(dirname(path), { recursive: true });
  if (!fs.existsSync(path)) fs.copyFileSync(process.execPath, path);
  fs.chmodSync(path, 0o755);
}
function run() {
  const control = readControl();
  if (control.fail && tools.some((tool) => tool.includes(control.fail))) {
    process.stderr.write("fixture registry unavailable\n");
    process.exit(1);
  }
  if (command === "latest") console.log(control.version ?? "1.0.0");
  else if (command === "where") console.log(directory(tools[0]));
  else if (command === "env")
    console.log(
      JSON.stringify({
        PATH: [...tools.map((tool) => join(directory(tool), "bin")), process.env.PATH].join(
          delimiter,
        ),
        PI_DAP_FIXTURE: control.dapFixture,
        PI_DAP_MANAGED_VERSION: tools.at(-1).slice(tools.at(-1).lastIndexOf("@") + 1),
      }),
    );
  else if (command === "install") {
    for (const tool of tools) {
      const path = directory(tool);
      fs.mkdirSync(join(path, "bin"), { recursive: true });
      if (tool.startsWith("core:node@"))
        binary(join(path, process.platform === "win32" ? "node.exe" : "bin/node"));
      else if (tool.startsWith("core:python@")) {
        binary(join(path, process.platform === "win32" ? "python.exe" : "bin/python"));
        if (process.platform !== "win32") binary(join(path, "bin/python3"));
      } else if (tool.startsWith("github:microsoft/vscode-js-debug["))
        script(
          join(path, "src/dapDebugServer.js"),
          `import(${JSON.stringify(control.adapter)});\n`,
        );
      else if (tool.startsWith("pipx:debugpy@"))
        binary(
          join(
            path,
            process.platform === "win32" ? "debugpy/Scripts/python.exe" : "debugpy/bin/python",
          ),
        );
      else if (!tool.startsWith("aqua:astral-sh/uv@"))
        throw new Error(`Unexpected fixture tool ${tool}`);
    }
  } else throw new Error(`Unexpected mise command ${command}`);
}
if (command === "install" && readControl().wait) {
  process.stderr.write("Waiting for acquisition fixture\n");
  const timer = setInterval(() => {
    if (readControl().wait) return;
    clearInterval(timer);
    run();
  }, 10);
} else run();
