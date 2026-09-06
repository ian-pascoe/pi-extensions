// Real Pi SDK + scratch journals; only the model/network boundary is fake.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { checkpointPrototype } from "./checkpoint-adapter.mjs";

process.env.PI_OFFLINE = "1";
globalThis.fetch = async () => {
  throw new Error("Prototype must not make network requests");
};
const entry = process.env.PI_CONTEXT_PROTOTYPE_SDK
  ? join(resolve(process.env.PI_CONTEXT_PROTOTYPE_SDK), "dist/index.js")
  : fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const sdk = await import(pathToFileURL(entry).href);
assert.equal(
  sdk.VERSION,
  "0.85.1",
  "Select Pi 0.85.1 with PI_CONTEXT_PROTOTYPE_SDK=/path/to/package; do not install or change dependencies",
);
const ai = await import(
  pathToFileURL(join(dirname(dirname(entry)), "../pi-ai/dist/index.js")).href
);
const compat = await import(
  pathToFileURL(join(dirname(dirname(entry)), "../pi-ai/dist/compat.js")).href
);
console.log(`Prototype target: Pi ${sdk.VERSION} (${entry})`);

const text = (value) => JSON.stringify(value);
const call = (id, handoff) => [
  { type: "toolCall", id, name: "context_rollover", arguments: { handoff } },
];
const checkpoints = (manager) => manager.getBranch().filter((e) => e.type === "compaction");

