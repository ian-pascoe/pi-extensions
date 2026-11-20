import { describe, expect, it } from "vite-plus/test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import contextManagement from "../src/context-management-extension.js";
import { createSdkHarness, reply } from "./sdk-harness.js";

/** The `contextManagement` block of one settings file. */
interface ContextSettings {
  maxContextTokens?: number;
}

async function harness(
  global: ContextSettings | undefined,
  project: ContextSettings | undefined,
  options: { trusted?: boolean | undefined; contextWindow?: number | undefined } = {},
) {
  const settings = SettingsManager.fromStorage(
    {
      withLock(scope, fn) {
        fn(
          JSON.stringify({
            contextManagement: scope === "global" ? global : project,
            compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 1 },
            retry: { enabled: false },
          }),
        );
      },
    },
    { projectTrusted: options.trusted ?? true },
  );
  const f = await createSdkHarness([contextManagement], {
    settings,
    contextWindow: options.contextWindow ?? 1_000_000,
  });
  const notices: string[] = [];
  await f.session.bindExtensions({
    mode: "rpc",
    uiContext: {
      ...f.session.extensionRunner.getUIContext(),
      notify: (message) => {
        notices.push(message);
      },
    },
  });
  return { ...f, notices };
}

describe("Context Limit", () => {
  it.each([
    { label: "default", global: undefined, project: undefined, limit: 400_000 },
    { label: "global", global: { maxContextTokens: 272_000 }, project: undefined, limit: 272_000 },
    {
      label: "trusted project over global",
      global: { maxContextTokens: 272_000 },
      project: { maxContextTokens: 300_000 },
      limit: 300_000,
    },
    {
      label: "untrusted project",
      global: undefined,
      project: { maxContextTokens: 300_000 },
      trusted: false,
      limit: 400_000,
    },
    {
      label: "smaller declared window",
      global: undefined,
      project: undefined,
      contextWindow: 200_000,
      limit: 200_000,
    },
    {
      label: "invalid global",
      global: { maxContextTokens: 0 },
      project: undefined,
      limit: 400_000,
      warned: true,
    },
  ])(
    "caps the window Pi accounts against: $label",
    async ({ global, project, trusted, contextWindow, limit, warned }) => {
      const f = await harness(global, project, { trusted, contextWindow });
      expect(f.session.model?.contextWindow).toBe(limit);
      expect(f.session.getContextUsage()?.contextWindow).toBe(limit);
      expect(
        f.notices.filter((message) =>
          message.includes("invalid contextManagement.maxContextTokens"),
        ),
      ).toHaveLength(warned ? 1 : 0);
      expect(f.extensionErrors).toEqual([]);
    },
  );

  it("starts Pi's threshold Rollover preparation at the limit, not the declared window", async () => {
    const f = await harness(undefined, undefined);
    f.responses.push(reply("Existing work", 399_700), reply("Prepared"));
    await f.session.prompt("Original task");
    expect(f.requests).toHaveLength(2);
    expect(JSON.stringify(f.requests[1]?.messages)).toContain("Prepare a Context Rollover");
    expect(f.providerRequests).toEqual([]);
  });

  it("applies to a later model selection and leaves its identity intact", async () => {
    const f = await harness({ maxContextTokens: 272_000 }, undefined);
    await f.session.setModel({ ...f.model, id: "claude-opus-5-5", contextWindow: 2_000_000 });
    expect(f.session.model).toMatchObject({ id: "claude-opus-5-5", contextWindow: 272_000 });
  });
});
