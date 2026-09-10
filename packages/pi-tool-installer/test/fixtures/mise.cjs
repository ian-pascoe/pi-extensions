// Offline stand-in for the external mise executable, never the installer itself.
const { mkdirSync, readFileSync, writeFileSync, existsSync } = require("node:fs");
const { join, delimiter } = require("node:path");
const [command, ...args] = process.argv.slice(2);
const control = JSON.parse(readFileSync(join(process.cwd(), "..", "fixture.json"), "utf8"));
if (process.env.GITHUB_TOKEN) throw new Error("Credential forwarded to mise");
const tools = args.filter((arg) => arg !== "--json");
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
if (command === "latest") {
  const selector = tools[0];
  const version = control.latest[selector];
  if (!version) throw new Error(`No fixture version for ${selector}`);
  console.log(version);
} else if (command === "install") {
  if (tools.some((tool) => tool.startsWith("pipx:"))) {
    // Windows Aqua resolves @path text as a release version during executable lookup.
    if (tools.some((tool) => tool.startsWith("aqua:") && tool.includes("@path:")))
      throw new Error("Aqua cannot resolve executable paths from a path version");
    const uv = (process.env.PATH ?? "").split(delimiter).find((path) => {
      const marker = join(path, "..", "complete");
      return existsSync(marker) && readFileSync(marker, "utf8").startsWith("aqua:astral-sh/uv@");
    });
    if (!uv) throw new Error("Private UV is not available on the child PATH");
    const python = tools.find((tool) => tool.startsWith("core:python@path:"));
    if (
      !python ||
      process.env.UV_PYTHON !==
        join(directory(python), process.platform === "win32" ? "python.exe" : "bin/python3")
    )
      throw new Error("Exact shared Python runtime is missing");
  }
  for (const tool of tools) {
    const path = directory(tool);
    if (existsSync(join(path, "complete"))) continue;
    if (control.incomplete) continue;
    mkdirSync(join(path, "bin"), { recursive: true });
    if (tool === control.fail) throw new Error("Fixture acquisition failed");
    if (tool === control.pause) {
      process.stderr.write("Downloading fixture\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
    }
    writeFileSync(join(path, "complete"), tool);
  }
} else if (command === "where") {
  console.log(directory(tools[0]));
} else if (command === "env") {
  console.log(
    JSON.stringify({
      ...control.environments?.[tools.at(-1)],
      PATH: [...tools.map((tool) => join(directory(tool), "bin")), process.env.PATH].join(
        delimiter,
      ),
    }),
  );
} else {
  throw new Error(`Unexpected mise command ${command}`);
}
