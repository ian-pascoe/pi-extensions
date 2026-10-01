import { afterEach, describe, expect, test, vi } from "vitest";
import {
  REGISTRY_KEY,
  TermctrlRegistry,
  type BackgroundJobChild,
  type ExitNotice,
} from "../src/termctrl-registry.js";
import { FakeDriverFactory } from "./fake-driver.js";

const viewport = { cols: 80, rows: 24 };

class FakeJob implements BackgroundJobChild {
  stopped = false;
  logRemoved = false;
  output = "";
  constructor(
    readonly logPath: string,
    private readonly onStop: () => void,
  ) {}
  stop(): void {
    this.stopped = true;
    queueMicrotask(this.onStop);
  }
  tail(): string {
    return this.output;
  }
  async removeLog(): Promise<void> {
    this.logRemoved = true;
  }
}

interface Harness {
  readonly drivers: FakeDriverFactory;
  readonly registry: TermctrlRegistry;
}

function createHarness(): Harness {
  const drivers = new FakeDriverFactory();
  const registry = TermctrlRegistry.acquire({ createDriver: drivers.create, pollIntervalMs: 5 });
  return { drivers, registry };
}

function startJob(registry: TermctrlRegistry, owner: string, command = "sleep 100") {
  let job: FakeJob | undefined;
  const entry = registry.createJob(owner, command, (id) => {
    job = new FakeJob(`/tmp/pi-termctrl/${id}.log`, () =>
      registry.jobExited(id, { code: null, signal: "SIGKILL" }),
    );
    return job;
  });
  if (job === undefined) throw new Error("job factory did not run");
  return { entry, job };
}

function collect(registry: TermctrlRegistry, owner: string) {
  const batches: ExitNotice[][] = [];
  registry.bindOwner(owner, (notices) => batches.push([...notices]));
  return batches;
}

const nextTick = () => new Promise((resolve) => setImmediate(resolve));

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition was not met in time");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

afterEach(async () => {
  vi.useRealTimers();
  await TermctrlRegistry.teardownForTests();
  expect(Object.getOwnPropertySymbols(globalThis)).not.toContain(REGISTRY_KEY);
});

