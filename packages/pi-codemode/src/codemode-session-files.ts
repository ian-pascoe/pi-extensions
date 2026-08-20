import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** One queued Result Spill path and its presentation-only write completion. */
export interface CodeModeResultSpill {
  /** Private file path available to retain in presentation details immediately. */
  readonly path: string;
  /** File write completion that never gates the model-facing Cell result. */
  readonly completion: Promise<void>;
}

/** Writes complete CodeMode presentation data when the Transcript view is bounded. */
export interface CodeModeResultSpillWriter {
  /** Queue complete presentation data without delaying the model-facing Cell result. */
  writeResultSpill(output: string): CodeModeResultSpill;
}

/** Owns private Result Spill files for one live Pi CodeMode session. */
export interface CodeModeSessionFiles extends CodeModeResultSpillWriter {
  /** Private directory removed after the CodeMode session shuts down. */
  readonly directoryPath: string;
  /** Finish queued writes and remove every private Result Spill file. */
  close(): Promise<void>;
}

class CodeModeSessionFileStore implements CodeModeSessionFiles {
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private nextFileIndex = 0;
  private writeQueue: Promise<void> = Promise.resolve();

  /** Creates a private Result Spill store rooted at the given directory. */
  constructor(readonly directoryPath: string) {}

  writeResultSpill(output: string): CodeModeResultSpill {
    const spillPath = join(this.directoryPath, `result-spill-${this.nextFileIndex++}.txt`);
    const completion = this.enqueueSessionFileWrite(async () => {
      await writeFile(spillPath, output, { encoding: "utf8", mode: 0o600 });
      await chmod(spillPath, 0o600);
    });
    return { path: spillPath, completion };
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
    if (this.closed) return Promise.reject(new Error("Pi CodeMode: session files are closed"));
    const result = this.writeQueue.then(write);
    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** Create a private Result Spill directory below Pi session storage or the system temporary directory. */
export async function createCodeModeSessionFiles(
  sessionDirectory: string,
): Promise<CodeModeSessionFiles> {
  const parentDirectory = sessionDirectory.length > 0 ? sessionDirectory : tmpdir();
  await mkdir(parentDirectory, { mode: 0o700, recursive: true });
  const directoryPath = await mkdtemp(join(parentDirectory, "pi-codemode-"));
  try {
    await chmod(directoryPath, 0o700);
    return new CodeModeSessionFileStore(directoryPath);
  } catch (cause) {
    await rm(directoryPath, { force: true, recursive: true });
    throw cause;
  }
}
