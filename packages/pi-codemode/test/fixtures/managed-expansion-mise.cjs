// External acquisition boundary; all selection and coordination remain in ToolInstaller.
const fs = require("node:fs");
const { join, delimiter } = require("node:path");
const { pathToFileURL } = require("node:url");
const [command, ...args] = process.argv.slice(2);
const tools = args.filter((arg) => arg !== "--json");
const control = JSON.parse(fs.readFileSync(join(process.cwd(), "..", "fixture.json"), "utf8"));
function directory(tool) {
  const at = tool.lastIndexOf("@");
  return join(
    process.env.MISE_DATA_DIR,
    "installs",
    Buffer.from(tool.slice(0, at)).toString("hex"),
    tool.slice(at + 1),
  );
}
if (command === "env" && tools.some((tool) => tool.startsWith("core:deno@"))) {
  console.log(
    JSON.stringify({
      PATH: [...tools.map((tool) => join(directory(tool), "bin")), process.env.PATH].join(
        delimiter,
      ),
      PI_DAP_FIXTURE: control.dapFixture,
      // A copied native Node binary plus preload is a portable external Deno stand-in,
      // including processes started by Pi's exec rather than the test's spawn import.
      NODE_OPTIONS: `--import=${pathToFileURL(join(__dirname, "managed-expansion-deno.mjs")).href}`,
    }),
  );
} else {
  if (command === "install") {
    if (control.failInstall) throw new Error("Expansion fixture download unavailable");
    for (const tool of tools.filter((arg) => arg.startsWith("core:deno@"))) {
      const bin = join(directory(tool), "bin");
      fs.mkdirSync(bin, { recursive: true });
      const executable = join(bin, process.platform === "win32" ? "deno.exe" : "deno");
      if (!fs.existsSync(executable)) fs.copyFileSync(process.execPath, executable);
      fs.chmodSync(executable, 0o755);
    }
    process.argv = process.argv.filter((arg) => !arg.startsWith("core:deno@"));
  }
  require("./managed-mise.cjs");
}