describe("TermctrlRegistry", () => {
  test("isolates entries by owner session", async () => {
    const { registry } = createHarness();
    const terminal = await registry.startTerminal("root", {
      command: ["/bin/sh", "-c", "python3"],
      displayCommand: "python3",
      cwd: "/tmp",
      viewport,
      notify: true,
    });
    const { entry: job } = startJob(registry, "child");

    expect(terminal.id).toBe("t1");
    expect(job.id).toBe("b1");
    expect(registry.find("root", "t1")).toBe(terminal);
    expect(registry.find("child", "t1")).toBeUndefined();
    expect(registry.find("root", "b1")).toBeUndefined();
    expect(registry.ownedEntries("child").map(({ id }) => id)).toEqual(["b1"]);
    expect(registry.entries().map(({ id }) => id)).toEqual(["t1", "b1"]);

    await registry.shutdownOwner("child");
    expect(registry.entries().map(({ id }) => id)).toEqual(["t1"]);
    expect(terminal.state).toBe("running");
  });

  test("survives a reload with a fresh module instance and keeps ids monotonic", async () => {
    const { drivers, registry } = createHarness();
    await registry.startTerminal("root", {
      command: ["/bin/sh", "-c", "top"],
      displayCommand: "top",
      cwd: "/tmp",
      viewport,
      notify: true,
    });
    startJob(registry, "root");

    vi.resetModules();
    const fresh: typeof import("../src/termctrl-registry.js") =
      await import("../src/termctrl-registry.js");
    expect(fresh.TermctrlRegistry).not.toBe(TermctrlRegistry);
    const reloaded = fresh.TermctrlRegistry.acquire({
      createDriver: drivers.create,
      pollIntervalMs: 5,
    });

    expect(reloaded.entries().map(({ id, state }) => [id, state])).toEqual([
      ["t1", "running"],
      ["b1", "running"],
    ]);
    const second = await reloaded.startTerminal("root", {
      command: ["/bin/sh", "-c", "vim"],
      displayCommand: "vim",
      cwd: "/tmp",
      viewport,
      notify: true,
    });
    const { entry: secondJob } = startJob(reloaded, "root");
    expect([second.id, secondJob.id]).toEqual(["t2", "b2"]);
    expect(drivers.drivers).toHaveLength(1);
  });

  test("queues notifications while the owner is unbound and flushes them on rebind", async () => {
    const { registry } = createHarness();
    const stale = collect(registry, "root");
    const { entry, job } = startJob(registry, "root", "make build");
    job.output = "compiled\n";

    registry.unbindOwner("root");
    registry.jobExited(entry.id, { code: 0, signal: null });
    await nextTick();
    expect(stale).toEqual([]);

    const fresh = collect(registry, "root");
    await nextTick();
    expect(stale).toEqual([]);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject([
      { id: "b1", kind: "job", command: "make build", exit: { code: 0, signal: null } },
    ]);
    expect(fresh[0]?.[0]?.output).toBe("compiled\n");
  });

  test("tears down a registry with an unknown version and starts fresh", async () => {
    const teardown = vi.fn(async () => {});
    Object.defineProperty(globalThis, REGISTRY_KEY, {
      value: { version: 999, teardown },
      configurable: true,
      writable: true,
    });
    const { registry } = createHarness();
    expect(teardown).toHaveBeenCalledOnce();
    expect(registry.entries()).toEqual([]);
    const { entry } = startJob(registry, "root");
    expect(entry.id).toBe("b1");
  });

  test("rejects starts beyond the cap and lists the caller's live entries", async () => {
    const { registry } = createHarness();
    for (let index = 0; index < 15; index++) startJob(registry, "other");
    await registry.startTerminal("root", {
      command: ["/bin/sh", "-c", "htop"],
      displayCommand: "htop",
      cwd: "/tmp",
      viewport,
      notify: true,
    });

    expect(() => startJob(registry, "root", "sleep 1")).toThrow(
      "Cannot start: 16 Terminals and Background jobs are already running (the limit). Your live entries: t1 (Terminal) htop. Stop one with terminal_stop.",
    );
    await expect(
      registry.startTerminal("root", {
        command: ["/bin/sh", "-c", "less"],
        displayCommand: "less",
        cwd: "/tmp",
        viewport,
        notify: true,
      }),
    ).rejects.toThrow("Your live entries: t1 (Terminal) htop.");

    registry.jobExited("b1", { code: 0, signal: null });
    expect(startJob(registry, "root").entry.id).toBe("b16");
  });

  test("batches exits from the same tick into one delivery", async () => {
    const { registry } = createHarness();
    const batches = collect(registry, "root");
    const first = startJob(registry, "root", "one");
    const second = startJob(registry, "root", "two");

    registry.jobExited(first.entry.id, { code: 0, signal: null });
    registry.jobExited(second.entry.id, { code: 2, signal: null });
    await nextTick();
    expect(batches.map((batch) => batch.map(({ id }) => id))).toEqual([["b1", "b2"]]);
  });

  test("suppresses exits the agent already saw, stopped, or opted out of", async () => {
    const { registry } = createHarness();
    const batches = collect(registry, "root");
    const seen = startJob(registry, "root");
    const stopped = startJob(registry, "root");
    const quiet = await registry.startTerminal("root", {
      command: ["/bin/sh", "-c", "true"],
      displayCommand: "true",
      cwd: "/tmp",
      viewport,
      notify: false,
    });

    registry.jobExited(seen.entry.id, { code: 0, signal: null });
    registry.markSeen(seen.entry.id);
    const stopping = registry.stop("root", stopped.entry.id);
    registry.jobExited(stopped.entry.id, { code: null, signal: "SIGKILL" });
    await stopping;
    registry.terminalExited(quiet.id, { code: 0, signal: null }, "", false);
    await nextTick();
    await nextTick();

    expect(batches).toEqual([]);
    expect(stopped.job.stopped).toBe(true);
    expect(stopped.job.logRemoved).toBe(true);
    expect(registry.find("root", stopped.entry.id)).toBeUndefined();
  });

  test("notifies when the exit watcher sees a Terminal exit", async () => {
    const { drivers, registry } = createHarness();
    const batches = collect(registry, "root");
    await registry.startTerminal("root", {
      command: ["/bin/sh", "-c", "npm run dev"],
      displayCommand: "npm run dev",
      cwd: "/tmp",
      viewport,
      notify: true,
    });
    const terminal = drivers.terminal(0);
    terminal.screen = "listening\nerror: port in use";
    terminal.exitWith({ code: 1, signal: null });

    await waitFor(() => batches.length === 1);
    expect(batches[0]).toMatchObject([
      {
        id: "t1",
        kind: "terminal",
        command: "npm run dev",
        exit: { code: 1, signal: null },
        output: "listening\nerror: port in use",
      },
    ]);
    expect(registry.find("root", "t1")?.state).toBe("exited");
  });

  test("marks every Terminal exited when the driver dies and starts a new driver next time", async () => {
    const { drivers, registry } = createHarness();
    const batches = collect(registry, "root");
    for (const command of ["a", "b"]) {
      await registry.startTerminal("root", {
        command: ["/bin/sh", "-c", command],
        displayCommand: command,
        cwd: "/tmp",
        viewport,
        notify: true,
      });
    }
    drivers.latest.die();

    await waitFor(() => batches.flat().length === 2);
    expect(registry.entries().map(({ state }) => state)).toEqual(["exited", "exited"]);
    expect(batches.flat().map(({ exit }) => exit)).toEqual([
      { code: null, signal: "termctrl driver exited" },
      { code: null, signal: "termctrl driver exited" },
    ]);

    const replacement = await registry.startTerminal("root", {
      command: ["/bin/sh", "-c", "c"],
      displayCommand: "c",
      cwd: "/tmp",
      viewport,
      notify: true,
    });
    expect(replacement.id).toBe("t3");
    expect(drivers.drivers).toHaveLength(2);
  });

  test("escalates to SIGKILL when termctrl does not stop a Terminal within 3 s", async () => {
    const { drivers, registry } = createHarness();
    await registry.startTerminal("root", {
      command: ["/bin/sh", "-c", "stubborn"],
      displayCommand: "stubborn",
      cwd: "/tmp",
      viewport,
      notify: true,
    });
    const terminal = drivers.terminal(0);
    terminal.hangOnStop = true;
    terminal.screen = "still here";

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stopping = registry.stop("root", "t1");
    await vi.advanceTimersByTimeAsync(2_999);
    expect(terminal.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const stopped = await stopping;

    expect(terminal.killed).toBe(true);
    expect(stopped).toMatchObject({ id: "t1", state: "exited", finalScreen: "still here" });
    expect(registry.find("root", "t1")).toBeUndefined();
  });

  test("keeps a user-stopped entry as exited and notifies the agent", async () => {
    const { registry } = createHarness();
    const batches = collect(registry, "root");
    const { entry, job } = startJob(registry, "root", "tail -f log");

    const stopping = registry.stopByUser(entry.id);
    registry.jobExited(entry.id, { code: null, signal: "SIGKILL" });
    await stopping;
    await nextTick();

    expect(job.stopped).toBe(true);
    expect(registry.find("root", entry.id)?.state).toBe("exited");
    expect(batches.flat().map(({ id }) => id)).toEqual(["b1"]);

    await registry.remove(entry.id);
    expect(job.logRemoved).toBe(true);
    expect(registry.entries()).toEqual([]);
  });

  test("shutting down an owner stops its entries, deletes logs, and drops queued notices", async () => {
    const { drivers, registry } = createHarness();
    const batches = collect(registry, "root");
    await registry.startTerminal("root", {
      command: ["/bin/sh", "-c", "repl"],
      displayCommand: "repl",
      cwd: "/tmp",
      viewport,
      notify: true,
    });
    const { entry, job } = startJob(registry, "root");
    const exited = startJob(registry, "root");
    registry.jobExited(exited.entry.id, { code: 0, signal: null });

    const shutdown = registry.shutdownOwner("root");
    registry.jobExited(entry.id, { code: null, signal: "SIGKILL" });
    await shutdown;
    await nextTick();

    expect(drivers.terminal(0).stopCalls).toBe(1);
    expect(job.stopped).toBe(true);
    expect(job.logRemoved).toBe(true);
    expect(exited.job.logRemoved).toBe(true);
    expect(registry.entries()).toEqual([]);
    expect(batches).toEqual([]);
  });

  test("reports change events for the running count", async () => {
    const { registry } = createHarness();
    const counts: number[] = [];
    const unsubscribe = registry.onChange(() => counts.push(registry.runningCount()));
    const { entry } = startJob(registry, "root");
    registry.jobExited(entry.id, { code: 0, signal: null });
    unsubscribe();
    startJob(registry, "root");
    expect(counts).toEqual([1, 0]);
  });
});
