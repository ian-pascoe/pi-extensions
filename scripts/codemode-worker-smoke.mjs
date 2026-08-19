import { spawn } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CODEMODE_WORKER_SMOKE_TIMEOUT_MS = 30_000;
const CODEMODE_WORKER_PROTOCOL_VERSION = 1;
const CODEMODE_WORKER_SMOKE_RESULT = 42;
const CODEMODE_WORKER_SMOKE_SESSION_ID = "smoke-session";

function rejectSmoke(reject, label, message) {
  reject(new Error(`CodeMode worker smoke failed (${label}): ${message}`));
}

async function loadCodeModeDenoLaunch(workerPath, variant) {
  const packageDirectory = dirname(dirname(workerPath));
  const sourcePath = resolve(packageDirectory, "src/codemode-deno-launch.ts");
  const temporaryDirectory = await mkdtemp(resolve(tmpdir(), "pi-codemode-launch-"));
  const temporarySourcePath = resolve(temporaryDirectory, "codemode-deno-launch.ts");
  try {
    await copyFile(sourcePath, temporarySourcePath);
    const launchModule = await import(
      `${pathToFileURL(temporarySourcePath).href}?loaded=${Date.now()}`
    );
    return {
      launch: launchModule.resolveCodeModeDenoLaunch(
        workerPath,
        variant,
        CODEMODE_WORKER_SMOKE_SESSION_ID,
      ),
      temporaryDirectory,
    };
  } catch (cause) {
    await rm(temporaryDirectory, { force: true, recursive: true });
    throw cause;
  }
}

function assertProtocolEnvelope(message, expectedType) {
  if (
    message?.version !== CODEMODE_WORKER_PROTOCOL_VERSION ||
    message?.type !== expectedType ||
    message?.sessionId !== CODEMODE_WORKER_SMOKE_SESSION_ID
  ) {
    throw new Error(`unexpected ${expectedType} response ${JSON.stringify(message)}`);
  }
}

/** Starts the shipped source-TypeScript Deno process, evaluates in QuickJS, and waits for exit. */
export async function assertCodeModeDenoProcessSmoke(workerPath, label, variant = "release") {
  const { launch, temporaryDirectory } = await loadCodeModeDenoLaunch(workerPath, variant);
  const worker = spawn(launch.command, launch.args, {
    env: { DENO_NO_UPDATE_CHECK: "1", NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let responseReceived = false;
  let settled = false;
  let stdout = "";
  let stderr = "";

  try {
    await new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        rejectSmoke(reject, label, "timed out");
      }, CODEMODE_WORKER_SMOKE_TIMEOUT_MS);

      function settle(callback) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        callback();
      }

      worker.stdout.setEncoding("utf8");
      worker.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      worker.stderr.setEncoding("utf8");
      worker.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      worker.on("error", (cause) => {
        settle(() => rejectSmoke(reject, label, cause.message));
      });
      worker.on("exit", (code) => {
        try {
          if (code !== 0) {
            throw new Error(`exited with code ${code}: ${stderr.trim()}`);
          }
          const lines = stdout.trimEnd().split("\n");
          const expectedLineCount = variant === "debug" ? 4 : 2;
          if (lines.length !== expectedLineCount) {
            throw new Error(`worker response is not ${expectedLineCount} bounded JSON lines`);
          }
          const ready = JSON.parse(lines[0]);
          const responseIndex = variant === "debug" ? 2 : 1;
          const response = JSON.parse(lines[responseIndex]);
          assertProtocolEnvelope(ready, "ready");
          assertProtocolEnvelope(response, "result");
          if (
            response.requestId !== "step-1-tracer" ||
            response.resultJson !== JSON.stringify(CODEMODE_WORKER_SMOKE_RESULT)
          ) {
            throw new Error(`unexpected tracer response ${stdout.trimEnd()}`);
          }
          if (variant === "debug") {
            const baseline = JSON.parse(lines[1]);
            const after = JSON.parse(lines[3]);
            assertProtocolEnvelope(baseline, "debug-memory");
            assertProtocolEnvelope(after, "debug-memory");
            for (const memory of [baseline, after]) {
              if (
                !Number.isSafeInteger(memory.memory?.mallocCount) ||
                memory.memory.mallocCount <= 0 ||
                !Number.isSafeInteger(memory.memory?.memoryUsedBytes) ||
                memory.memory.memoryUsedBytes <= 0 ||
                !Number.isSafeInteger(memory.memory?.objectCount) ||
                memory.memory.objectCount <= 0
              ) {
                throw new Error(`invalid QuickJS module memory response ${JSON.stringify(memory)}`);
              }
            }
            if (
              baseline.requestId !== "debug-memory-before" ||
              after.requestId !== "debug-memory-after" ||
              after.memory.objectCount !== baseline.memory.objectCount ||
              after.memory.mallocCount !== baseline.memory.mallocCount ||
              after.memory.memoryUsedBytes !== baseline.memory.memoryUsedBytes
            ) {
              throw new Error(
                `QuickJS tracer handles were retained: baseline=${JSON.stringify(baseline.memory)} after=${JSON.stringify(after.memory)}`,
              );
            }
          }
          responseReceived = true;
          settle(resolvePromise);
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          settle(() => rejectSmoke(reject, label, message));
        }
      });

      const messages = [
        ...(variant === "debug"
          ? [
              {
                version: CODEMODE_WORKER_PROTOCOL_VERSION,
                type: "debug-memory",
                sessionId: CODEMODE_WORKER_SMOKE_SESSION_ID,
                requestId: "debug-memory-before",
              },
            ]
          : []),
        {
          version: CODEMODE_WORKER_PROTOCOL_VERSION,
          type: "evaluate",
          sessionId: CODEMODE_WORKER_SMOKE_SESSION_ID,
          requestId: "step-1-tracer",
          script: "6 * 7",
        },
        ...(variant === "debug"
          ? [
              {
                version: CODEMODE_WORKER_PROTOCOL_VERSION,
                type: "debug-memory",
                sessionId: CODEMODE_WORKER_SMOKE_SESSION_ID,
                requestId: "debug-memory-after",
              },
            ]
          : []),
        {
          version: CODEMODE_WORKER_PROTOCOL_VERSION,
          type: "shutdown",
          sessionId: CODEMODE_WORKER_SMOKE_SESSION_ID,
        },
      ];
      worker.stdin.end(`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`);
    });
  } finally {
    if (!settled || !responseReceived) worker.kill();
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

const invokedScriptPath = process.argv[1];
if (invokedScriptPath !== undefined && pathToFileURL(invokedScriptPath).href === import.meta.url) {
  const workerPath = process.argv[2];
  const label = process.argv[3] ?? "command line";
  const variant = process.argv[4] === "debug" ? "debug" : "release";
  if (workerPath === undefined) {
    throw new Error("CodeMode worker smoke failed (command line): missing worker path");
  }
  await assertCodeModeDenoProcessSmoke(workerPath, label, variant);
}
