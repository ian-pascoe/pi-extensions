// Offline external acquisition executable. The real installer owns selection/publication.
const fs = require("node:fs");
const { join, delimiter } = require("node:path");
const [command, ...args] = process.argv.slice(2);
const store = join(process.cwd(), "..");
const control = JSON.parse(fs.readFileSync(join(store, "fixture.json"), "utf8"));
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
async function main() {
  if (command === "latest") return console.log(control.version ?? "7.0.2");
  if (command === "where") return console.log(directory(tools[0]));
  if (command === "env") {
    const environment = {
      PATH: [...tools.map((tool) => join(directory(tool), "bin")), process.env.PATH].join(
        delimiter,
      ),
    };
    if (tools.some((tool) => tool.startsWith("core:rust@")))
      Object.assign(environment, {
        CARGO_HOME: join(store, "home", ".cargo"),
        RUSTUP_HOME: join(store, "home", ".rustup"),
        RUSTUP_TOOLCHAIN: control.version,
      });
    return console.log(JSON.stringify(environment));
  }
  if (command !== "install") throw new Error(`Unexpected mise command ${command}`);
  while (control.wait && !fs.existsSync(join(store, "release")))
    await new Promise((done) => setTimeout(done, 10));
  if (control.fail || (control.failTool && tools.some((tool) => tool.startsWith(control.failTool))))
    throw new Error("Fixture acquisition failed");
  for (const tool of tools) {
    const path = directory(tool);
    fs.mkdirSync(join(path, "bin"), { recursive: true });
    if (tool.startsWith("core:node@")) {
      const node = join(path, process.platform === "win32" ? "node.exe" : "bin/node");
      if (!fs.existsSync(node)) fs.copyFileSync(process.execPath, node);
      fs.chmodSync(node, 0o755);
    } else if (tool.startsWith("npm:typescript@")) {
      const compiler = join(path, "node_modules/typescript/bin/tsc");
      fs.mkdirSync(join(path, "node_modules/typescript/bin"), { recursive: true });
      fs.mkdirSync(join(path, "node_modules/typescript/lib"), { recursive: true });
      fs.writeFileSync(
        join(path, "node_modules/typescript/lib/typescript.js"),
        `exports.version = ${JSON.stringify(tool.slice(tool.lastIndexOf("@") + 1))};\n`,
      );
      fs.writeFileSync(
        compiler,
        `process.env.FAKE_SYMBOL_NAME = ${JSON.stringify(control.version ?? "7.0.2")}; import(${JSON.stringify(control.server)});\n`,
      );
    } else if (tool.startsWith("core:rust@")) {
      for (const name of ["rustc", "cargo"]) {
        const executable = join(path, "bin", name + (process.platform === "win32" ? ".exe" : ""));
        fs.copyFileSync(process.execPath, executable);
        fs.chmodSync(executable, 0o755);
      }
    } else if (tool.startsWith("aqua:rust-lang/rust-analyzer@") || tool.startsWith("core:deno@")) {
      const script = join(path, "server.cjs");
      fs.writeFileSync(
        script,
        `process.env.FAKE_SYMBOL_NAME = ${tool.startsWith("core:deno@") ? '"deno-native-fixture"' : '"RUSTUP_TOOLCHAIN=" + (process.env.RUSTUP_TOOLCHAIN ?? "unset")'}; import(${JSON.stringify(control.server)});\n`,
      );
      const executable = join(
        path,
        "bin",
        (tool.startsWith("core:deno@") ? "deno" : "rust-analyzer") +
          (process.platform === "win32" ? ".cmd" : ""),
      );
      fs.writeFileSync(
        executable,
        process.platform === "win32"
          ? `@echo off\r\n"${process.execPath}" "%~dp0..\\server.cjs" %*\r\n`
          : `#!${process.execPath}\nrequire(${JSON.stringify(script)});\n`,
      );
      fs.chmodSync(executable, 0o755);
    } else if (!tool.startsWith("npm:")) throw new Error(`Unexpected tool ${tool}`);
    if (tool.startsWith("npm:")) {
      const at = tool.lastIndexOf("@");
      const name = tool.slice(4, at);
      const pkg = join(path, "node_modules", name);
      fs.mkdirSync(pkg, { recursive: true });
      fs.writeFileSync(
        join(pkg, "package.json"),
        JSON.stringify({ name, version: tool.slice(at + 1) }),
      );
      if (name === "oxlint") {
        const version = tool.slice(at + 1);
        fs.writeFileSync(
          join(pkg, "package.json"),
          JSON.stringify({
            name,
            version,
            peerDependencies: { "oxlint-tsgolint": version === "1.82.0" ? "^7.0.0" : "^8.0.0" },
          }),
        );
        fs.mkdirSync(join(pkg, "bin"), { recursive: true });
        fs.writeFileSync(
          join(pkg, "bin", "oxlint"),
          `if (process.argv.includes("--version")) console.log(${JSON.stringify(version)}); else if (process.argv.includes("--print-config")) console.log(require("node:fs").readFileSync(".oxlintrc.json", "utf8")); else { process.env.FAKE_SYMBOL_NAME = ${JSON.stringify(`oxlint@${version} helper=`)} + process.env.OXLINT_TSGOLINT_PATH; import(${JSON.stringify(control.server)}); }\n`,
        );
      }
      if (name === "oxlint-tsgolint") {
        const native = join(
          path,
          "node_modules",
          "@oxlint-tsgolint",
          `${process.platform}-${process.arch}`,
        );
        fs.mkdirSync(native, { recursive: true });
        fs.writeFileSync(
          join(native, `tsgolint${process.platform === "win32" ? ".exe" : ""}`),
          "fixture",
        );
      }
    }
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
