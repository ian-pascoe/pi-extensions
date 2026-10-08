// Offline stand-in for vscode-js-debug's two TCP channels: a root channel that sends
// `startDebugging`, and one primary target channel. FAKE_JS_DEBUG_SCRIPT picks how the Debuggee ends.
import { createServer } from "node:net";

const port = Number(process.argv[2]);
const script = process.env.FAKE_JS_DEBUG_SCRIPT ?? "clean";
let nextSequence = 1;
let root;
let target;
let pendingRootLaunch;

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
      } else {
        respond(send, message);
      }
    });
    return;
  }
  target = channel(socket, (message, send) => {
    if (message.command === "initialize") {
      respond(send, message, { supportsConfigurationDoneRequest: true });
      event(send, "initialized");
    } else if (message.command === "configurationDone") {
      respond(send, message);
      setTimeout(endDebuggee, 50);
    } else if (message.command === "setBreakpoints") {
      respond(send, message, { breakpoints: [] });
    } else {
      respond(send, message);
    }
  });
}).listen(port, "127.0.0.1");
