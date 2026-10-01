import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Key, type Session, TerminalControl } from "@kitlangton/terminal-control";
import type {
  TerminalDriver,
  TerminalHandle,
  TerminalLaunchRequest,
  TerminalSnapshot,
} from "./terminal-driver.js";

/** Directory for Background job logs and Terminal pid handoff files. */
export function termctrlTemporaryDirectory(): string {
  return join(tmpdir(), "pi-termctrl");
}

const PID_WAIT_MS = 2_000;
const PID_POLL_MS = 10;
/**
 * Records the PTY root's pid, then execs the real command so the pid stays the same.
 * termctrl never reports the pid, and escalating a stuck stop to SIGKILL needs it.
 */
const PID_WRAPPER = 'echo $$ > "$1"; shift; exec "$@"';

async function readPid(pidFile: string): Promise<number | undefined> {
  const deadline = Date.now() + PID_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const pid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    } catch {
      // The wrapper has not written the file yet.
    }
    await new Promise((resolve) => setTimeout(resolve, PID_POLL_MS));
  }
  return undefined;
}

class TermctrlTerminal implements TerminalHandle {
  constructor(
    private readonly session: Session,
    private readonly pid: number | undefined,
  ) {}

  async snapshot(): Promise<TerminalSnapshot> {
    const status = await this.session.status();
    const capture = await this.session.screen.capture({
      allowIncomplete: true,
      settleMs: 0,
      deadlineMs: 0,
    });
    return {
      screen: capture.text,
      state: status.state,
      exit: status.exit === null ? null : { code: status.exit.code, signal: status.exit.signal },
      idleForMs: status.idleForMs,
    };
  }

  logs(): Promise<string> {
    return this.session.logs.text();
  }

  type(text: string): Promise<void> {
    return this.session.keyboard.type(text);
  }

  press(keys: readonly Key[]): Promise<void> {
    return this.session.keyboard.sequence(keys);
  }

  stop(): Promise<void> {
    return this.session.stop();
  }

  isAlive(): boolean {
    if (this.pid === undefined) return false;
    try {
      process.kill(this.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  kill(): void {
    if (this.pid === undefined) return;
    try {
      process.kill(-this.pid, "SIGKILL");
    } catch {
      try {
        process.kill(this.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
}

class TermctrlDriver implements TerminalDriver {
  constructor(private readonly control: TerminalControl) {}

  async launch(request: TerminalLaunchRequest): Promise<TerminalHandle> {
    const directory = termctrlTemporaryDirectory();
    await mkdir(directory, { recursive: true });
    const pidFile = join(directory, `${process.pid}-${request.id}.pid`);
    try {
      const session = await this.control.launch({
        command: ["/bin/sh", "-c", PID_WRAPPER, "pi-termctrl", pidFile, ...request.command],
        cwd: request.cwd,
        viewport: request.viewport,
      });
      return new TermctrlTerminal(session, await readPid(pidFile));
    } finally {
      await rm(pidFile, { force: true });
    }
  }

  close(): Promise<void> {
    return this.control.close();
  }
}

/** Start one termctrl driver process from a resolved binary. */
export async function createTermctrlDriver(binaryPath: string): Promise<TerminalDriver> {
  return new TermctrlDriver(await TerminalControl.make({ binaryPath }));
}
