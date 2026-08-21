import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Owns private Result Spill and bounded stderr files for one Pi session. */
export interface LspSessionFiles {
  /** Private directory removed when the Pi session shuts down. */
  readonly directoryPath: string;
  /** Write complete truncated tool output to a Result Spill file. */
  writeResultSpill(output: string): Promise<string>;
  /** Create or return the bounded stderr file path for one language server. */
  getServerStderrPath(serverId: string): Promise<string>;
  /** Remove all session files after queued writes finish. */
  close(): Promise<void>;
}

interface ServerStderrFile {
  readonly path: string;
}

class LspSessionFileStore implements LspSessionFiles {
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private nextFileIndex = 0;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly stderrFiles = new Map<string, ServerStderrFile>();

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

  getServerStderrPath(serverId: string): Promise<string> {
    const stderrFile = this.serverStderrFile(serverId);
    return this.enqueueSessionFileWrite(async () => {
      await writeFile(stderrFile.path, "", { mode: 0o600 });
      await chmod(stderrFile.path, 0o600);
      return stderrFile.path;
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

  private serverStderrFile(serverId: string): ServerStderrFile {
    const existing = this.stderrFiles.get(serverId);
    if (existing !== undefined) return existing;
    const stderrFile = {
      path: join(this.directoryPath, `server-stderr-${this.nextFileIndex++}.log`),
    };
    this.stderrFiles.set(serverId, stderrFile);
    return stderrFile;
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

/** Create a mode-safe temporary directory for Result Spills and language-server stderr files. */
export async function createLspSessionFiles(sessionDirectory: string): Promise<LspSessionFiles> {
  await mkdir(sessionDirectory, { mode: 0o700, recursive: true });
  const directoryPath = await mkdtemp(join(sessionDirectory, "pi-lsp-"));
  await chmod(directoryPath, 0o700);
  return new LspSessionFileStore(directoryPath);
}
