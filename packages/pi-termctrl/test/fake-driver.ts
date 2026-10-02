import type { Key } from "@kitlangton/terminal-control";
import type {
  TerminalDriver,
  TerminalExit,
  TerminalHandle,
  TerminalLaunchRequest,
  TerminalSnapshot,
} from "../src/terminal-driver.js";

/** A scripted Terminal: tests set its screen, logs, idle time and exit directly. */
export class FakeTerminal implements TerminalHandle {
  private visible = "";
  logLines: string[] = [];
  state: "running" | "exited" = "running";
  exit: TerminalExit | null = null;
  /** When the program last wrote output; changing `screen` updates it. */
  lastOutputAt = Date.now();
  /** Whether termctrl reports idle time; when false the tools must track screen changes. */
  reportsIdle = true;
  /** Output that never pauses, so only the wait budget ends a wait. */
  alwaysBusy = false;
  readonly typed: string[] = [];
  readonly pressed: Key[][] = [];
  stopCalls = 0;
  killed = false;
  stopped = false;
  /** When set, `stop()` never settles, so the registry must escalate to `kill()`. */
  hangOnStop = false;
  /** Called after each input so tests can react like a program would. */
  onInput: ((terminal: FakeTerminal) => void) | undefined;
  /** Called before the log is read, like output that arrives after a screen was captured. */
  onLogs: ((terminal: FakeTerminal) => void) | undefined;

  constructor(
    readonly request: TerminalLaunchRequest,
    private readonly driver: FakeDriver,
  ) {}

  get screen(): string {
    return this.visible;
  }

  set screen(text: string) {
    this.visible = text;
    this.lastOutputAt = Date.now();
  }

  async snapshot(): Promise<TerminalSnapshot> {
    this.driver.assertAlive();
    if (this.stopped) throw new Error(`driver session "${this.request.id}" does not exist`);
    const idleForMs = this.alwaysBusy
      ? 0
      : this.reportsIdle
        ? Date.now() - this.lastOutputAt
        : null;
    return { screen: this.visible, state: this.state, exit: this.exit, idleForMs };
  }

  async logs(): Promise<string> {
    this.driver.assertAlive();
    this.onLogs?.(this);
    return this.logLines.join("\n");
  }

  async type(text: string): Promise<void> {
    this.driver.assertAlive();
    this.typed.push(text);
    this.onInput?.(this);
  }

  async press(keys: readonly Key[]): Promise<void> {
    this.driver.assertAlive();
    this.pressed.push([...keys]);
    this.onInput?.(this);
  }

  stop(): Promise<void> {
    this.stopCalls++;
    if (this.hangOnStop) return new Promise(() => {});
    this.stopped = true;
    this.exitWith({ code: null, signal: "SIGKILL" });
    return Promise.resolve();
  }

  isAlive(): boolean {
    return !this.stopped && !this.killed;
  }

  kill(): void {
    this.killed = true;
    this.stopped = true;
    this.exitWith({ code: null, signal: "SIGKILL" });
  }

  exitWith(exit: TerminalExit): void {
    this.state = "exited";
    this.exit = exit;
  }
}

/** A scripted termctrl driver that records launches and can die on demand. */
export class FakeDriver implements TerminalDriver {
  readonly terminals: FakeTerminal[] = [];
  alive = true;
  closed = false;
  /** Lets a test prepare each Terminal before `launch` resolves. */
  onLaunch: ((terminal: FakeTerminal) => void) | undefined;

  async launch(request: TerminalLaunchRequest): Promise<FakeTerminal> {
    this.assertAlive();
    const terminal = new FakeTerminal(request, this);
    this.terminals.push(terminal);
    this.onLaunch?.(terminal);
    return terminal;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.alive = false;
  }

  die(): void {
    this.alive = false;
  }

  assertAlive(): void {
    if (!this.alive) throw new Error("termctrl driver exited (SIGKILL)");
  }
}

/** Creates fresh fake drivers on demand and remembers each one. */
export class FakeDriverFactory {
  readonly drivers: FakeDriver[] = [];
  onLaunch: ((terminal: FakeTerminal) => void) | undefined;

  readonly create = async (): Promise<FakeDriver> => {
    const driver = new FakeDriver();
    driver.onLaunch = (terminal) => this.onLaunch?.(terminal);
    this.drivers.push(driver);
    return driver;
  };

  get latest(): FakeDriver {
    const driver = this.drivers.at(-1);
    if (driver === undefined) throw new Error("no fake driver was created");
    return driver;
  }

  terminal(index: number): FakeTerminal {
    const terminal = this.drivers.flatMap((driver) => driver.terminals)[index];
    if (terminal === undefined) throw new Error(`no fake terminal ${index}`);
    return terminal;
  }
}
