import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Owns the private Result Spill files of one Pi session. Server stderr files belong to the
 * shared Server Instance pool instead, because an instance can outlive the session that started it.
 */
export interface LspSessionFiles {
  /** Private directory removed when the Pi session shuts down. */
  readonly directoryPath: string;
  /** Write complete truncated tool output to a Result Spill file. */
  writeResultSpill(output: string): Promise<string>;
  /** Remove all session files after queued writes finish. */
  close(): Promise<void>;
}

class LspSessionFileStore implements LspSessionFiles {
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private nextFileIndex = 0;
  private writeQueue: Promise<void> = Promise.resolve();

  /** Create a private file store rooted at the given session directory. */
  constructor(readonly directoryPath: string) {}

  writeResultSpill(output: string): Promise<string> {
    const path = join(this.directoryPath, `result-spill-${this.nextFileIndex++}.txt`);
    return this.enqueueSessionFileWrite(async () => {
      await writeFile(path, output, { encoding: "utf8", mode: 0o600 });
      await chmod(path, 0o600);
      return path;
    });
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    this.closePromise = this.writeQueue.then(
      () => rm(this.directoryPath, { force: true, recursive: true }),
      () => rm(this.directoryPath, { force: true, recursive: true }),
    );
    return this.closePromise;
  }

  private enqueueSessionFileWrite<T>(write: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Pi LSP: session files are closed"));
    const result = this.writeQueue.then(write);
    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** Create a mode-safe temporary directory for Result Spills. */
export async function createLspSessionFiles(sessionDirectory: string): Promise<LspSessionFiles> {
  const parentDirectory = sessionDirectory.length > 0 ? sessionDirectory : tmpdir();
  await mkdir(parentDirectory, { mode: 0o700, recursive: true });
  const directoryPath = await mkdtemp(join(parentDirectory, "pi-lsp-"));
  await chmod(directoryPath, 0o700);
  return new LspSessionFileStore(directoryPath);
}
