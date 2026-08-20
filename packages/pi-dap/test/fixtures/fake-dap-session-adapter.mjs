let buffer = Buffer.alloc(0);
let nextSequence = 1;
let pendingLaunch;
let launchArguments = {};
let desiredBreakpoints = new Map();
let reverseRequestSequence;

function send(message) {
  const body = Buffer.from(JSON.stringify({ seq: nextSequence++, ...message }));
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function respond(request, body) {
  const response = {
    type: "response",
    request_seq: request.seq,
    success: true,
    command: request.command,
  };
  if (body !== undefined) response.body = body;
  send(response);
}

function fail(request, message) {
  send({
    type: "response",
    request_seq: request.seq,
    success: false,
    command: request.command,
    message,
  });
}

function event(event, body) {
  const message = { type: "event", event };
  if (body !== undefined) message.body = body;
  send(message);
}

function stopped(reason = "breakpoint") {
  event("stopped", { reason, threadId: 1, allThreadsStopped: true });
}

function executeAndStop(request, reason) {
  respond(request, { allThreadsContinued: true });
  event("continued", { threadId: 1, allThreadsContinued: true });
  setTimeout(() => stopped(reason), 5);
}

function handleReverseResponse(message) {
  if (message.request_seq !== reverseRequestSequence) return;
  reverseRequestSequence = undefined;
  if (launchArguments.requestStartDebugging === true) {
    if (message.success) {
      fail(pendingLaunch, "startDebugging unexpectedly succeeded");
    } else {
      fail(pendingLaunch, "startDebugging rejected");
    }
    pendingLaunch = undefined;
    return;
  }
  if (!message.success) {
    fail(pendingLaunch, "runInTerminal rejected");
    pendingLaunch = undefined;
  }
}

function handleRequest(request) {
  switch (request.command) {
    case "initialize":
      respond(request, {
        supportsConfigurationDoneRequest: true,
        supportsTerminateRequest: true,
      });
      return;
    case "launch":
      pendingLaunch = request;
      launchArguments = request.arguments ?? {};
      if (launchArguments.requestStartDebugging === true) {
        reverseRequestSequence = nextSequence;
        send({
          type: "request",
          command: "startDebugging",
          arguments: { configuration: {} },
        });
      } else if (Array.isArray(launchArguments.runInTerminalArgs)) {
        reverseRequestSequence = nextSequence;
        send({
          type: "request",
          command: "runInTerminal",
          arguments: {
            kind: "integrated",
            cwd: process.cwd(),
            args: launchArguments.runInTerminalArgs,
            env: {},
            argsCanBeInterpretedByShell: false,
          },
        });
      }
      if (Number.isInteger(launchArguments.delayInitializedMs)) {
        setTimeout(() => event("initialized"), launchArguments.delayInitializedMs);
      } else {
        event("initialized");
      }
      return;
    case "setBreakpoints": {
      const sourcePath = request.arguments?.source?.path ?? "";
      const requested = request.arguments?.breakpoints ?? [];
      if (requested.some((breakpoint) => breakpoint.condition === "fail")) {
        fail(request, "breakpoint rejected");
        return;
      }
      desiredBreakpoints.set(sourcePath, requested);
      respond(request, {
        breakpoints: requested.map((breakpoint, index) => ({
          id: index + 1,
          verified: true,
          line: breakpoint.line,
          source: { path: sourcePath },
        })),
      });
      return;
    }
    case "configurationDone":
      if (launchArguments.requireBreakpoint === true && desiredBreakpoints.size === 0) {
        fail(request, "configurationDone arrived before breakpoints");
        return;
      }
      respond(request);
      if (pendingLaunch !== undefined) {
        respond(pendingLaunch);
        pendingLaunch = undefined;
        event("output", { category: "stdout", output: "launched\n" });
        if (launchArguments.stopOnEntry !== false) setTimeout(() => stopped("entry"), 5);
      }
      return;
    case "threads":
      respond(request, { threads: [{ id: 1, name: "main" }] });
      return;
    case "stackTrace": {
      const frames = [
        {
          id: 10,
          name: "main",
          line: 4,
          column: 1,
          source: { name: "program.ts", path: launchArguments.program ?? "program.ts" },
        },
        { id: 11, name: "caller", line: 1, column: 1 },
      ];
      const start = request.arguments?.startFrame ?? 0;
      const levels = request.arguments?.levels ?? frames.length;
      respond(request, {
        stackFrames: frames.slice(start, start + levels),
        totalFrames: frames.length,
      });
      return;
    }
    case "scopes":
      respond(request, {
        scopes: [{ name: "Local", variablesReference: 20, expensive: false }],
      });
      return;
    case "variables":
      respond(request, {
        variables: [
          { name: "answer", value: "42", variablesReference: 0, type: "number" },
          { name: "nested", value: "Object", variablesReference: 21 },
        ].slice(
          request.arguments?.start ?? 0,
          (request.arguments?.start ?? 0) + (request.arguments?.count ?? 100),
        ),
      });
      return;
    case "evaluate":
      respond(request, {
        result: String(request.arguments?.expression ?? ""),
        variablesReference: 0,
      });
      return;
    case "continue":
      respond(request, { allThreadsContinued: true });
      event("continued", { threadId: 1, allThreadsContinued: true });
      if (launchArguments.crashOnContinue === true) {
        process.stderr.write("fake adapter crash\n", () => process.exit(17));
      } else if (launchArguments.exitOnContinue === true) {
        setTimeout(() => {
          event("output", { category: "stdout", output: "finished\n" });
          event("exited", { exitCode: 0 });
          event("terminated");
        }, 5);
      } else if (launchArguments.neverStop !== true) {
        setTimeout(() => stopped("breakpoint"), 5);
      }
      return;
    case "next":
      executeAndStop(request, "step");
      return;
    case "stepIn":
      executeAndStop(request, "step");
      return;
    case "stepOut":
      executeAndStop(request, "step");
      return;
    case "pause":
      respond(request);
      setTimeout(() => stopped("pause"), 5);
      return;
    case "terminate":
      respond(request);
      event("terminated");
      return;
    case "disconnect":
      respond(request);
      setTimeout(() => process.exit(0), 5);
      return;
    default:
      fail(request, `unsupported ${request.command}`);
  }
}

function parseFrames(chunk) {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const length = Number(/^Content-Length: (\d+)$/im.exec(header)?.[1]);
    if (!Number.isSafeInteger(length) || buffer.length < headerEnd + 4 + length) return;
    const bodyStart = headerEnd + 4;
    const message = JSON.parse(buffer.subarray(bodyStart, bodyStart + length).toString("utf8"));
    buffer = buffer.subarray(bodyStart + length);
    if (message.type === "request") handleRequest(message);
    if (message.type === "response") handleReverseResponse(message);
  }
}

process.stdin.on("data", parseFrames);
process.stdin.on("end", () => process.exit(0));

// Keep stderr non-empty so failures can point to a useful retained log.
process.stderr.write("fake DAP session adapter started\n");
