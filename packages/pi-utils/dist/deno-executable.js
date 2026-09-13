import { constants } from "node:fs";
import { access, open, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
async function executable(path) {
    try {
        if (!(await stat(path)).isFile())
            return undefined;
        await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        return path;
    }
    catch {
        return undefined;
    }
}
async function npmEntry(path) {
    if (basename(path) !== "bin.cjs")
        return false;
    try {
        // npm aliases retain the published identity but use a different directory name.
        const manifest = JSON.parse(await shimText(join(dirname(path), "package.json")));
        return (
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON.parse established JSON data; this I/O boundary validates only the published package identity, not a typed manifest.
        typeof manifest === "object" &&
            manifest !== null &&
            "name" in manifest &&
            manifest.name === "deno");
    }
    catch {
        // Without a readable Deno identity this remains an opaque external command.
        return false;
    }
}
async function shimText(path) {
    const file = await open(path, "r");
    try {
        // Generated shims are small; never load an entire native executable into memory.
        const buffer = Buffer.alloc(64 * 1024);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        return buffer.toString("utf8", 0, bytesRead);
    }
    finally {
        await file.close();
    }
}
/**
 * Resolve known npm/pnpm Deno entrypoints to already-installed native payloads.
 * Missing candidates/closures return undefined; unrelated opaque commands are unchanged.
 * Callers retain discovery order and decide whether to acquire a private fallback.
 */
export async function resolveDenoExecutable(candidate) {
    if (!(await executable(candidate)))
        return undefined;
    let entry;
    try {
        entry = await realpath(candidate);
    }
    catch (error) {
        if (error instanceof Error &&
            "code" in error &&
            ["ENOENT", "ENOTDIR"].includes(String(error.code)))
            return undefined;
        throw error;
    }
    if (!(await npmEntry(entry))) {
        let shim;
        try {
            shim = await shimText(entry);
        }
        catch (error) {
            if (error instanceof Error && "code" in error) {
                if (["EACCES", "EPERM"].includes(String(error.code)))
                    return candidate;
                if (["ENOENT", "ENOTDIR"].includes(String(error.code)))
                    return undefined;
            }
            throw error;
        }
        // Deno's postinstall writes this exact native Windows forwarding shim.
        const native = process.platform === "win32"
            ? /^@"%~dp0((?:[^"%\r\n]*[\\/])?deno\.exe)" %\*\s*$/.exec(shim)
            : null;
        if (native)
            return executable(resolve(dirname(entry), native[1].replaceAll("\\", "/")));
        // Only known generated target/argument forwarding, not arbitrary shell syntax.
        const windows = process.platform === "win32"
            ? /^(?!\s*(?:rem\b|::))[^\r\n]*"(?:%dp0%|%~dp0)[\\/]?([^"%\r\n]*[\\/]bin\.cjs)"\s+%\*\)?\s*$/im.exec(shim)
            : null;
        const posix = process.platform !== "win32"
            ? /^\s*exec\s+(?:node(?:\.exe)?|"\$basedir(?:_win)?\/node(?:\.exe)?")\s+"\$basedir(?:_win)?\/([^"$`\r\n]*\/bin\.cjs)"\s+"\$@"\s*$/m.exec(shim)
            : null;
        const relative = windows?.[1] ?? posix?.[1];
        if (!relative)
            return candidate;
        try {
            entry = await realpath(resolve(dirname(entry), relative.replaceAll("\\", "/")));
        }
        catch {
            return undefined;
        }
        if (!(await npmEntry(entry)))
            return candidate;
    }
    const name = process.platform === "win32" ? "deno.exe" : "deno";
    const local = await executable(join(dirname(entry), name));
    if (local)
        return local;
    if (!["linux", "darwin", "win32"].includes(process.platform) ||
        !["x64", "arm64"].includes(process.arch))
        return undefined;
    const target = `${process.platform}-${process.arch}${process.platform === "linux" ? "-glibc" : ""}`;
    try {
        // Match upstream's dependency resolution (including hoisted and pnpm layouts),
        // but never import bin.cjs/install_api.cjs or copy/chmod a missing local payload.
        const manifest = createRequire(entry).resolve(`@deno/${target}/package.json`);
        return executable(join(dirname(manifest), name));
    }
    catch {
        return undefined;
    }
}
