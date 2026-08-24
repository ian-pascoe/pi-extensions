import { spawn } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CODEMODE_WORKER_SMOKE_TIMEOUT_MS = 30_000;
const CODEMODE_WORKER_PROTOCOL_VERSION = 1;
const CODEMODE_WORKER_SMOKE_RESULT = 42;
const CODEMODE_WORKER_SMOKE_SESSION_ID = "smoke-session";
const CODEMODE_WORKER_SMOKE_CELL_ID = "native-typescript-cell";
const CODEMODE_WORKER_SMOKE_PLACEHOLDER = "__piCodeModeCellInternal";
const CODEMODE_WORKER_SMOKE_SOURCE = `
type Answer = number;
if (
  typeof eval !== "undefined" ||
  typeof Function !== "undefined" ||
  (() => {}).constructor !== undefined ||
  (async () => {}).constructor !== undefined ||
  (function* () {}).constructor !== undefined ||
  (async function* () {}).constructor !== undefined
) {
  throw new Error("dynamic code constructors are exposed");
}
await ${CODEMODE_WORKER_SMOKE_PLACEHOLDER}.declare([["answer", "const"]], async () => {
  ${CODEMODE_WORKER_SMOKE_PLACEHOLDER}.init["answer"] = 6 * 7 satisfies Answer;
});
console.log("answer:", answer);
return answer;
`;

function rejectSmoke(reject, label, message) {
  reject(new Error(`CodeMode worker smoke failed (${label}): ${message}`));
}

async function loadCodeModeDenoLaunch(workerPath) {
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
      launch: launchModule.resolveCodeModeDenoLaunch(workerPath, CODEMODE_WORKER_SMOKE_SESSION_ID),
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

/** Starts the shipped source-TypeScript Deno process, executes a native TypeScript Cell, and waits for exit. */
export async function assertCodeModeDenoProcessSmoke(workerPath, label) {
  const { launch, temporaryDirectory } = await loadCodeModeDenoLaunch(workerPath);
  const worker = spawn(launch.command, launch.args, {
    env: { DENO_NO_UPDATE_CHECK: "1", NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let responseReceived = false;
  let settled = false;
  let stdout = "";
  let pendingStdout = "";
  let stderr = "";
  const messages = [];

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

      function send(message) {
        worker.stdin.write(`${JSON.stringify(message)}\n`);
      }

      function acceptMessage(message) {
        messages.push(message);
        if (message.type === "ready") {
          assertProtocolEnvelope(message, "ready");
          send({
            version: CODEMODE_WORKER_PROTOCOL_VERSION,
            type: "execute",
            sessionId: CODEMODE_WORKER_SMOKE_SESSION_ID,
            cellId: CODEMODE_WORKER_SMOKE_CELL_ID,
            source: CODEMODE_WORKER_SMOKE_SOURCE,
            internalIdentifierPlaceholder: CODEMODE_WORKER_SMOKE_PLACEHOLDER,
            toolNames: [],
          });
          return;
        }
        if (message.type === "cell-error") {
          throw new Error(`native TypeScript Cell failed ${JSON.stringify(message.error)}`);
        }
        assertProtocolEnvelope(message, "cell-result");
        if (
          message.cellId !== CODEMODE_WORKER_SMOKE_CELL_ID ||
          message.resultJson !== JSON.stringify(CODEMODE_WORKER_SMOKE_RESULT) ||
          JSON.stringify(message.console) !==
            JSON.stringify([{ method: "log", text: "answer: 42" }])
        ) {
          throw new Error(`unexpected native TypeScript result ${JSON.stringify(message)}`);
        }
        responseReceived = true;
        worker.stdin.end(
          `${JSON.stringify({
            version: CODEMODE_WORKER_PROTOCOL_VERSION,
            type: "shutdown",
            sessionId: CODEMODE_WORKER_SMOKE_SESSION_ID,
          })}\n`,
        );
      }

      worker.stdout.setEncoding("utf8");
      worker.stdout.on("data", (chunk) => {
        stdout += chunk;
        pendingStdout += chunk;
        let newlineIndex = pendingStdout.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = pendingStdout.slice(0, newlineIndex);
          pendingStdout = pendingStdout.slice(newlineIndex + 1);
          if (line.length > 0) {
            try {
              acceptMessage(JSON.parse(line));
            } catch (cause) {
              const message = cause instanceof Error ? cause.message : String(cause);
              settle(() => rejectSmoke(reject, label, message));
              worker.kill();
              return;
            }
          }
          newlineIndex = pendingStdout.indexOf("\n");
        }
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
          if (!responseReceived || messages.length !== 2 || pendingStdout.length !== 0) {
            throw new Error(`worker emitted unexpected bounded JSON lines: ${stdout.trimEnd()}`);
          }
          settle(resolvePromise);
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          settle(() => rejectSmoke(reject, label, message));
        }
      });
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
  if (workerPath === undefined) {
    throw new Error("CodeMode worker smoke failed (command line): missing worker path");
  }
  await assertCodeModeDenoProcessSmoke(workerPath, label);
}