function assertPairs(messages) {
  const pending = new Set();
  for (const message of messages) {
    if (message.role === "assistant") {
      assert.equal(pending.size, 0, "New assistant before all prior tool results");
      for (const part of message.content) if (part.type === "toolCall") pending.add(part.id);
    }
    if (message.role === "toolResult") {
      assert.ok(pending.delete(message.toolCallId), `Orphan result ${message.toolCallId}`);
    }
  }
  assert.equal(pending.size, 0, "Missing tool results");
}

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-context-PROTOTYPE-"));
  const manager = sdk.SessionManager.create(dir, dir);
  const settings = sdk.SettingsManager.inMemory({
    compaction: { enabled: true, keepRecentTokens: 20_000, reserveTokens: 16_384 },
    retry: { enabled: false },
  });
  const prototype = checkpointPrototype(sdk, options);
  const loader = new sdk.DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [...(options.before ?? []), prototype.extension, ...(options.after ?? [])],
    systemPromptOverride: () => "PROTOTYPE standing instructions: continue the saved task.",
  });
  await loader.reload();
  const modelRuntime = await sdk.ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore(),
    modelsStore: new ai.InMemoryModelsStore(),
    modelsPath: join(dir, "models.json"),
    allowModelNetwork: false,
  });
  await modelRuntime.setRuntimeApiKey("anthropic", "PROTOTYPE-NOT-A-REAL-KEY");
  const { session } = await sdk.createAgentSession({
    cwd: dir,
    agentDir: dir,
    sessionManager: manager,
    settingsManager: settings,
    resourceLoader: loader,
    modelRuntime,
    model: compat.getModel("anthropic", "claude-sonnet-4-5"),
    noTools: "builtin",
  });
  t.after(async () => {
    session.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  const events = [];
  session.subscribe((e) => events.push(e));
  await session.bindExtensions({ mode: "rpc" });
  const requests = [];
  const responses = [];
  session.agent.streamFunction = (model, context, requestOptions) => {
    requestOptions?.signal?.throwIfAborted();
    requests.push({
      systemPrompt: context.systemPrompt,
      messages: structuredClone(context.messages),
      tools: (context.tools ?? []).map((tool) => tool.name),
    });
    const next = responses.shift();
    assert.ok(next, "Unexpected model request (including any accidental summarizer)");
    const stream = ai.createAssistantMessageEventStream();
    queueMicrotask(() => {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Closed fake-model fixture union, not production input parsing.
      const content = typeof next === "string" ? [{ type: "text", text: next }] : next;
      const message = {
        ...ai.fauxAssistantMessage(""),
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        stopReason: content.some((p) => p.type === "toolCall") ? "toolUse" : "stop",
        usage: {
          input: options.usageInput ?? 100,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: (options.usageInput ?? 100) + 10,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      if (next === "OVERFLOW") {
        message.stopReason = "error";
        message.errorMessage = "prompt is too long: 300000 tokens > 200000 maximum";
        stream.push({ type: "error", reason: "error", error: message });
      } else stream.push({ type: "done", reason: message.stopReason, message });
    });
    return stream;
  };
  return { dir, manager, settings, session, requests, responses, events, ...prototype };
}

test("early mid-loop Rollover commits a native checkpoint and continues without old context", async (t) => {
  const f = await fixture(t, { tailTokens: 128 });
  f.responses.push(
    call("roll-1", "Continue checking the blue widget."),
    "Finished the blue widget.",
  );
  await f.session.prompt(`OLD-ONLY secret ${"discard ".repeat(3000)}`);
  assert.deepEqual(f.state.errors, []);
  assert.equal(checkpoints(f.manager).length, 1, text(f.session.messages).slice(-3000));
  assert.equal(f.requests.length, 2);
  assert.match(text(f.requests[1]), /Continue checking the blue widget/);
  assert.doesNotMatch(text(f.requests[1]), /OLD-ONLY/);
  assert.deepEqual(f.session.messages, f.manager.buildSessionContext().messages);
  const reopened = sdk.SessionManager.open(f.manager.getSessionFile());
  assert.equal(text(reopened.buildSessionContext()), text(f.manager.buildSessionContext()));
  assertPairs(f.requests[1].messages);
  assert.match(f.requests[1].systemPrompt, /PROTOTYPE standing instructions/);
  assert.ok(f.requests[1].tools.includes("context_rollover"));
  assert.equal(
    reopened.getBranch().filter((e) => e.type === "message" && text(e.message).includes("OLD-ONLY"))
      .length,
    1,
  );
});

test("zero Tail commits a real cutoff without retaining orphan results", async (t) => {
  const f = await fixture(t, { tailTokens: 0 });
  f.responses.push(call("roll-zero", "Continue from notes."), "Done.");
  await f.session.prompt("Initial task");
  assert.deepEqual(f.state.errors, []);
  assert.equal(checkpoints(f.manager).length, 1);
  assert.equal(f.requests[1].messages.length, 1);
  assertPairs(f.requests[1].messages);
  const checkpoint = checkpoints(f.manager)[0];
  assert.ok(f.manager.getEntry(checkpoint.firstKeptEntryId), "No nonexistent sentinel ID");
  assert.equal(
    sdk.SessionManager.open(f.manager.getSessionFile()).buildSessionContext().messages.length,
    2,
  );
});

test("native manual compaction uses our checkpoint, not a summarizer or cancellation", async (t) => {
  const f = await fixture(t, { tailTokens: 128 });
  f.settings.applyOverrides({ compaction: { keepRecentTokens: 1 } });
  f.responses.push("Ready.");
  await f.session.prompt(`OLD-NATIVE ${"discard ".repeat(3000)}`);
  const result = await f.session.compact();
  assert.match(result.summary, /Recover task from archived History/);
  assert.equal(f.requests.length, 1, "No summary model request");
  assert.equal(checkpoints(f.manager)[0].fromHook, true);
  assert.deepEqual(f.session.messages, f.manager.buildSessionContext().messages);
  assert.ok(f.events.some((e) => e.type === "compaction_end" && !e.aborted));
});

test("multiple checkpoints survive native inheritance, fork, and branch navigation", async (t) => {
  const f = await fixture(t, { tailTokens: 0 });
  f.responses.push(call("first", "Window one."), "First complete.");
  await f.session.prompt("Original task");
  const firstLeaf = f.manager.getLeafId();
  f.responses.push(call("second", "Window two."), "Second complete.");
  await f.session.prompt("Second phase");
  assert.equal(checkpoints(f.manager).length, 2);
  // This is the exact native builder used by Minimal Subagents' inherit path, not a mock.
  const inherited = sdk.buildSessionContext(f.manager.getBranch()).messages;
  assert.deepEqual(inherited, f.session.messages);
  assert.match(text(inherited), /Window two/);
  assert.doesNotMatch(text(inherited), /Window one/);
  const fork = sdk.SessionManager.forkFrom(f.manager.getSessionFile(), f.dir, f.dir);
  assert.equal(text(fork.buildSessionContext().messages), text(inherited));
  assert.ok(fork.getBranch().some((e) => e.type === "compaction"));
  await f.session.navigateTree(firstLeaf, { summarize: false });
  assert.match(text(f.session.messages), /Window one/);
  assert.doesNotMatch(text(f.session.messages), /Window two/);
});

test("write failure preserves the old active window and acknowledged Notes, then stops", async (t) => {
  let beforeFailure;
  const f = await fixture(t, {
    tailTokens: 128,
    before: [
      (pi) => {
        pi.on("turn_end", (event, ctx) => {
          if (!event.message.content.some((p) => p.type === "toolCall")) return;
          beforeFailure = text(sdk.buildSessionContext(ctx.sessionManager.getBranch()).messages);
          chmodSync(ctx.sessionManager.getSessionFile(), 0o400);
        });
      },
    ],
  });
  f.responses.push("Ready.");
  await f.session.prompt("Original task");
  f.manager.appendCustomEntry("prototype-note", { body: "ACKNOWLEDGED NOTE" });
  f.responses.push(call("failed", "Uncommitted handoff."));
  try {
    await assert.rejects(f.session.prompt("Please roll over"), /EACCES/);
  } finally {
    chmodSync(f.manager.getSessionFile(), 0o600);
  }
  assert.equal(f.state.errors.length, 1);
  assert.match(f.state.errors[0], /EACCES/);
  assert.equal(f.state.commits.length, 0);
  assert.equal(checkpoints(f.manager).length, 0);
  assert.equal(
    text(f.manager.buildSessionContext().messages.slice(0, JSON.parse(beforeFailure).length)),
    beforeFailure,
  );
  assert.equal(f.requests.length, 2, "No follow-up request after failed commit");
  const reopened = sdk.SessionManager.open(f.manager.getSessionFile());
  assert.equal(checkpoints(reopened).length, 0);
  assert.ok(
    reopened.getBranch().some((e) => e.type === "custom" && e.customType === "prototype-note"),
  );
  // Characterize the remaining limitation rather than hiding it as an atomic commit.
  assert.equal(f.manager.getEntries().filter((e) => e.type === "compaction").length, 1);
  assert.equal(reopened.getEntries().filter((e) => e.type === "compaction").length, 0);
  t.diagnostic(
    "BLOCKER: Pi retains ghost entries in memory and cannot persist its abort response; reload required after write failure.",
  );
  if (process.env.PI_CONTEXT_PROTOTYPE_GATE === "1") {
    assert.equal(
      text(f.manager.getEntries()),
      text(reopened.getEntries()),
      "STRICT GATE: live and persisted journal disagree after failed commit",
    );
  }
});

test("native threshold compaction succeeds without an extra model call", async (t) => {
  const f = await fixture(t, {
    tailTokens: 128,
    usageInput: compat.getModel("anthropic", "claude-sonnet-4-5").contextWindow,
  });
  f.settings.applyOverrides({ compaction: { keepRecentTokens: 1 } });
  f.responses.push("Completed.");
  await f.session.prompt("Threshold task");
  assert.equal(f.requests.length, 1);
  assert.equal(checkpoints(f.manager).length, 1);
  assert.equal(checkpoints(f.manager)[0].details.reason, "threshold");
  assert.equal(checkpoints(f.manager)[0].fromHook, true);
});

test("native overflow retries once and does not resurrect its failed response on resume", async (t) => {
  const f = await fixture(t, { tailTokens: 128 });
  f.settings.applyOverrides({ compaction: { keepRecentTokens: 1 } });
  f.responses.push("OVERFLOW", "Recovered.");
  await f.session.prompt(`Original task ${"history ".repeat(3000)}`);
  assert.equal(f.requests.length, 2);
  assert.equal(checkpoints(f.manager).length, 1);
  assert.equal(checkpoints(f.manager)[0].details.reason, "overflow");
  assert.doesNotMatch(text(f.requests[1]), /300000 tokens/);
  const reopened = sdk.SessionManager.open(f.manager.getSessionFile());
  assert.doesNotMatch(text(reopened.buildSessionContext()), /300000 tokens/);
  assert.ok(
    reopened.getBranch().some((e) => e.message?.stopReason === "error"),
    "Failed response remains in History",
  );
});

test("repeated overflow stops rather than starting another recovery loop", async (t) => {
  const f = await fixture(t, { tailTokens: 128 });
  f.settings.applyOverrides({ compaction: { keepRecentTokens: 1 } });
  f.responses.push("OVERFLOW", "OVERFLOW");
  await f.session.prompt(`Original task ${"history ".repeat(3000)}`);
  assert.equal(f.requests.length, 2);
  assert.equal(checkpoints(f.manager).length, 1);
});

test("cancellation before the commit point creates no checkpoint or follow-up request", async (t) => {
  const f = await fixture(t, {
    before: [
      (pi) => {
        pi.on("turn_end", (event, ctx) => {
          if (event.message.content.some((p) => p.type === "toolCall")) ctx.abort();
        });
      },
    ],
  });
  f.responses.push(call("cancelled", "Must not commit."));
  await f.session.prompt("Cancel this rollover");
  assert.equal(f.requests.length, 1);
  assert.equal(checkpoints(f.manager).length, 0);
  assert.equal(f.state.commits.length, 0);
});

test("non-isolated rollover is rejected before any checkpoint mutation", async (t) => {
  const f = await fixture(t);
  f.responses.push([...call("a", "A"), ...call("b", "B")], "Will retry separately.");
  await f.session.prompt("Parallel batch");
  assert.equal(checkpoints(f.manager).length, 0);
  assert.equal(f.state.commits.length, 0);
  const results = f.requests[1].messages.filter((m) => m.role === "toolResult");
  assert.equal(results.length, 2);
  assert.ok(results.every((m) => m.isError));
  assertPairs(f.requests[1].messages);
});

for (const position of ["before", "after"]) {
  test(`live projections and prompt replay survive with companion hook ${position}`, async (t) => {
    const companion = (pi) => {
      pi.on("before_agent_start", (event) => ({
        systemPrompt: `${event.systemPrompt}\nMCP standing instructions`,
      }));
      pi.on("context", (event) => ({
        messages: [
          ...event.messages.flatMap((m) =>
            m.role === "custom" && m.customType === "prototype-mcp"
              ? [{ role: "user", content: "MCP prompt replay", timestamp: m.timestamp }]
              : [m],
          ),
          {
            role: "custom",
            customType: "pi-todo-context",
            content: "LIVE TODO LIST",
            display: false,
            timestamp: Date.now(),
          },
        ],
      }));
    };
    const f = await fixture(t, { tailTokens: 512, [position]: [companion] });
    f.responses.push("Ready.");
    await f.session.prompt(`OLD-ONLY ${"discard ".repeat(3000)}`);
    f.manager.appendCustomMessageEntry("prototype-mcp", "encoded replay", false);
    f.session.agent.state.messages = f.manager.buildSessionContext().messages;
    f.responses.push(call("projected", "Continue task."), "Done.");
    await f.session.prompt("Roll over now");
    assert.equal(checkpoints(f.manager).length, 1);
    assert.match(text(f.requests[2]), /LIVE TODO LIST/);
    assert.match(text(f.requests[2]), /MCP prompt replay/);
    assert.match(f.requests[2].systemPrompt, /MCP standing instructions/);
    assert.doesNotMatch(text(f.requests[2]), /OLD-ONLY/);
    assertPairs(f.requests[2].messages);
  });
}

test("the version guard rejects an untested Pi release before extension registration", () => {
  assert.throws(() => checkpointPrototype({ ...sdk, VERSION: "0.85.0" }), /Untested Pi version/);
});
