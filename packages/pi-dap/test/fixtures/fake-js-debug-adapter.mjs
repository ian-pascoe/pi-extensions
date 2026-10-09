// Offline stand-in for vscode-js-debug's TCP channels: a root channel that sends `startDebugging`,
// one primary target channel, and, for the `children` scripts, Child session channels the primary
// target asks for. FAKE_JS_DEBUG_SCRIPT picks how the Debuggee ends and what its children do.
import { createServer } from "node:net";

const port = Number(process.argv[2]);
const script = process.env.FAKE_JS_DEBUG_SCRIPT ?? "clean";
let nextSequence = 1;
let root;
let target;
let pendingRootLaunch;
/** Child session names the primary target asks for, by script. */
const childNames =
  { children: ["worker-a", "worker-b"], "child-running": ["worker-a"] }[script] ?? [];
const pendingChildNames = [...childNames];
let liveChildren = childNames.length;

function frame(message) {
  const payload = Buffer.from(JSON.stringify({ seq: nextSequence++, ...message }));
  return Buffer.concat([
    Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "ascii"),
    payload,
  ]);
}

function channel(socket, onMessage) {
  let input = Buffer.alloc(0);
  const send = (message) => socket.write(frame(message));
  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    input = Buffer.concat([input, chunk]);
    for (;;) {
      const end = input.indexOf("\r\n\r\n");
      if (end < 0) return;
      const length = Number(/Content-Length: (\d+)/u.exec(input.subarray(0, end).toString())[1]);
      if (input.length < end + 4 + length) return;
      const message = JSON.parse(input.subarray(end + 4, end + 4 + length).toString());
      input = input.subarray(end + 4 + length);
      onMessage(message, send);
    }
  });
  return send;
}

const respond = (send, request, body = {}) =>
  send({
    type: "response",
    request_seq: request.seq,
    success: true,
    command: request.command,
    body,
  });
const event = (send, name, body = {}) => send({ type: "event", event: name, body });

function endDebuggee() {
  const exitReport = (send, code) =>
    event(send, "output", { category: "stderr", output: `Process exited with code ${code}\r\n` });
  const later = (milliseconds, action) => setTimeout(() => action(), milliseconds);
  switch (script) {
    case "target-first":
      event(target, "terminated");
      later(30, () => exitReport(root, 3));
      later(60, () => event(root, "terminated", { restart: false }));
      break;
    case "root-first":
      exitReport(root, 3);
      event(root, "terminated", { restart: false });
      later(60, () => event(target, "terminated"));
      break;
    case "children":
    case "clean":
      event(target, "terminated");
      later(30, () => event(root, "terminated", { restart: false }));
      break;
    case "spoof":
      // Debuggee output on the target channel never carries the adapter's exit report.
      event(target, "output", { category: "stderr", output: "Process exited with code 7\n" });
      event(target, "terminated");
      later(30, () => event(root, "terminated", { restart: false }));
      break;
    case "target-only":
      event(target, "terminated");
      break;
  }
}

/** Requests any target answers the same way, naming the target so routing is observable. */
function targetRequest(send, message, name) {
  switch (message.command) {
    case "threads":
      respond(send, message, { threads: [{ id: 1, name: "main" }] });
      return;
    case "stackTrace":
      respond(send, message, {
        stackFrames: [{ id: 1, name, line: 1, column: 1, source: { path: `/${name}.js` } }],
      });
      return;
    case "evaluate":
      respond(send, message, { result: name, variablesReference: 0 });
      return;
    case "pause":
      respond(send, message);
      event(send, "stopped", { reason: "pause", threadId: 1 });
      return;
    default:
      respond(send, message);
  }
}

createServer((socket) => {
  if (root === undefined) {
    root = channel(socket, (message, send) => {
      if (message.type === "response") {
        respond(pendingRootLaunch.send, pendingRootLaunch.request);
        return;
      }
      if (message.command === "initialize") {
        respond(send, message, { supportsConfigurationDoneRequest: true });
      } else if (message.command === "launch") {
        pendingRootLaunch = { send, request: message };
        event(send, "initialized");
        send({
          type: "request",
          command: "startDebugging",
          arguments: {
            request: "launch",
            configuration: { type: "pwa-node", __pendingTargetId: "target-1" },
          },
        });
      } else if (message.command === "setBreakpoints") {
        respond(send, message, { breakpoints: [] });
      } else {
        respond(send, message);
      }
    });
    return;
  }
  if (target === undefined) {
    target = channel(socket, (message, send) => {
      if (message.type === "response") return;
      if (message.command === "initialize") {
        respond(send, message, { supportsConfigurationDoneRequest: true });
        event(send, "initialized");
      } else if (message.command === "configurationDone") {
        respond(send, message);
        if (childNames.length === 0) setTimeout(endDebuggee, 50);
        for (const name of childNames) {
          send({
            type: "request",
            command: "startDebugging",
            arguments: {
              request: "launch",
              configuration: { type: "pwa-node", name, __pendingTargetId: name },
            },
          });
        }
      } else if (message.command === "setBreakpoints") {
        // The primary target never loads the code the children run.
        const count = message.arguments.breakpoints.length;
        const breakpoints = Array.from({ length: count }, (_, index) => ({
          id: index + 1,
          verified: childNames.length === 0,
        }));
        respond(send, message, { breakpoints: childNames.length === 0 ? [] : breakpoints });
      } else {
        targetRequest(send, message, "primary");
      }
    });
    return;
  }
  const name = pendingChildNames.shift() ?? "unexpected";
  const idBase = (childNames.indexOf(name) + 1) * 100;
  channel(socket, (message, send) => {
    if (message.command === "initialize") {
      respond(send, message, { supportsConfigurationDoneRequest: true });
      event(send, "initialized");
    } else if (message.command === "setBreakpoints") {
      const count = message.arguments.breakpoints.length;
      respond(send, message, {
        breakpoints: Array.from({ length: count }, (_, index) => ({
          id: idBase + index,
          verified: true,
        })),
      });
    } else if (message.command === "configurationDone") {
      respond(send, message);
      if (script === "children") {
        setTimeout(
          () =>
            event(send, "stopped", {
              reason: "breakpoint",
              threadId: 1,
              hitBreakpointIds: [idBase],
            }),
          20,
        );
      }
    } else if (message.command === "continue" && script === "children") {
      respond(send, message);
      event(send, "terminated");
      liveChildren -= 1;
      if (liveChildren === 0) setTimeout(endDebuggee, 20);
    } else {
      targetRequest(send, message, name);
    }
  });
}).listen(port, "127.0.0.1");
