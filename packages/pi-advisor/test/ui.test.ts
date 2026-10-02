import { stripVTControlCharacters } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import type { Context } from "@earendil-works/pi-ai";
import { createSdkHarness, reply, toolCall } from "../../pi-context-management/test/sdk-harness.js";
import advisor from "../src/index.js";
import { fixture, response } from "./fixtures/advisor-runtime.js";

beforeAll(() => initTheme("dark"));

function lastStatus(session: Awaited<ReturnType<typeof createSdkHarness>>["session"]) {
  return session.sessionManager
    .getBranch()
    .findLast((entry) => entry.type === "custom" && entry.customType === "pi-advisor-status");
}

describe("Advisor status entries", () => {
  it("record the configuration change that produced them", async () => {
    const { session } = await createSdkHarness([advisor]);
    await session.prompt("/advisor on");
    expect(lastStatus(session)).toMatchObject({
      data: { change: { scope: "session", key: "enabled", options: { enabled: true } } },
    });
    await session.prompt('/advisor set model "anthropic/claude-sonnet-4-5"');
    expect(lastStatus(session)).toMatchObject({
      data: {
        change: {
          scope: "session",
          key: "model",
          options: { model: "anthropic/claude-sonnet-4-5" },
        },
      },
    });
    await session.prompt("/advisor inherit model");
    expect(lastStatus(session)).toMatchObject({
      data: { change: { scope: "session", key: "model", options: {} } },
    });
    await session.prompt("/advisor status");
    expect(lastStatus(session)).not.toHaveProperty("data.change");
  });

  it("omit a change that failed", async () => {
    const { session } = await createSdkHarness([advisor]);
    await session.prompt("/advisor set catchUpThreshold 0");
    expect(lastStatus(session)).not.toHaveProperty("data.change");
  });

  it("render through the registered entry renderer instead of JSON", async () => {
    const { session } = await createSdkHarness([advisor]);
    await session.prompt("/advisor on");
    const entry = lastStatus(session);
    if (entry?.type !== "custom") throw new Error("Expected an Advisor status entry");
    const renderer = session.extensionRunner?.getEntryRenderer("pi-advisor-status");
    const rendered = renderer?.(entry, { expanded: false }, themeFromRunner(session));
    const text = stripVTControlCharacters(rendered?.render(120).join("\n") ?? "");
    expect(text).toContain("✓ enabled → true [session]");
    expect(text).toContain("Advisor ● armed");
    expect(text).not.toContain('"settings"');
  });
});

function themeFromRunner(session: Awaited<ReturnType<typeof createSdkHarness>>["session"]): Theme {
  const ui = session.extensionRunner?.getUIContext();
  if (!ui) throw new Error("Expected an extension runner");
  return ui.theme;
}

describe("Advisor footer", () => {
  it("tracks review activity while enabled and clears when disabled", async () => {
    const statuses: Array<string | undefined> = [];
    const releaseReview = Promise.withResolvers<void>();
    const reviewStarted = Promise.withResolvers<void>();
    const { session, cleanupGates } = await fixture({
      interactive: true,
      ui: {
        setStatus: (key, text) => {
          if (key === "advisor")
            statuses.push(text === undefined ? undefined : stripVTControlCharacters(text));
        },
      },
    });
    cleanupGates.push(releaseReview.resolve);
    globalThis.advisorObserverTest = {
      stream(model, context, options) {
        if (context.tools?.some((tool) => tool.name === "advisor_report")) {
          reviewStarted.resolve();
          return response(
            model,
            toolCall("advisor_report", { findings: [] }),
            options,
            releaseReview.promise,
          );
        }
        return response(model, reply("Done"), options);
      },
    };
    expect(statuses.at(-1)).toBe("advisor");
    await session.prompt("Complete a task");
    await reviewStarted.promise;
    expect(statuses).toContain("advisor: reviewing · backlog 1");
    releaseReview.resolve();
    await expect.poll(() => statuses.at(-1)).toBe("advisor");
    await session.prompt("/advisor off");
    expect(statuses.at(-1)).toBeUndefined();
  });
});

describe("Interventions", () => {
  it("keep the observed request prefix stable while rendering through the Advisor renderer", async () => {
    const mainRequests: Context[] = [];
    let reviews = 0;
    const { session } = await fixture({ interactive: true });
    globalThis.advisorObserverTest = {
      stream(model, context, options) {
        if (context.tools?.some((tool) => tool.name === "advisor_report")) {
          reviews++;
          return response(
            model,
            toolCall(
              "advisor_report",
              reviews === 1
                ? { findings: [{ severity: "concern", message: "Re-run the failing test" }] }
                : { findings: [] },
            ),
            options,
          );
        }
        mainRequests.push(structuredClone(context));
        return response(model, reply("Done"), options);
      },
    };
    await session.prompt("First task");
    await expect
      .poll(() =>
        session.sessionManager
          .getBranch()
          .some((entry) => entry.type === "custom_message" && entry.customType === "pi-advisor"),
      )
      .toBe(true);
    await session.prompt("Second task");
    const [first, second] = mainRequests;
    if (!first || !second) throw new Error("Expected two observed requests");
    expect(mainRequests).toHaveLength(2);
    // Cache proof: the second request extends the first byte-for-byte.
    expect(second.systemPrompt).toEqual(first.systemPrompt);
    expect(second.tools).toEqual(first.tools);
    expect(first.tools?.find((tool) => tool.name === "advisor_ask")?.description).toBe(
      "Ask the enabled Advisor for analysis or a second opinion. Waits for its answer; does not delegate implementation.",
    );
    expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages);
    expect(
      second.messages.slice(first.messages.length).map((message) => ({
        role: message.role,
        content: message.content,
      })),
    ).toMatchObject([
      { role: "assistant", content: [{ type: "text", text: "Done" }] },
      {
        role: "user",
        content: [{ type: "text", text: "Advisor concern: Re-run the failing test" }],
      },
      { role: "user", content: [{ type: "text", text: "Second task" }] },
    ]);
    const entry = session.sessionManager
      .getBranch()
      .find((item) => item.type === "custom_message" && item.customType === "pi-advisor");
    if (entry?.type !== "custom_message") throw new Error("Expected a delivered Intervention");
    const renderer = session.extensionRunner?.getMessageRenderer("pi-advisor");
    const rendered = renderer?.(
      {
        role: "custom",
        customType: entry.customType,
        content: entry.content,
        display: true,
        details: entry.details,
        timestamp: 0,
      },
      { expanded: false, outputPad: 0 },
      themeFromRunner(session),
    );
    const text = stripVTControlCharacters(rendered?.render(120).join("\n") ?? "");
    expect(text).toContain("▲ Advisor concern");
    expect(text).toContain("Re-run the failing test");
  });
});

describe("advisor_ask", () => {
  it("declares Advisor renderers for its call and result", async () => {
    const { session } = await fixture();
    const definition = session.extensionRunner?.getToolDefinition("advisor_ask");
    expect(definition?.renderCall).toBeTypeOf("function");
    expect(definition?.renderResult).toBeTypeOf("function");
  });
});
