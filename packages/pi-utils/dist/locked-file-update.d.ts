/** Controls the permissions of a file replaced by {@link updateFileLocked}. */
export interface UpdateFileLockedOptions {
    /** Permission bits to force; defaults to the existing mode, or `0o600` for a new file. */
    readonly mode?: number;
}
/**
 * Read, transform, and atomically replace one file under Pi's native settings lock.
 * `update` receives the current text, or undefined when the file is absent, and returns
 * replacement text or undefined to leave the file untouched. An existing symlink is followed.
 * Pi retries this lock with a synchronous busy-wait, so the critical section never yields.
 * @returns Whether the file was replaced.
 */
export declare function updateFileLocked(path: string, update: (current: string | undefined) => string | undefined, options?: UpdateFileLockedOptions): Promise<boolean>;
