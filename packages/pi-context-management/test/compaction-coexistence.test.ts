import { expect, it } from "vitest";
import type { AgentSession, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import contextManagement from "../src/context-management-extension.js";
import { createSdkHarness, reply } from "./sdk-harness.js";

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
      await f.session.compact();
      expect(compactionHandlers(f.session)).toEqual(handlers);
      expect(f.providerRequests).toHaveLength(0);
      expect(calls).toBe(1);
      expect(f.requests).toHaveLength(1);
      expect(f.manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
      expect(f.session.messages).toEqual(f.manager.buildSessionContext().messages);
    },
  );

  it.each(["rpc", "tui"] as const)(
    `respects cancellation ${position} Context Management without faulting the session in %s`,
    async (mode) => {
      const f = await createSdkHarness(
        ordered((pi) => {
          pi.on("session_before_compact", () => ({ cancel: true }));
        }),
      );
      f.responses.push(reply("Ready."));
      await f.session.prompt("Ordinary task " + "history ".repeat(3000));
      expect(f.requests).toHaveLength(1);
      await f.session.bindExtensions({ mode });
      const leaf = f.manager.getLeafId();
      const handlers = compactionHandlers(f.session);
      await expect(f.session.compact()).rejects.toThrow("Compaction cancelled");
      expect(compactionHandlers(f.session)).toEqual(handlers);
      expect(f.providerRequests).toHaveLength(0);
      expect(f.manager.getLeafId()).toBe(leaf);
      f.responses.push(reply("Still working."));
      await f.session.prompt("Continue without compacting");
      expect(f.requests).toHaveLength(2);
      expect(f.manager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
    },
  );

  it.each(["rpc", "tui"] as const)(
    `blocks an actual compaction override ${position} Context Management before persistence in %s`,
    async (mode) => {
      let active = false;
      const f = await createSdkHarness(
        ordered((pi) => {
          pi.on("session_before_compact", (event) =>
            active
              ? {
                  compaction: {
                    summary: "FOREIGN SUMMARY",
                    firstKeptEntryId: event.preparation.firstKeptEntryId,
                    tokensBefore: event.preparation.tokensBefore,
                  },
                }
              : undefined,
          );
        }),
      );
      f.responses.push(reply("Ready."));
      await f.session.prompt("Ordinary task " + "history ".repeat(3000));
      expect(f.requests).toHaveLength(1);
      await f.session.bindExtensions({ mode });
      const leaf = f.manager.getLeafId();
      active = true;
      const handlers = compactionHandlers(f.session);
      await expect(f.session.compact()).rejects.toThrow("Compaction cancelled");
      expect(compactionHandlers(f.session)).toEqual(handlers);
      expect(f.manager.getLeafId()).toBe(leaf);
      expect(f.manager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
      await f.session.prompt("Must not continue after the conflict");
      expect(f.requests).toHaveLength(1);
      expect(f.providerRequests).toHaveLength(0);
    },
  );
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
  await expect(f.session.compact()).rejects.toThrow("Compaction cancelled");
  expect(f.providerRequests).toHaveLength(0);
  expect(f.manager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
});
