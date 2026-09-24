import { randomUUID } from "node:crypto";
import { closeSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { lockSync } from "proper-lockfile";
const LOCK_ATTEMPTS = 100;
const LOCK_RETRY_DELAY_MS = 20;
const NEW_FILE_MODE = 0o600;
async function acquireLock(path) {
    for (let attempt = 1;; attempt++) {
        try {
            return lockSync(path, { realpath: false });
        }
        catch (cause) {
            const locked = cause instanceof Error && "code" in cause && cause.code === "ELOCKED";
            if (!locked || attempt >= LOCK_ATTEMPTS)
                throw cause;
            await delay(LOCK_RETRY_DELAY_MS);
        }
    }
}
/**
 * Read, transform, and atomically replace one file under Pi's native settings lock.
 * `update` receives the current text, or undefined when the file is absent, and returns
 * replacement text or undefined to leave the file untouched. An existing symlink is followed.
 * Pi retries this lock with a synchronous busy-wait, so the critical section never yields.
 * @returns Whether the file was replaced.
 */
export async function updateFileLocked(path, update, options = {}) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const release = await acquireLock(path);
    try {
        const file = lstatSync(path, { throwIfNoEntry: false });
        const target = file?.isSymbolicLink() === true ? realpathSync(path) : path;
        const next = update(file === undefined ? undefined : readFileSync(target, "utf8"));
        if (next === undefined)
            return false;
        const mode = options.mode ?? (file === undefined ? NEW_FILE_MODE : statSync(target).mode & 0o7777);
        const temporaryPath = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
        try {
            const handle = openSync(temporaryPath, "wx", mode);
            try {
                writeFileSync(handle, next, "utf8");
                fchmodSync(handle, mode);
                fsyncSync(handle);
            }
            finally {
                closeSync(handle);
            }
            renameSync(temporaryPath, target);
        }
        finally {
            rmSync(temporaryPath, { force: true });
        }
        return true;
    }
    finally {
        release();
    }
}
