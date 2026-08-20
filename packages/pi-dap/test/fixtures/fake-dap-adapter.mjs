import { createServer } from "node:net";

let input = Buffer.alloc(0);
let nextSequence = 1;
let output;
const pendingReverseRequests = new Map();

function frame(message) {
  const payload = Buffer.from(JSON.stringify(message));
  return Buffer.concat([
    Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "ascii"),
    payload,
  ]);
}

function send(message) {
  output.write(frame(message));
}

function respond(request, success, body, message) {
  const response = {
    seq: nextSequence++,
    type: "response",
    request_seq: request.seq,
    success,
    command: request.command,
  };
  if (body !== undefined) response.body = body;
  if (message !== undefined) response.message = message;
  send(response);
}

function sendMalformedMode() {
  switch (process.env.FAKE_MODE) {
    case "malformed-header":
      output.write("Content-Length nope\r\n\r\n{}");
      break;
    case "missing-header":
      output.write("Content-Type: application/json\r\n\r\n{}");
      break;
    case "malformed-json":
      output.write("Content-Length: 1\r\n\r\n{");
      break;
    case "invalid-envelope": {
      const payload = Buffer.from(JSON.stringify({ seq: 1, type: "event" }));
      output.write(`Content-Length: ${payload.length}\r\n\r\n`);
      output.write(payload);
      break;
    }
    case "oversize":
      output.write(`Content-Length: ${8 * 1024 * 1024 + 1}\r\n\r\n`);
      break;
  }
}

async function handleRequest(request) {
  switch (request.command) {
    case "echo":
      respond(request, true, request.arguments);
      return;
    case "fail":
      respond(request, false, { reason: "fixture" }, "fixture failure");
      return;
    case "hang":
      return;
    case "fragment": {
      const response = frame({
        seq: nextSequence++,
        type: "response",
        request_seq: request.seq,
        success: true,
        command: request.command,
        body: { value: request.arguments?.value },
      });
      const chunks = request.arguments?.chunks ?? [1];
      let offset = 0;
      let index = 0;
      while (offset < response.length) {
        const length = Math.max(1, chunks[index % chunks.length] ?? 1);
        output.write(response.subarray(offset, offset + length));
        offset += length;
        index += 1;
        await new Promise((resolve) => setImmediate(resolve));
      }
      return;
    }
    case "coalesced":
      output.write(
        Buffer.concat([
          frame({
            seq: nextSequence++,
            type: "event",
            event: "fixture",
            body: { coalesced: true },
          }),
          frame({
            seq: nextSequence++,
            type: "response",
            request_seq: request.seq,
            success: true,
            command: request.command,
            body: { coalesced: true },
          }),
        ]),
      );
      return;
    case "inspect":
      respond(request, true, {
        argv: process.argv.slice(2),
        port: process.env.PORT,
        inherited: process.env.DAP_FIXTURE_INHERITED,
        removed: process.env.DAP_FIXTURE_REMOVED,
        pid: process.pid,
      });
      return;
    case "reverse": {
      const reverseSequence = nextSequence++;
      pendingReverseRequests.set(reverseSequence, request);
      send({
        seq: reverseSequence,
        type: "request",
        command: request.arguments?.command ?? "runInTerminal",
        arguments: request.arguments?.arguments ?? { title: "fixture" },
      });
      return;
    }
    case "terminate":
      if (process.env.FAKE_IGNORE_SHUTDOWN !== "1") respond(request, true, {});
      return;
    case "disconnect":
      if (process.env.FAKE_IGNORE_SHUTDOWN !== "1") {
        respond(request, true, {});
        setTimeout(() => process.exit(0), 5);
      }
      return;
    case "crash":
      process.stderr.write("fixture adapter crashed\n", () => process.exit(23));
      return;
    case "stderr-crash": {
      const bytes = Number(request.arguments?.bytes ?? 32);
      const prefix = "old-stderr-".repeat(Math.ceil(bytes / 11)).slice(0, bytes);
      process.stderr.write(`${prefix}LATEST-STDERR`, () => process.exit(24));
      return;
    }
    default:
      respond(request, false, undefined, `unknown fixture command ${request.command}`);
  }
}

function receive(message) {
  if (message.type === "request") {
    void handleRequest(message);
    return;
  }
  if (message.type === "response") {
    const original = pendingReverseRequests.get(message.request_seq);
    if (original === undefined) return;
    pendingReverseRequests.delete(message.request_seq);
    respond(original, true, {
      reverseSuccess: message.success,
      reverseBody: message.body,
      reverseMessage: message.message,
    });
  }
}

function push(chunk) {
  input = Buffer.concat([input, chunk]);
  for (;;) {
    const headerEnd = input.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = input.subarray(0, headerEnd).toString("ascii");
    const match = /^Content-Length: (\d+)$/m.exec(header);
    if (match === null) throw new Error("fixture received malformed frame");
    const length = Number(match[1]);
    if (input.length < headerEnd + 4 + length) return;
    const payload = input.subarray(headerEnd + 4, headerEnd + 4 + length);
    input = input.subarray(headerEnd + 4 + length);
    receive(JSON.parse(payload.toString("utf8")));
  }
}

function attach(readable, writable) {
  output = writable;
  readable.on("data", push);
  writable.on("error", () => {});
  sendMalformedMode();
  if (process.env.FAKE_MODE === "exit-on-connect") {
    process.stderr.write("fixture exited unexpectedly\n", () => process.exit(22));
  }
}

if (process.env.FAKE_IGNORE_SIGTERM === "1") process.on("SIGTERM", () => {});

const tcpIndex = process.argv.indexOf("--tcp");
if (tcpIndex >= 0) {
  const port = Number(process.argv[tcpIndex + 1]);
  if (process.env.FAKE_MODE === "no-listen") {
    setInterval(() => {}, 1000);
  } else {
    const server = createServer((socket) => {
      server.close();
      attach(socket, socket);
    });
    setTimeout(
      () => server.listen(port, "127.0.0.1"),
      Number(process.env.FAKE_LISTEN_DELAY_MS ?? 0),
    );
  }
} else {
  attach(process.stdin, process.stdout);
}
