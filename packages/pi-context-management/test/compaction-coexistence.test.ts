import { expect, it } from "vitest";
import type { AgentSession, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import contextManagement from "../src/context-management-extension.js";
import { createSdkHarness, overflow, reply, toolCall } from "./sdk-harness.js";

const compactionHandlers = (session: AgentSession) =>
  session.resourceLoader
    .getExtensions()
    .extensions.map((extension) => extension.handlers.get("session_before_compact")?.slice());

for (const position of ["before", "after"] as const) {
  const ordered = (other: ExtensionFactory) =>
    position === "before" ? [other, contextManagement] : [contextManagement, other];

  it.each([undefined, {}, { cancel: false }])(
    `allows a passive listener ${position} Context Management: %j`,
    async (result) => {
      let calls = 0;
      const f = await createSdkHarness(
        ordered((pi) => {
          pi.on("session_before_compact", () => {
            calls++;
            return result;
          });
        }),
      );
      f.responses.push(reply("Ready."));
      await f.session.prompt("Ordinary task " + "history ".repeat(3000));
      expect(f.requests).toHaveLength(1);
      const handlers = compactionHandlers(f.session);
      f.responses.push(overflow(), reply("Recovered."));
      await f.session.prompt("Trigger native overflow");
      expect(compactionHandlers(f.session)).toEqual(handlers);
      expect(f.providerRequests).toHaveLength(0);
      expect(calls).toBe(1);
      expect(f.requests).toHaveLength(3);
      expect(f.manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
      expect(f.session.messages).toEqual(f.manager.buildSessionContext().messages);
    },
  );

  it(`lets a hook ${position} Context Management cancel native overflow recovery`, async () => {
    let calls = 0;
    const f = await createSdkHarness(
      ordered((pi) => {
        pi.on("session_before_compact", () => {
          calls++;
          return { cancel: true };
        });
      }),
    );
    f.responses.push(reply("Ready."));
    await f.session.prompt("Ordinary task " + "history ".repeat(3000));
    const handlers = compactionHandlers(f.session);
    f.responses.push(overflow());
    await f.session.prompt("Trigger native overflow");
    expect(compactionHandlers(f.session)).toEqual(handlers);
    expect(calls).toBe(1);
    expect(f.providerRequests).toHaveLength(0);
    expect(f.manager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
    f.responses.push(reply("Still working."));
    await f.session.prompt("Continue without compacting");
    expect(f.requests).toHaveLength(3);
  });

  it.each(["rpc", "tui"] as const)(
    `claims manual compaction before a hook ${position} Context Management in %s`,
    async (mode) => {
      let calls = 0;
      const f = await createSdkHarness(
        ordered((pi) => {
          pi.on("session_before_compact", (event) => {
            calls++;
            return {
              compaction: {
                summary: "FOREIGN SUMMARY",
                firstKeptEntryId: event.preparation.firstKeptEntryId,
                tokensBefore: event.preparation.tokensBefore,
              },
            };
          });
        }),
      );
      f.responses.push(reply("Ready."));
      await f.session.prompt("Ordinary task " + "history ".repeat(3000));
      await f.session.bindExtensions({ mode });
      const handlers = compactionHandlers(f.session);
      f.responses.push(toolCall("context_rollover", { handoff: "Fresh Handoff." }));
      await expect(f.session.compact()).rejects.toThrow("Compaction cancelled");
      await expect
        .poll(() => f.manager.getBranch().filter((entry) => entry.type === "compaction").length)
        .toBe(1);
      await f.session.waitForIdle();
      expect(compactionHandlers(f.session)).toEqual(handlers);
      expect(calls).toBe(0);
      expect(f.providerRequests).toHaveLength(0);
      const checkpoint = f.manager.getBranch().findLast((entry) => entry.type === "compaction");
      expect(checkpoint?.summary).toContain("Fresh Handoff.");
      expect(checkpoint?.summary).not.toContain("FOREIGN SUMMARY");
    },
  );

  it(`supersedes a compaction summary ${position} Context Management during native overflow`, async () => {
    let calls = 0;
    const f = await createSdkHarness(
      ordered((pi) => {
        pi.on("session_before_compact", (event) => {
          calls++;
          return {
            compaction: {
              summary: "FOREIGN SUMMARY",
              firstKeptEntryId: event.preparation.firstKeptEntryId,
              tokensBefore: event.preparation.tokensBefore,
            },
          };
        });
      }),
    );
    f.responses.push(reply("Ready."));
    await f.session.prompt("Ordinary task " + "history ".repeat(3000));
    const handlers = compactionHandlers(f.session);
    f.responses.push(overflow(), reply("Recovered."));
    await f.session.prompt("Trigger native overflow");
    expect(compactionHandlers(f.session)).toEqual(handlers);
    expect(calls).toBe(1);
    expect(f.providerRequests).toHaveLength(0);
    expect(f.requests).toHaveLength(3);
    const checkpoints = f.manager.getBranch().filter((entry) => entry.type === "compaction");
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]?.summary).not.toContain("FOREIGN SUMMARY");
    f.responses.push(reply("Still working."));
    await f.session.prompt("Continue after the Emergency Rollover");
    expect(f.requests).toHaveLength(4);
  });
}

it.each(["missing", "throwing"])(
  "blocks summarizer fallback when the owned hook is %s",
  async (mode) => {
    const f = await createSdkHarness([contextManagement]);
    f.responses.push(reply("Ready."));
    await f.session.prompt("Ordinary task " + "history ".repeat(3000));
    const extension = f.session.resourceLoader
      .getExtensions()
      .extensions.find((entry) => entry.tools.has("context_rollover"));
    if (!extension) throw new Error("Context Management did not load");
    const original = extension.handlers.get("session_before_compact");
    if (!original) throw new Error("Missing owned hook before regression setup");
    extension.handlers.set(
      "session_before_compact",
      mode === "missing"
        ? []
        : [
            async () => {
              throw new Error("Broken compaction hook");
            },
          ],
    );
    try {
      await expect(f.session.compact()).rejects.toThrow("Compaction cancelled");
      expect(f.providerRequests).toHaveLength(0);
      expect(f.manager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
    } finally {
      extension.handlers.set("session_before_compact", original);
    }
  },
);

// Pi 0.87 stores `(...args) => handler(...args)` rather than the registered function itself.
const wrapRegisteredHandlers = (session: AgentSession) => {
  for (const extension of session.resourceLoader.getExtensions().extensions) {
    for (const [event, handlers] of extension.handlers) {
      extension.handlers.set(
        event,
        handlers.map(
          (handler) =>
            (...args: Parameters<typeof handler>) =>
              handler(...args),
        ),
      );
    }
  }
};

it("recovers native overflow when Pi wraps registered handlers", async () => {
  const f = await createSdkHarness([contextManagement]);
  wrapRegisteredHandlers(f.session);
  f.responses.push(reply("Ready."));
  await f.session.prompt("Ordinary task " + "history ".repeat(3000));
  f.responses.push(overflow(), reply("Recovered."));
  await f.session.prompt("Trigger native overflow");
  expect(f.providerRequests).toHaveLength(0);
  expect(f.requests).toHaveLength(3);
  expect(f.manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
});

it("claims manual compaction when Pi wraps registered handlers", async () => {
  const f = await createSdkHarness([contextManagement]);
  wrapRegisteredHandlers(f.session);
  f.responses.push(reply("Ready."));
  await f.session.prompt("Ordinary task " + "history ".repeat(3000));
  f.responses.push(toolCall("context_rollover", { handoff: "Fresh Handoff." }));
  await expect(f.session.compact()).rejects.toThrow("Compaction cancelled");
  await expect
    .poll(() => f.manager.getBranch().filter((entry) => entry.type === "compaction").length)
    .toBe(1);
  await f.session.waitForIdle();
  expect(f.providerRequests).toHaveLength(0);
  const checkpoint = f.manager.getBranch().findLast((entry) => entry.type === "compaction");
  expect(checkpoint?.summary).toContain("Fresh Handoff.");
});

it("guards listeners registered after startup", async () => {
  let register: (() => void) | undefined;
  const f = await createSdkHarness([
    contextManagement,
    (pi) => {
      register = () =>
        pi.on("session_before_compact", (event) => ({
          compaction: {
            summary: "LATE FOREIGN SUMMARY",
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
          },
        }));
    },
  ]);
  f.responses.push(reply("Ready."));
  await f.session.prompt("Ordinary task " + "history ".repeat(3000));
  if (!register) throw new Error("Missing late extension registration");
  register();
  f.responses.push(overflow(), reply("Recovered."));
  await f.session.prompt("Trigger native overflow");
  expect(f.providerRequests).toHaveLength(0);
  const checkpoints = f.manager.getBranch().filter((entry) => entry.type === "compaction");
  expect(checkpoints).toHaveLength(1);
  expect(checkpoints[0]?.summary).not.toContain("LATE FOREIGN SUMMARY");
});

it("announces a direct Rollover to native compaction listeners before the next request", async () => {
  // Mirrors provider bridges that rebuild their session cache on session_compact.
  const observed: Array<{ reason: string; summary: string; requests: number | undefined }> = [];
  let requests: (() => number) | undefined;
  const f = await createSdkHarness(
    [
      contextManagement,
      (pi) => {
        pi.on("session_compact", (event) => {
          observed.push({
            reason: event.reason,
            summary: event.compactionEntry.summary,
            requests: requests?.(),
          });
        });
      },
    ],
    { keepRecentTokens: 500 },
  );
  requests = () => f.requests.length;
  f.responses.push(reply("Ready."));
  await f.session.prompt("Original task " + "history ".repeat(3000));
  f.responses.push(
    toolCall("context_rollover", { handoff: "Continue the blue widget." }),
    reply("Finished."),
  );
  await f.session.prompt("Continue");
  const checkpoint = f.manager.getBranch().findLast((entry) => entry.type === "compaction");
  expect(observed).toEqual([{ reason: "threshold", summary: checkpoint?.summary, requests: 2 }]);
  expect(f.requests).toHaveLength(3);
});
