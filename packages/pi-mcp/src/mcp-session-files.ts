import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Maximum stderr and MCP logging bytes retained for one MCP Server. */
export const MAX_MCP_SERVER_LOG_BYTES = 256 * 1024;

/** Retains only the newest MCP Server stderr and logging bytes. */
export class RetainedMcpServerLog {
  private content = Buffer.alloc(0);

  /** Append one stderr or logging chunk in arrival order. */
  append(chunk: string | Uint8Array): void {
    const combined = Buffer.concat([this.content, Buffer.from(chunk)]);
    const overflow = Math.max(0, combined.length - MAX_MCP_SERVER_LOG_BYTES);
    this.content = overflow === 0 ? combined : Buffer.from(combined.subarray(overflow));
  }

  /** Return the current bounded stderr and logging tail as UTF-8 text. */
  read(): string {
    return this.content.toString("utf8");
  }
}

/** One private on-disk tail for an MCP Server's stderr and logging notifications. */
interface McpServerLogFile {
  readonly log: RetainedMcpServerLog;
  readonly path: string;
}

/** Private Result Spill, unsupported-content, and per-server log files owned by one Pi session. */
export interface McpSessionFiles {
  /** Private directory removed when the Pi session shuts down. */
  readonly directoryPath: string;
  /** Write complete truncated model-facing output to a Result Spill file. */
  writeResultSpill(output: string): Promise<string>;
  /** Write unsupported MCP binary or audio bytes to a private session file. */
  writeUnsupportedContent(content: Uint8Array, mimeType: string): Promise<string>;
  /** Append stderr or logging bytes, retaining only the newest 256 KB for that server. */
  appendServerLog(serverName: string, chunk: string | Uint8Array): Promise<void>;
  /** Read the current bounded stderr and logging tail for one MCP Server. */
  readServerLog(serverName: string): Promise<string>;
  /** Remove all session files after queued writes finish. */
  close(): Promise<void>;
}

class McpSessionFileStore implements McpSessionFiles {
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private nextFileIndex = 0;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly serverLogs = new Map<string, McpServerLogFile>();

  /** Create a private file store rooted at a Pi session directory. */
  constructor(readonly directoryPath: string) {}

  writeResultSpill(output: string): Promise<string> {
    const path = join(this.directoryPath, `result-spill-${this.nextFileIndex++}.txt`);
    return this.enqueueMcpSessionFileWrite(async () => {
      await writeFile(path, output, { encoding: "utf8", mode: 0o600 });
      await chmod(path, 0o600);
      return path;
    });
  }

  writeUnsupportedContent(content: Uint8Array, _mimeType: string): Promise<string> {
    const path = join(this.directoryPath, `unsupported-content-${this.nextFileIndex++}.bin`);
    return this.enqueueMcpSessionFileWrite(async () => {
      await writeFile(path, content, { mode: 0o600 });
      await chmod(path, 0o600);
      return path;
    });
  }

  appendServerLog(serverName: string, chunk: string | Uint8Array): Promise<void> {
    const serverLog = this.getMcpServerLogFile(serverName);
    return this.enqueueMcpSessionFileWrite(async () => {
      serverLog.log.append(chunk);
      await writeFile(serverLog.path, serverLog.log.read(), { encoding: "utf8", mode: 0o600 });
      await chmod(serverLog.path, 0o600);
    });
  }

  readServerLog(serverName: string): Promise<string> {
    return this.enqueueMcpSessionFileWrite(
      async () => this.serverLogs.get(serverName)?.log.read() ?? "",
    );
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

  private getMcpServerLogFile(serverName: string): McpServerLogFile {
    const existing = this.serverLogs.get(serverName);
    if (existing !== undefined) return existing;
    const serverLog = {
      log: new RetainedMcpServerLog(),
      path: join(this.directoryPath, `server-log-${this.nextFileIndex++}.log`),
    };
    this.serverLogs.set(serverName, serverLog);
    return serverLog;
  }

  private enqueueMcpSessionFileWrite<T>(write: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Pi MCP: session files are closed"));
    const result = this.writeQueue.then(write);
    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** Create a mode-safe private directory for MCP Result Spills, content, and server logs. */
export async function createMcpSessionFiles(sessionDirectory: string): Promise<McpSessionFiles> {
  await mkdir(sessionDirectory, { mode: 0o700, recursive: true });
  const directoryPath = await mkdtemp(join(sessionDirectory, "pi-mcp-"));
  await chmod(directoryPath, 0o700);
  return new McpSessionFileStore(directoryPath);
}
