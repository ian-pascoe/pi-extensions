import { Buffer } from "node:buffer";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveCodeModeDenoLaunch } from "./codemode-deno-launch.js";
import type { CodeModeRuntime, CodeModeTimerHandle } from "./codemode-runtime.js";
import {
  CODEMODE_WORKER_MESSAGE_LIMIT_BYTES,
  parseCodeModeWorkerResponse,
  serializeCodeModeWorkerRequest,
  type CodeModeWorkerRequest,
  type CodeModeWorkerResponse,
} from "./codemode-worker-protocol.js";

const CODEMODE_PROCESS_START_TIMEOUT_MS = 30_000;
const CODEMODE_PROCESS_STOP_GRACE_MS = 2_000;
const CODEMODE_STDERR_LIMIT_BYTES = 64 * 1024;

/** Construction options for one Deno-native persistent notebook process. */
export type CodeModeWorkerProcessOptions = {
  readonly sessionId: string;
  readonly runtime: CodeModeRuntime;
  readonly onResponse: (response: CodeModeWorkerResponse) => void;
  readonly onFailure: (message: string) => void;
};

/** Owns process protocol I/O and deterministic acquisition/release for one CodeMode Session. */
export class CodeModeWorkerProcess {
  /** Settles only after the worker confirms the expected CodeMode Session ID. */
  readonly ready: Promise<void>;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly exitPromise: Promise<void>;
  private readonly readyPromise: PromiseWithResolvers<void>;
  private readonly exitPromiseResolvers: PromiseWithResolvers<void>;
  private exitMode: "running" | "graceful" | "forced" = "running";
  private readySettled = false;
  private failed = false;
  private stdoutBuffer = "";
  private stderr = "";

  /** Starts the pinned Deno process and its startup watchdog. */
  constructor(private readonly options: CodeModeWorkerProcessOptions) {
    this.readyPromise = Promise.withResolvers<void>();
    this.ready = this.readyPromise.promise;
    this.exitPromiseResolvers = Promise.withResolvers<void>();
    this.exitPromise = this.exitPromiseResolvers.promise;
    const workerPath = fileURLToPath(new URL("./codemode-worker.ts", import.meta.url));
    const launch = resolveCodeModeDenoLaunch(workerPath, options.sessionId);
    this.child = spawn(launch.command, launch.args, {
      env: { DENO_NO_UPDATE_CHECK: "1", NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.acceptStdout(chunk));
    this.child.stderr.on("data", (chunk: string) => {
      if (Buffer.byteLength(this.stderr, "utf8") < CODEMODE_STDERR_LIMIT_BYTES)
        this.stderr += chunk;
    });
    this.child.on("error", (cause) => {
      const message = `CodeMode Deno process error: ${cause.message}`;
      this.settleReadyFailure(message);
      this.exitPromiseResolvers.resolve();
      this.fail(message);
    });
    this.child.on("exit", (code, signal) => {
      const stderr = this.stderr.trim();
      const outcome = `${signal ?? code ?? "unknown"}${stderr.length === 0 ? "" : `: ${stderr}`}`;
      this.settleReadyFailure(`CodeMode Deno process exited before ready (${outcome})`);
      if (this.exitMode === "graceful" && code !== 0) {
        this.exitPromiseResolvers.reject(
          new Error(`Pi CodeMode: Deno process failed graceful cleanup (${outcome})`),
        );
        return;
      }
      this.exitPromiseResolvers.resolve();
      if (this.exitMode === "running") this.fail(`CodeMode Deno process exited (${outcome})`);
    });
    const startTimeout = options.runtime.setTimeout(() => {
      this.fail("CodeMode Deno process did not become ready");
      this.child.kill();
    }, CODEMODE_PROCESS_START_TIMEOUT_MS);
    this.ready.then(
      () => options.runtime.clearTimeout(startTimeout),
      () => options.runtime.clearTimeout(startTimeout),
    );
  }

  /** Writes one bounded request to the worker process. */
  send(
    request: CodeModeWorkerRequest,
  ): { readonly ok: true } | { readonly ok: false; readonly message: string } {
    const serialized = serializeCodeModeWorkerRequest(request);
    if (!serialized.ok) return serialized;
    if (this.child.stdin.destroyed) {
      return { ok: false, message: "CodeMode Deno process input is unavailable" };
    }
    try {
      this.child.stdin.write(`${serialized.value}\n`);
      return { ok: true };
    } catch {
      return { ok: false, message: "CodeMode Deno process input is unavailable" };
    }
  }

  /** Force-stops the process and settles startup even when no ready message arrived. */
  async terminate(): Promise<void> {
    if (this.exitMode !== "running") return this.exitPromise;
    this.exitMode = "forced";
    this.settleReadyFailure("CodeMode Deno process was terminated before ready");
    this.child.kill();
    await this.exitPromise;
  }

  /** Requests graceful idle shutdown, then force-stops after the fixed grace period. */
  async shutdown(): Promise<void> {
    if (this.exitMode !== "running") return this.exitPromise;
    this.exitMode = "graceful";
    const sent = this.send({
      version: 1,
      type: "shutdown",
      sessionId: this.options.sessionId,
    });
    this.child.stdin.end();
    if (!sent.ok) this.child.kill();
    let stopTimer: CodeModeTimerHandle | undefined;
    try {
      await Promise.race([
        this.exitPromise,
        new Promise<void>((resolvePromise) => {
          stopTimer = this.options.runtime.setTimeout(() => {
            this.settleReadyFailure("CodeMode Deno process was stopped before ready");
            this.child.kill();
            resolvePromise();
          }, CODEMODE_PROCESS_STOP_GRACE_MS);
        }),
      ]);
      await this.exitPromise;
    } finally {
      if (stopTimer !== undefined) this.options.runtime.clearTimeout(stopTimer);
    }
  }

  private acceptStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer, "utf8") > CODEMODE_WORKER_MESSAGE_LIMIT_BYTES + 1) {
      this.fail("CodeMode worker response exceeds 8 MiB");
      void this.terminate();
      return;
    }
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.length > 0) this.acceptLine(line);
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private acceptLine(line: string): void {
    const parsed = parseCodeModeWorkerResponse(line);
    if (!parsed.ok) {
      this.fail(parsed.message);
      void this.terminate();
      return;
    }
    if (parsed.value.sessionId !== this.options.sessionId) {
      this.fail("CodeMode worker response has a stale Session ID");
      void this.terminate();
      return;
    }
    if (parsed.value.type === "ready") {
      this.settleReadySuccess();
      return;
    }
    if (parsed.value.type === "protocol-error") {
      this.fail(parsed.value.message);
      void this.terminate();
      return;
    }
    try {
      this.options.onResponse(parsed.value);
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "CodeMode worker response handling failed";
      this.fail(message);
      void this.terminate();
    }
  }

  private settleReadySuccess(): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.readyPromise.resolve();
  }

  private settleReadyFailure(message: string): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.readyPromise.reject(new Error(`Pi CodeMode: ${message}`));
  }

  private fail(message: string): void {
    if (this.failed || this.exitMode !== "running") return;
    this.failed = true;
    this.settleReadyFailure(message);
    this.options.onFailure(message);
  }
}
