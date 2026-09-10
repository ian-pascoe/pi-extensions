import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const EnvironmentSchema = Type.Record(Type.String(), Type.String());
const InstallationSchema = Type.Object({
  id: Type.String(),
  components: Type.Record(
    Type.String(),
    Type.Object({ version: Type.String(), directory: Type.String() }),
  ),
  binDirectories: Type.Array(Type.String()),
  environment: EnvironmentSchema,
});
const ReleaseSchema = Type.Object({
  tag_name: Type.String({ pattern: "^v\\d+\\.\\d+\\.\\d+$" }),
  assets: Type.Array(
    Type.Object({
      name: Type.String(),
      digest: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    }),
  ),
});
const FileErrorSchema = Type.Object({ code: Type.Literal("ENOENT") });

const idPattern = /^[a-z][a-z0-9-]*$/;
const IdSchema = Type.String({ pattern: idPattern.source });
const RequestSchema = Type.Object(
  {
    id: IdSchema,
    requirements: Type.Record(
      IdSchema,
      Type.String({ pattern: "^(core|npm|aqua|go|pipx|github):[^\\s]+$" }),
      { minProperties: 1, additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type ToolRequest = Static<typeof RequestSchema>;

function validateRequest(request: ToolRequest): void {
  if (!Value.Check(RequestSchema, request)) throw new Error("Invalid managed tool request");
}

export type ManagedInstallation = Static<typeof InstallationSchema>;

export interface InstallationOptions {
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

function validId(id: string): void {
  if (!idPattern.test(id)) throw new Error(`Invalid managed tool ID: ${id}`);
}

function contained(directory: string, path: string): boolean {
  if (!isAbsolute(path)) return false;
  const suffix = relative(directory, path);
  return (
    suffix !== "" &&
    suffix !== ".." &&
    !suffix.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(suffix)
  );
}

function validateInstallation(
  installation: ManagedInstallation,
  id: string,
  directory: string,
): ManagedInstallation {
  if (installation.id !== id) throw new Error(`Invalid installation record for ${id}`);
  for (const component of Object.values(installation.components)) {
    if (!contained(directory, component.directory))
      throw new Error("Invalid managed component directory");
  }
  for (const path of installation.binDirectories) {
    if (!contained(directory, path)) throw new Error("Invalid managed executable directory");
  }
  if (Object.keys(installation.environment).some((key) => key.toUpperCase() === "PATH")) {
    throw new Error("Invalid managed environment");
  }
  return installation;
}

/** A private per-user store. Construction and installed() never acquire tools. */
export class ToolInstaller {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  async installed(id: string): Promise<ManagedInstallation | undefined> {
    validId(id);
    let text: string;
    try {
      text = await readFile(join(this.directory, "selections", `${id}.json`), "utf8");
    } catch (error) {
      if (Value.Check(FileErrorSchema, error)) return undefined;
      throw error;
    }
    const value: unknown = JSON.parse(text);
    if (!Value.Check(InstallationSchema, value))
      throw new Error(`Invalid installation record for ${id}`);
    const installation = validateInstallation(value, id, this.directory);
    for (const component of Object.values(installation.components)) {
      await access(component.directory);
    }
    return installation;
  }

  async ensure(
    request: ToolRequest,
    options: InstallationOptions & { allowDownload: boolean },
  ): Promise<ManagedInstallation> {
    options.signal?.throwIfAborted();
    validateRequest(request);
    const existing = await this.installed(request.id);
    if (existing) return existing;
    if (!options.allowDownload) {
      throw new Error(
        `${request.id} is not installed. Enable automatic downloads or configure an external executable.`,
      );
    }
    return this.withInstallationLock(options, async (signal) => {
      const installed = await this.installed(request.id);
      if (installed) return installed;
      return this.acquire(request, { ...options, signal });
    });
  }

  async update(
    request: ToolRequest,
    options: InstallationOptions,
  ): Promise<{ previous: ManagedInstallation; current: ManagedInstallation } | undefined> {
    options.signal?.throwIfAborted();
    validateRequest(request);
    if (!(await this.installed(request.id))) return undefined;
    return this.withInstallationLock(options, async (signal) => {
      const previous = await this.installed(request.id);
      if (!previous) return undefined;
      const current = await this.acquire(request, { ...options, signal });
      return { previous, current };
    });
  }

  private async withInstallationLock<T>(
    options: InstallationOptions,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    // ponytail: one store lock serializes downloads; split by component if contention matters.
    let release: (() => Promise<void>) | undefined;
    while (!release) {
      signal.throwIfAborted();
      try {
        release = await lockfile.lock(this.directory, {
          realpath: false,
          lockfilePath: join(this.directory, "installation.lock"),
          onCompromised: (error) => controller.abort(error),
        });
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ELOCKED")) throw error;
        options.onProgress?.("Waiting for another Pi process to finish installing tools");
        await setTimeout(250, undefined, { signal });
      }
    }
    try {
      return await operation(signal);
    } finally {
      await release();
    }
  }

  private environment(): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};
    for (const name of [
      "SystemRoot",
      "WINDIR",
      "COMSPEC",
      "PATHEXT",
      "LANG",
      "LC_ALL",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
    ]) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    const home = join(this.directory, "home");
    return {
      ...environment,
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      TMPDIR: join(this.directory, "tmp"),
      TMP: join(this.directory, "tmp"),
      TEMP: join(this.directory, "tmp"),
      PATH:
        process.platform === "win32"
          ? [
              join(process.env.SystemRoot ?? "C:\\Windows", "System32"),
              process.env.SystemRoot ?? "C:\\Windows",
            ].join(delimiter)
          : "/usr/bin:/bin:/usr/sbin:/sbin",
      MISE_DATA_DIR: join(this.directory, "data"),
      MISE_CACHE_DIR: join(this.directory, "cache"),
      MISE_CONFIG_DIR: join(this.directory, "config"),
      MISE_FETCH_REMOTE_VERSIONS_CACHE: "0s",
      MISE_YES: "1",
      MISE_COLOR: "0",
      CI: "1",
    };
  }

  private async helper(options: InstallationOptions): Promise<string> {
    const executable = join(this.directory, process.platform === "win32" ? "mise.exe" : "mise");
    try {
      await access(executable);
      return executable;
    } catch (error) {
      if (!Value.Check(FileErrorSchema, error)) throw error;
    }
    options.onProgress?.("Downloading the private mise installer");
    const fetchOptions: RequestInit = { headers: { Accept: "application/vnd.github+json" } };
    if (options.signal) fetchOptions.signal = options.signal;
    const response = await fetch(
      "https://api.github.com/repos/jdx/mise/releases/latest",
      fetchOptions,
    );
    if (!response.ok) throw new Error(`Cannot discover mise: HTTP ${response.status}`);
    const value: unknown = await response.json();
    if (!Value.Check(ReleaseSchema, value)) throw new Error("Invalid mise release metadata");
    const release = value;
    const os =
      process.platform === "darwin"
        ? "macos"
        : process.platform === "win32"
          ? "windows"
          : process.platform;
    if (!["linux", "macos", "windows"].includes(os) || !["x64", "arm64"].includes(process.arch)) {
      throw new Error(`Managed tools do not support ${process.platform}/${process.arch}`);
    }
    const name = `mise-${release.tag_name}-${os}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`;
    const asset = release.assets.find((candidate) => candidate.name === name);
    if (!asset?.digest || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) {
      throw new Error(`No checksum-verified native mise asset: ${name}`);
    }
    const download = await fetch(
      `https://github.com/jdx/mise/releases/download/${release.tag_name}/${name}`,
      fetchOptions,
    );
    if (!download.ok) throw new Error(`Cannot download mise: HTTP ${download.status}`);
    const bytes = Buffer.from(await download.arrayBuffer());
    if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== asset.digest) {
      throw new Error("Private mise download failed SHA-256 verification");
    }
    const staged = `${executable}.${randomUUID()}.tmp`;
    try {
      await writeFile(staged, bytes, { mode: 0o700, flag: "wx" });
      await chmod(staged, 0o700);
      options.signal?.throwIfAborted();
      await rename(staged, executable);
    } finally {
      await rm(staged, { force: true });
    }
    return executable;
  }

  private async run(
    executable: string,
    args: string[],
    environment: NodeJS.ProcessEnv,
    options: InstallationOptions,
  ): Promise<string> {
    options.signal?.throwIfAborted();
    return new Promise((resolveResult, reject) => {
      const child = spawn(executable, ["--no-config", "--no-hooks", ...args], {
        cwd: join(this.directory, "work"),
        env: environment,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (data: string) => {
        stdout += data;
      });
      child.stderr.setEncoding("utf8").on("data", (data: string) => {
        stderr = (stderr + data).slice(-64_000);
      });
      const cancel = () => {
        if (!child.pid) return;
        if (process.platform === "win32") {
          const killer = spawn(
            join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
            ["/pid", String(child.pid), "/T", "/F"],
            { windowsHide: true, stdio: "ignore" },
          );
          killer.on("error", () => child.kill());
        } else {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
              child.kill("SIGKILL");
          }
        }
      };
      options.signal?.addEventListener("abort", cancel, { once: true });
      if (options.signal?.aborted) cancel();
      child.once("error", reject);
      child.once("close", (code) => {
        options.signal?.removeEventListener("abort", cancel);
        if (options.signal?.aborted) reject(options.signal.reason);
        else if (code !== 0)
          reject(
            new Error(`mise ${args[0] ?? "command"} failed (${String(code)}): ${stderr.trim()}`),
          );
        else resolveResult(stdout.trim());
      });
    });
  }

  private async acquire(
    request: ToolRequest,
    options: InstallationOptions,
  ): Promise<ManagedInstallation> {
    await Promise.all(
      ["home", "work", "tmp", "selections"].map((name) =>
        mkdir(join(this.directory, name), { recursive: true, mode: 0o700 }),
      ),
    );
    const helper = await this.helper(options);
    let environment = this.environment();
    const basePaths = new Set((environment.PATH ?? "").split(delimiter));
    const components: ManagedInstallation["components"] = {};
    const tools: string[] = [];
    let additions: Record<string, string> = {};
    for (const [key, selector] of Object.entries(request.requirements)) {
      options.onProgress?.(`Resolving latest ${selector}`);
      const version = await this.run(helper, ["latest", selector], environment, options);
      if (!/^[v\d][a-zA-Z0-9.+_-]*$/.test(version))
        throw new Error(`Invalid concrete version for ${selector}: ${version}`);
      const concrete = `${selector}@${version}`;
      options.onProgress?.(`Installing ${concrete}`);
      await this.run(helper, ["install", ...tools, concrete], environment, options);
      const directory = await this.run(helper, ["where", concrete], environment, options);
      if (!contained(this.directory, directory))
        throw new Error(`mise resolved outside its private store: ${directory}`);
      components[key] = { version, directory };
      tools.push(concrete);
      const value: unknown = JSON.parse(
        await this.run(helper, ["env", "--json", ...tools], environment, options),
      );
      if (!Value.Check(EnvironmentSchema, value))
        throw new Error("Invalid mise environment result");
      additions = value;
      environment = { ...environment, ...additions };
    }
    const binDirectories = (environment.PATH ?? "")
      .split(delimiter)
      .filter((path) => !basePaths.has(path));
    delete additions.PATH;
    const installation = validateInstallation(
      { id: request.id, components, binDirectories, environment: additions },
      request.id,
      this.directory,
    );
    const destination = join(this.directory, "selections", `${request.id}.json`);
    const staged = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(staged, JSON.stringify(installation), { flag: "wx", mode: 0o600 });
      options.signal?.throwIfAborted();
      await rename(staged, destination);
    } finally {
      await rm(staged, { force: true });
    }
    return installation;
  }
}
