import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, chmod, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile, } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { Type } from "typebox";
import { Value } from "typebox/value";
const idPattern = /^[a-z][a-z0-9-]*$/;
const IdSchema = Type.String({ pattern: idPattern.source });
const SelectorSchema = Type.String({ pattern: "^(core|npm|aqua|go|pipx|github):[^\\s]+$" });
const VersionSchema = Type.String({ pattern: "^v?\\d[a-zA-Z0-9.+_-]*$" });
const EnvironmentSchema = Type.Record(Type.String(), Type.String());
const InstallationSchema = Type.Object({
    id: Type.String(),
    components: Type.Record(IdSchema, Type.Object({ selector: SelectorSchema, version: VersionSchema, directory: Type.String() }), { minProperties: 1, additionalProperties: false }),
    binDirectories: Type.Array(Type.String()),
    environment: EnvironmentSchema,
});
const ContextSchema = Type.Object({
    binDirectories: InstallationSchema.properties.binDirectories,
    environment: EnvironmentSchema,
});
const SelectionSchema = Type.Object({
    ...InstallationSchema.properties,
    contexts: Type.Optional(Type.Array(ContextSchema)),
});
const ReleaseSchema = Type.Object({
    tag_name: Type.String({ pattern: "^v\\d+\\.\\d+\\.\\d+$" }),
    assets: Type.Array(Type.Object({
        name: Type.String(),
        digest: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    })),
});
const FileErrorSchema = Type.Object({ code: Type.Literal("ENOENT") });
const RequestSchema = Type.Object({
    id: IdSchema,
    requirements: Type.Record(IdSchema, SelectorSchema, {
        minProperties: 1,
        additionalProperties: false,
    }),
}, { additionalProperties: false });
function toolName(selector) {
    const at = selector.lastIndexOf("@");
    return at > selector.indexOf(":") + 1 && at > selector.lastIndexOf("]")
        ? selector.slice(0, at)
        : selector;
}
function validateRequest(request) {
    if (!Value.Check(RequestSchema, request))
        throw new Error("Invalid managed tool request");
}
function matches(installation, request) {
    return (JSON.stringify(Object.entries(installation?.components ?? {}).map(([key, value]) => [key, value.selector])) === JSON.stringify(Object.entries(request.requirements)));
}
function validId(id) {
    if (!idPattern.test(id))
        throw new Error(`Invalid managed tool ID: ${id}`);
}
function contained(directory, path) {
    if (!isAbsolute(path))
        return false;
    const suffix = relative(directory, path);
    return (suffix !== "" &&
        suffix !== ".." &&
        !suffix.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
        !isAbsolute(suffix));
}
function validateInstallation(installation, id, directory) {
    if (installation.id !== id)
        throw new Error(`Invalid installation record for ${id}`);
    for (const component of Object.values(installation.components)) {
        if (!contained(directory, component.directory))
            throw new Error("Invalid managed component directory");
    }
    for (const path of installation.binDirectories) {
        if (!contained(directory, path))
            throw new Error(`Invalid managed executable directory: ${path}`);
    }
    if (Object.keys(installation.environment).some((key) => key.toUpperCase() === "PATH")) {
        throw new Error("Invalid managed environment");
    }
    return installation;
}
async function validateDirectories(installation, directory, contexts = []) {
    const root = await realpath(directory);
    for (const path of new Set([
        ...Object.values(installation.components).map((component) => component.directory),
        ...installation.binDirectories,
        ...contexts.flatMap((context) => context.binDirectories),
    ])) {
        if (!(await stat(path)).isDirectory() || !contained(root, await realpath(path)))
            throw new Error(`Invalid managed installation directory: ${path}`);
    }
}
/** A private per-user store. Construction and installed() never acquire tools. */
export class ToolInstaller {
    directory;
    constructor(directory) {
        this.directory = resolve(directory);
    }
    async installed(id) {
        const selection = await this.selection(id);
        if (!selection)
            return undefined;
        try {
            await validateDirectories(selection, this.directory);
        }
        catch (error) {
            if (Value.Check(FileErrorSchema, error))
                return undefined;
            throw error;
        }
        return {
            id: selection.id,
            components: selection.components,
            binDirectories: selection.binDirectories,
            environment: selection.environment,
        };
    }
    async selection(id) {
        validId(id);
        let text;
        try {
            text = await readFile(join(this.directory, "selections", `${id}.json`), "utf8");
        }
        catch (error) {
            if (Value.Check(FileErrorSchema, error))
                return undefined;
            throw error;
        }
        const value = JSON.parse(text);
        if (!Value.Check(SelectionSchema, value) ||
            (value.contexts && value.contexts.length !== Object.keys(value.components).length))
            throw new Error(`Invalid installation record for ${id}`);
        validateInstallation(value, id, this.directory);
        for (const context of value.contexts ?? [])
            validateInstallation({ ...value, ...context }, id, this.directory);
        return value;
    }
    async ensure(request, options) {
        options.signal?.throwIfAborted();
        validateRequest(request);
        const existing = await this.installed(request.id);
        if (existing && matches(existing, request))
            return existing;
        const unavailable = new Error(`${request.id} is not installed. Enable automatic downloads or configure an external executable.`);
        if (!options.allowDownload) {
            try {
                await access(this.directory);
            }
            catch (error) {
                if (Value.Check(FileErrorSchema, error))
                    throw unavailable;
                throw error;
            }
        }
        return this.withInstallationLock(options, async (signal) => {
            const installed = await this.installed(request.id);
            if (installed && matches(installed, request))
                return installed;
            const previous = installed ?? (await this.selection(request.id));
            const reused = await this.reuse(request, { ...options, signal }, previous);
            if (reused)
                return reused;
            if (!options.allowDownload)
                throw unavailable;
            return this.acquire(request, { ...options, signal }, previous);
        });
    }
    async reuse(request, options, previous) {
        let files;
        try {
            files = await readdir(join(this.directory, "selections"));
        }
        catch (error) {
            if (Value.Check(FileErrorSchema, error))
                return undefined;
            throw error;
        }
        const requirements = Object.entries(request.requirements);
        for (const file of files.sort()) {
            options.signal?.throwIfAborted();
            if (!file.endsWith(".json") || !idPattern.test(file.slice(0, -5)))
                continue;
            const selection = await this.selection(file.slice(0, -5));
            if (!selection)
                continue;
            const components = Object.values(selection.components);
            if (!requirements.every(([key, selector], index) => {
                const component = components[index];
                const retained = previous?.components[key];
                return (component?.selector === selector &&
                    (retained?.selector !== selector ||
                        (retained.version === component.version &&
                            retained.directory === component.directory)));
            }))
                continue;
            // A prefix keeps its complete prerequisite graph, never a mixture of donors.
            const context = selection.contexts?.[requirements.length - 1] ??
                (requirements.length === components.length ? selection : undefined);
            if (!context)
                continue;
            try {
                return await this.publish({
                    id: request.id,
                    components: Object.fromEntries(requirements.map(([key], index) => [key, components[index]])),
                    binDirectories: context.binDirectories,
                    environment: context.environment,
                }, options, selection.contexts?.slice(0, requirements.length));
            }
            catch (error) {
                if (Value.Check(FileErrorSchema, error))
                    continue;
                throw error;
            }
        }
        return undefined;
    }
    async update(request, options) {
        options.signal?.throwIfAborted();
        validateRequest(request);
        if (!(await this.installed(request.id)))
            return undefined;
        return this.withInstallationLock(options, async (signal) => {
            const previous = await this.installed(request.id);
            if (!previous)
                return undefined;
            const current = await this.acquire(request, { ...options, signal });
            return { previous, current };
        });
    }
    async withInstallationLock(options, operation) {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const controller = new AbortController();
        const signal = options.signal
            ? AbortSignal.any([options.signal, controller.signal])
            : controller.signal;
        // ponytail: one store lock serializes downloads; split by component if contention matters.
        let release;
        while (!release) {
            signal.throwIfAborted();
            try {
                release = await lockfile.lock(this.directory, {
                    realpath: false,
                    lockfilePath: join(this.directory, "installation.lock"),
                    onCompromised: (error) => controller.abort(error),
                });
            }
            catch (error) {
                if (!(error instanceof Error && "code" in error && error.code === "ELOCKED"))
                    throw error;
                options.onProgress?.("Waiting for another Pi process to finish installing tools");
                await setTimeout(250, undefined, { signal });
            }
        }
        try {
            return await operation(signal);
        }
        finally {
            await release();
        }
    }
    environment() {
        const environment = {};
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
            if (process.env[name] !== undefined)
                environment[name] = process.env[name];
        }
        const home = join(this.directory, "home");
        return {
            ...environment,
            HOME: home,
            USERPROFILE: home,
            CARGO_HOME: join(home, ".cargo"),
            RUSTUP_HOME: join(home, ".rustup"),
            APPDATA: join(home, "AppData", "Roaming"),
            LOCALAPPDATA: join(home, "AppData", "Local"),
            XDG_CONFIG_HOME: join(home, ".config"),
            XDG_CACHE_HOME: join(home, ".cache"),
            XDG_DATA_HOME: join(home, ".local", "share"),
            TMPDIR: join(this.directory, "tmp"),
            TMP: join(this.directory, "tmp"),
            TEMP: join(this.directory, "tmp"),
            PATH: process.platform === "win32"
                ? [
                    join(process.env.SystemRoot ?? "C:\\Windows", "System32"),
                    process.env.SystemRoot ?? "C:\\Windows",
                ].join(delimiter)
                : "/usr/bin:/bin:/usr/sbin:/sbin",
            MISE_DATA_DIR: join(this.directory, "data"),
            MISE_SYSTEM_DATA_DIR: join(this.directory, "data"),
            MISE_CACHE_DIR: join(this.directory, "cache"),
            MISE_CONFIG_DIR: join(this.directory, "config"),
            MISE_FETCH_REMOTE_VERSIONS_CACHE: "0s",
            MISE_YES: "1",
            MISE_COLOR: "0",
            CI: "1",
        };
    }
    async helper(options) {
        const executable = join(this.directory, process.platform === "win32" ? "mise.exe" : "mise");
        try {
            await access(executable);
            return executable;
        }
        catch (error) {
            if (!Value.Check(FileErrorSchema, error))
                throw error;
        }
        options.onProgress?.("Downloading the private mise installer");
        const fetchOptions = { headers: { Accept: "application/vnd.github+json" } };
        if (options.signal)
            fetchOptions.signal = options.signal;
        const headers = new Headers(fetchOptions.headers);
        if (process.env.GITHUB_TOKEN)
            headers.set("Authorization", `Bearer ${process.env.GITHUB_TOKEN}`);
        const response = await fetch("https://api.github.com/repos/jdx/mise/releases/latest", {
            ...fetchOptions,
            headers,
            redirect: "error",
        });
        if (!response.ok) {
            const rateLimit = response.headers.get("x-ratelimit-remaining");
            throw new Error(`Cannot discover mise: HTTP ${response.status}${rateLimit === "0" ? ". GitHub API rate limit exhausted; retry later or supply GITHUB_TOKEN." : ""}`);
        }
        const value = await response.json();
        if (!Value.Check(ReleaseSchema, value))
            throw new Error("Invalid mise release metadata");
        const release = value;
        const os = process.platform === "darwin"
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
        const download = await fetch(`https://github.com/jdx/mise/releases/download/${release.tag_name}/${name}`, fetchOptions);
        if (!download.ok)
            throw new Error(`Cannot download mise: HTTP ${download.status}`);
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
        }
        finally {
            await rm(staged, { force: true });
        }
        return executable;
    }
    async run(executable, args, environment, options) {
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
            let progress = "";
            child.stdout.setEncoding("utf8").on("data", (data) => {
                stdout += data;
            });
            child.stderr.setEncoding("utf8").on("data", (data) => {
                stderr = (stderr + data).slice(-64_000);
                const lines = (progress + data).split(/\r?\n/);
                progress = (lines.pop() ?? "").slice(-64_000);
                for (const line of lines)
                    if (line.trim())
                        options.onProgress?.(line.trim());
            });
            const cancel = () => {
                if (!child.pid)
                    return;
                if (process.platform === "win32") {
                    const killer = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
                    killer.on("error", () => child.kill());
                }
                else {
                    try {
                        process.kill(-child.pid, "SIGKILL");
                    }
                    catch (error) {
                        if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
                            child.kill("SIGKILL");
                    }
                }
            };
            options.signal?.addEventListener("abort", cancel, { once: true });
            if (options.signal?.aborted)
                cancel();
            child.once("error", reject);
            child.once("close", (code) => {
                options.signal?.removeEventListener("abort", cancel);
                if (options.signal?.aborted)
                    reject(options.signal.reason);
                else if (code !== 0)
                    reject(new Error(`mise ${args[0] ?? "command"} failed (${String(code)}): ${stderr.trim()}`));
                else
                    resolveResult(stdout.trim());
            });
        });
    }
    async acquire(request, options, previous) {
        await Promise.all([
            "home",
            "work",
            "tmp",
            "selections",
            join("home", "AppData", "Local"),
            join("home", "AppData", "Roaming"),
        ].map((name) => mkdir(join(this.directory, name), { recursive: true, mode: 0o700 })));
        const helper = await this.helper(options);
        let environment = this.environment();
        const basePaths = new Set((environment.PATH ?? "").split(delimiter));
        const components = {};
        const contexts = [];
        const tools = [];
        for (const [key, selector] of Object.entries(request.requirements)) {
            const selected = previous?.components[key];
            let version = selected?.selector === selector ? selected.version : undefined;
            if (!version) {
                options.onProgress?.(`Resolving latest ${selector}`);
                version = await this.run(helper, ["latest", selector], environment, options);
            }
            if (!Value.Check(VersionSchema, version))
                throw new Error(`Invalid concrete version for ${selector}: ${String(version)}`);
            const concrete = `${toolName(selector)}@${version}`;
            let installEnvironment = environment;
            let prerequisites = tools;
            if (selector.startsWith("pipx:")) {
                // pipx links must target the shared full-patch Python, outside this namespace.
                // Its cache is scoped too: mise keeps incomplete-install markers there.
                prerequisites = Object.values(components).map((component) => `${toolName(component.selector)}@path:${component.directory}`);
                const graph = JSON.stringify([prerequisites, concrete]);
                const namespace = join(this.directory, "pipx", createHash("sha256").update(graph).digest("hex"));
                const python = Object.values(components).find((component) => toolName(component.selector) === "core:python");
                if (!python)
                    throw new Error(`${selector} requires a preceding managed Python runtime`);
                // Aqua's Windows bin lookup treats @path as a version. Reuse UV from the
                // private child PATH instead, while retaining it in the namespace identity.
                prerequisites = [`${toolName(python.selector)}@path:${python.directory}`];
                installEnvironment = {
                    ...environment,
                    MISE_DATA_DIR: join(namespace, "data"),
                    MISE_SYSTEM_DATA_DIR: join(namespace, "system-data"),
                    MISE_CACHE_DIR: join(namespace, "cache"),
                    UV_PYTHON: join(python.directory, process.platform === "win32" ? "python.exe" : "bin/python3"),
                    UV_PYTHON_DOWNLOADS: "never",
                    UV_NO_CONFIG: "1",
                    PYTHONDONTWRITEBYTECODE: "1",
                };
            }
            options.onProgress?.(`Installing ${concrete}`);
            await this.run(helper, ["install", ...prerequisites, concrete], installEnvironment, options);
            const directory = await this.run(helper, ["where", concrete], installEnvironment, options);
            if (!contained(this.directory, directory))
                throw new Error(`mise resolved outside its private store: ${directory}`);
            components[key] = { selector, version, directory };
            const value = JSON.parse(await this.run(helper, ["env", "--json", ...prerequisites, concrete], installEnvironment, options));
            tools.push(selector.startsWith("pipx:") ? `${toolName(selector)}@path:${directory}` : concrete);
            if (!Value.Check(EnvironmentSchema, value))
                throw new Error("Invalid mise environment result");
            const additions = value;
            environment = { ...environment, ...additions };
            const binDirectories = (environment.PATH ?? "")
                .split(delimiter)
                .filter((path) => !basePaths.has(path));
            delete additions.PATH;
            contexts.push({ binDirectories, environment: additions });
        }
        const context = contexts.at(-1);
        return this.publish({ id: request.id, components, ...context }, options, contexts);
    }
    async publish(installation, options, contexts) {
        validateInstallation(installation, installation.id, this.directory);
        for (const context of contexts ?? [])
            validateInstallation({ ...installation, ...context }, installation.id, this.directory);
        await validateDirectories(installation, this.directory, contexts);
        const destination = join(this.directory, "selections", `${installation.id}.json`);
        const staged = `${destination}.${randomUUID()}.tmp`;
        try {
            await writeFile(staged, JSON.stringify({ ...installation, contexts }), {
                flag: "wx",
                mode: 0o600,
            });
            options.signal?.throwIfAborted();
            await rename(staged, destination);
        }
        finally {
            await rm(staged, { force: true });
        }
        return installation;
    }
}
