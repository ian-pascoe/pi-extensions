import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createSdkHarness, reply } from "../../pi-context-management/test/sdk-harness.js";
import advisor from "../src/index.js";

describe("Advisor commands through the native SDK", () => {
  it("registers argument completion for Advisor commands", async () => {
    const { session } = await createSdkHarness([advisor]);
    const complete = session.extensionRunner?.getCommand("advisor")?.getArgumentCompletions;
    expect(await complete?.("")).toEqual(
      ["on", "off", "status", "prompt", "inherit", "set"].map((value) => ({ value, label: value })),
    );
    expect(await complete?.("o")).toEqual([
      { value: "on", label: "on" },
      { value: "off", label: "off" },
    ]);
  });

  it("completes settings keys and only valid trailing scopes without rewriting JSON", async () => {
    const { session } = await createSdkHarness([advisor]);
    const complete = session.extensionRunner?.getCommand("advisor")?.getArgumentCompletions;
    const values = async (prefix: string) => (await complete?.(prefix))?.map((item) => item.value);
    expect(await values("set ")).toEqual([
      "set enabled",
      "set includeSubagents",
      "set prompt",
      "set model",
      "set thinkingLevel",
      "set allowedTools",
      "set catchUpThreshold",
      "set reviewTimeoutMs",
      "set maxToolCalls",
      "set maxCorrectiveTurns",
    ]);
    expect(await values("inherit c")).toEqual(["inherit catchUpThreshold"]);
    expect(await values("set  allowedT")).toEqual(["set  allowedTools"]);
    for (const prefix of ["on ", "off ", "prompt ", "inherit prompt "]) {
      expect(await values(prefix)).toEqual([`${prefix}--global`, `${prefix}--project`]);
    }
    expect(await values("inherit ")).toContain("inherit --global");
    expect(await values('set prompt "Keep  spaces and --global text" --p')).toEqual([
      'set prompt "Keep  spaces and --global text" --project',
    ]);
    expect(await values('set allowedTools ["read", "ls"] ')).toEqual([
      'set allowedTools ["read", "ls"] --global',
      'set allowedTools ["read", "ls"] --project',
    ]);
    for (const prefix of [
      "status ",
      "on --global ",
      "set nonexistent ",
      "set catchUpThreshold 0 ",
      'set prompt "unfinished --p',
      "unknown ",
    ]) {
      expect(await values(prefix)).toEqual([]);
    }
    await session.reload();
    expect(
      await session.extensionRunner?.getCommand("advisor")?.getArgumentCompletions?.("on --p"),
    ).toEqual([{ value: "on --project", label: "on --project" }]);
  });

  it("does not poll other processes' settings and adopts them on native reload", async () => {
    const documents = {
      global: JSON.stringify({ advisor: { catchUpThreshold: 5 } }),
      project: "{}",
    };
    const storage: Parameters<typeof SettingsManager.fromStorage>[0] = {
      withLock(scope, update) {
        const next = update(documents[scope]);
        if (next !== undefined) documents[scope] = next;
      },
    };
    const { session, manager } = await createSdkHarness([advisor], {
      settings: SettingsManager.fromStorage(storage),
    });
    const status = () =>
      manager
        .getBranch()
        .findLast((entry) => entry.type === "custom" && entry.customType === "pi-advisor-status");
    documents.global = JSON.stringify({ advisor: { catchUpThreshold: 23 } });
    await session.prompt("/advisor status");
    expect(status()).toMatchObject({ data: { settings: { catchUpThreshold: 5 } } });
    await session.reload();
    await session.prompt("/advisor status");
    expect(status()).toMatchObject({ data: { settings: { catchUpThreshold: 23 } } });
  });

  it("fails clearly for an opaque native settings backend without fallback writes", async () => {
    const settings = new Proxy(SettingsManager.inMemory(), {
      getOwnPropertyDescriptor(target, property) {
        return property === "storage"
          ? undefined
          : Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    const { session, manager } = await createSdkHarness([advisor], { settings });
    await session.prompt("/advisor on --global");
    expect(
      manager
        .getBranch()
        .findLast((entry) => entry.type === "custom" && entry.customType === "pi-advisor-status"),
    ).toMatchObject({
      data: {
        settings: { enabled: false },
        error: expect.stringContaining("Unsupported Pi settings backend"),
      },
    });
  });

  it("writes the owning native file backend even when its directories differ from the SDK cwd", async () => {
    const { dir } = await createSdkHarness([]);
    await mkdir(join(dir, ".pi"));
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({ theme: "light", otherExtension: { keep: true } }),
    );
    await writeFile(
      join(dir, ".pi", "settings.json"),
      JSON.stringify({ advisor: { allowedTools: ["lsp"] } }),
    );
    const { session } = await createSdkHarness([advisor], {
      settings: SettingsManager.create(dir, dir),
    });
    await session.prompt("/advisor on --global");
    await session.prompt('/advisor set prompt "Exact replacement" --project');
    const restored = SettingsManager.create(dir, dir);
    const resumed = await createSdkHarness([advisor], { settings: restored });
    await resumed.session.prompt("/advisor status");
    expect(
      resumed.manager
        .getBranch()
        .findLast((entry) => entry.type === "custom" && entry.customType === "pi-advisor-status"),
    ).toMatchObject({
      data: {
        settings: { enabled: true, prompt: "Exact replacement", allowedTools: ["lsp"] },
        sources: { enabled: "global", prompt: "project", allowedTools: "project" },
      },
    });
    expect(restored.getGlobalSettings()).toMatchObject({
      theme: "light",
      otherExtension: { keep: true },
    });
  });

  it("discards a scoped command awaiting native flush when the session shuts down", async () => {
    const documents = { global: "{}", project: "{}" };
    const storage: Parameters<typeof SettingsManager.fromStorage>[0] = {
      withLock(scope, update) {
        const next = update(documents[scope]);
        if (next !== undefined) documents[scope] = next;
      },
    };
    const settings = SettingsManager.fromStorage(storage);
    const { session, manager } = await createSdkHarness([advisor], { settings });
    settings.setTheme("light");
    const before = manager.getEntries();
    const pending = session.prompt("/advisor on --global");
    await session.extensionRunner?.emit({ type: "session_shutdown", reason: "reload" });
    await pending;
    expect(manager.getEntries()).toEqual(before);
    const resumed = await createSdkHarness([advisor], {
      settings: SettingsManager.fromStorage(storage),
    });
    await resumed.session.prompt("/advisor status");
    expect(
      resumed.manager
        .getBranch()
        .findLast((entry) => entry.type === "custom" && entry.customType === "pi-advisor-status"),
    ).toMatchObject({ data: { settings: { enabled: false }, sources: { enabled: "default" } } });
  });

  it("repairs invalid Advisor values in native BOM JSON but never overwrites malformed documents", async () => {
    const documents = {
      global:
        "\uFEFF" +
        JSON.stringify({
          theme: "light",
          otherExtension: { keep: true },
          advisor: { catchUpThreshold: 0, prompt: "Keep this prompt" },
        }),
      project: "{}",
    };
    const storage: Parameters<typeof SettingsManager.fromStorage>[0] = {
      withLock(scope, update) {
        const next = update(documents[scope]);
        if (next !== undefined) documents[scope] = next;
      },
    };
    const { session, manager } = await createSdkHarness([advisor], {
      settings: SettingsManager.fromStorage(storage),
    });
    const status = () =>
      manager
        .getBranch()
        .findLast((entry) => entry.type === "custom" && entry.customType === "pi-advisor-status");
    await session.prompt("/advisor status");
    expect(status()).toMatchObject({
      data: { state: "paused", error: expect.stringContaining("catchUpThreshold") },
    });
    await session.prompt("/advisor set catchUpThreshold 5 --global");
    expect(status()).toMatchObject({
      data: { settings: { catchUpThreshold: 5, prompt: "Keep this prompt" }, error: null },
    });
    expect(SettingsManager.fromStorage(storage).getGlobalSettings()).toMatchObject({
      otherExtension: { keep: true },
      theme: "light",
    });
    documents.global = "{broken";
    await session.prompt("/advisor on --global");
    expect(documents.global).toBe("{broken");
    expect(status()).toMatchObject({
      data: { settings: { enabled: false, catchUpThreshold: 5 }, error: expect.any(String) },
    });
  });

  it("replays selected-branch overrides through resume and fork, excluding abandoned settings", async () => {
    const { session, manager, responses, dir } = await createSdkHarness([advisor]);
    responses.push(reply("Recorded"));
    await session.prompt("Record the initial task");
    await session.prompt("/advisor set catchUpThreshold 17");
    const selected = manager.getLeafId();
    if (!selected) throw new Error("Missing selected branch");
    await session.prompt("/advisor set catchUpThreshold 42");
    await session.navigateTree(selected, { summarize: false });
    await session.prompt("/advisor status");
    const file = manager.getSessionFile();
    if (!file) throw new Error("Native session was not persisted");
    for (const restored of [SessionManager.open(file), SessionManager.forkFrom(file, dir, dir)]) {
      const resumed = await createSdkHarness([advisor], { manager: restored });
      await resumed.session.prompt("/advisor status");
      expect(
        restored
          .getBranch()
          .findLast((entry) => entry.type === "custom" && entry.customType === "pi-advisor-status"),
      ).toMatchObject({
        data: { settings: { catchUpThreshold: 17 }, sources: { catchUpThreshold: "session" } },
      });
      await resumed.session.prompt("/advisor inherit catchUpThreshold");
      expect(
        restored
          .getBranch()
          .findLast((entry) => entry.type === "custom" && entry.customType === "pi-advisor-status"),
      ).toMatchObject({
        data: { settings: { catchUpThreshold: 3 }, sources: { catchUpThreshold: "default" } },
      });
    }
  });

  it("ignores untrusted project settings and refuses project writes", async () => {
    const documents = {
      global: JSON.stringify({ advisor: { catchUpThreshold: 13 } }),
      project: "{broken",
    };
    const storage: Parameters<typeof SettingsManager.fromStorage>[0] = {
      withLock(scope, update) {
        const next = update(documents[scope]);
        if (next !== undefined) documents[scope] = next;
      },
    };
    const settings = SettingsManager.fromStorage(storage, { projectTrusted: false });
    const { session, manager } = await createSdkHarness([advisor], { settings });
    await session.prompt("/advisor status");
    expect(
      manager
        .getBranch()
        .findLast((entry) => entry.type === "custom" && entry.customType === "pi-advisor-status"),
    ).toMatchObject({
      data: {
        settings: { catchUpThreshold: 13 },
        sources: { catchUpThreshold: "global" },
        error: null,
      },
    });
    await session.prompt("/advisor on --project");
    expect(
      manager
        .getBranch()
        .findLast((entry) => entry.type === "custom" && entry.customType === "pi-advisor-status"),
    ).toMatchObject({ data: { error: expect.stringContaining("trusted project") } });
    expect(documents.project).toBe("{broken");
  });

  it("keeps a private Advisor Session inert even when globally enabled", async () => {
    const manager = SessionManager.inMemory();
    manager.appendCustomEntry("pi-advisor-role", {
      role: "advisor",
      observedSessionId: "observed-root",
    });
    const document = { advisor: { enabled: true }, retry: { enabled: false } };
    const { session, requests } = await createSdkHarness([advisor], {
      manager,
      settings: SettingsManager.inMemory(document),
    });
    await session.prompt("/advisor on");
    expect(
      manager
        .getBranch()
        .findLast((entry) => entry.type === "custom" && entry.customType === "pi-advisor-status"),
    ).toMatchObject({ data: { state: "private" } });
    expect(
      manager
        .getBranch()
        .some((entry) => entry.type === "custom" && entry.customType === "pi-advisor-settings"),
    ).toBe(false);
    expect(requests).toEqual([]);
  });

  it("edits the whole prompt natively and discards an editor result after tree navigation", async () => {
    const { session, manager } = await createSdkHarness([advisor]);
    const runner = session.extensionRunner;
    if (!runner) throw new Error("SDK did not bind extension UI");
    let started = Promise.withResolvers<void>();
    const edited = Promise.withResolvers<string | undefined>();
    let replacement = Promise.resolve<string | undefined>("Replacement prompt\nSecond line");
    runner.setUIContext(
      {
        ...runner.getUIContext(),
        editor: async () => {
          started.resolve();
          return replacement;
        },
      },
      "rpc",
    );
    await session.prompt("/advisor prompt");
    const base = manager.getLeafId();
    if (!base) throw new Error("Prompt override has no native branch position");
    expect(
      manager
        .getBranch()
        .findLast((entry) => entry.type === "custom" && entry.customType === "pi-advisor-status"),
    ).toMatchObject({
      data: {
        settings: { prompt: "Replacement prompt\nSecond line" },
        sources: { prompt: "session" },
      },
    });
    expect(runner.getEntryRenderer("pi-advisor-status")).toBeDefined();
    await session.prompt('/advisor set prompt "Other branch"');
    replacement = edited.promise;
    started = Promise.withResolvers<void>();
    const pending = session.prompt("/advisor prompt");
    await started.promise;
    await session.navigateTree(base, { summarize: false });
    edited.resolve("Stale editor result");
    await pending;
    await session.prompt("/advisor status");
    expect(
      manager
        .getBranch()
        .findLast((entry) => entry.type === "custom" && entry.customType === "pi-advisor-status"),
    ).toMatchObject({ data: { settings: { prompt: "Replacement prompt\nSecond line" } } });
  });

  it("persists native scoped settings without replacing unrelated runtime overrides", async () => {
    const documents = {
      global: JSON.stringify({
        theme: "dark",
        compaction: { enabled: true },
        advisor: { catchUpThreshold: 6 },
      }),
      project: JSON.stringify({ theme: "light", advisor: { allowedTools: ["lsp"] } }),
    };
    const storage: Parameters<typeof SettingsManager.fromStorage>[0] = {
      withLock(scope, update) {
        const next = update(documents[scope]);
        if (next !== undefined) documents[scope] = next;
      },
    };
    const settings = SettingsManager.fromStorage(storage);
    const { session, manager } = await createSdkHarness([advisor], { settings });
    const status = () =>
      manager
        .getBranch()
        .findLast((entry) => entry.type === "custom" && entry.customType === "pi-advisor-status");
    settings.setTheme("solarized");
    settings.applyOverrides({ compaction: { enabled: false } });
    await session.prompt("/advisor set catchUpThreshold 11 --global");
    await session.prompt("/advisor set allowedTools [] --project");
    expect(status()).toMatchObject({
      data: {
        settings: { catchUpThreshold: 11, allowedTools: [] },
        sources: { catchUpThreshold: "global", allowedTools: "project" },
      },
    });
    expect(settings.getCompactionEnabled()).toBe(false);
    const restored = SettingsManager.fromStorage(storage);
    expect(restored.getGlobalSettings().theme).toBe("solarized");
    expect(restored.getTheme()).toBe("light");
    expect(restored.getCompactionEnabled()).toBe(true);
    const resumed = await createSdkHarness([advisor], { settings: restored });
    await resumed.session.prompt("/advisor status");
    expect(
      resumed.manager
        .getBranch()
        .findLast((entry) => entry.type === "custom" && entry.customType === "pi-advisor-status"),
    ).toMatchObject({ data: { settings: { catchUpThreshold: 11, allowedTools: [] } } });
    await session.prompt("/advisor inherit catchUpThreshold --global");
    expect(status()).toMatchObject({
      data: { settings: { catchUpThreshold: 3 }, sources: { catchUpThreshold: "default" } },
    });
  });

  it("sets and inherits exact options while rejecting malformed thresholds", async () => {
    const { session, manager } = await createSdkHarness([advisor]);
    const status = () =>
      manager
        .getBranch()
        .findLast((entry) => entry.type === "custom" && entry.customType === "pi-advisor-status");
    await session.prompt('/advisor set allowedTools ["lsp", "read"]');
    await session.prompt("/advisor set catchUpThreshold 19");
    expect(status()).toMatchObject({
      data: {
        settings: { allowedTools: ["lsp", "read"], catchUpThreshold: 19 },
        sources: { allowedTools: "session", catchUpThreshold: "session" },
      },
    });
    for (const value of ["0", "-1", "1.5", "9007199254740992", "null", '"never"']) {
      await session.prompt(`/advisor set catchUpThreshold ${value}`);
      expect(status()).toMatchObject({
        data: { error: expect.stringContaining("catchUpThreshold") },
      });
      await session.prompt("/advisor status");
      expect(status()).toMatchObject({ data: { settings: { catchUpThreshold: 19 } } });
    }
    await session.prompt("/advisor set reviewTimeoutMs 2147483648");
    expect(status()).toMatchObject({ data: { error: expect.stringContaining("reviewTimeoutMs") } });
    await session.prompt("/advisor set catchUpThreshold 0 --global");
    expect(status()).toMatchObject({
      data: { error: expect.stringContaining("Invalid global Advisor settings") },
    });
    await session.prompt('/advisor set catchUpThreshold "off"');
    expect(status()).toMatchObject({ data: { settings: { catchUpThreshold: "off" } } });
    await session.prompt("/advisor inherit allowedTools");
    expect(status()).toMatchObject({
      data: {
        settings: { allowedTools: ["read", "grep", "find", "ls"] },
        sources: { allowedTools: "default" },
      },
    });
  });
  it("lets a session disable a global default and return to inheritance", async () => {
    const document = {
      advisor: { enabled: true, catchUpThreshold: 7, allowedTools: ["lsp"] },
      retry: { enabled: false },
    };
    const { session, manager, requests } = await createSdkHarness([advisor], {
      settings: SettingsManager.inMemory(document),
    });
    const status = () =>
      manager
        .getBranch()
        .findLast((entry) => entry.type === "custom" && entry.customType === "pi-advisor-status");

    await session.prompt("/advisor status");
    expect(status()).toMatchObject({
      data: {
        state: "armed",
        settings: { enabled: true, catchUpThreshold: 7, allowedTools: ["lsp"] },
        sources: { enabled: "global", catchUpThreshold: "global", allowedTools: "global" },
      },
    });

    await session.prompt("/advisor off");
    expect(status()).toMatchObject({
      data: {
        state: "disabled",
        settings: { enabled: false },
        sources: { enabled: "session" },
      },
    });

    await session.prompt("/advisor inherit");
    expect(status()).toMatchObject({
      data: {
        state: "armed",
        settings: { enabled: true },
        sources: { enabled: "global" },
      },
    });
    expect(requests).toEqual([]);
  });

  it("reports disabled defaults without starting inference or changing model context", async () => {
    const { session, manager, requests } = await createSdkHarness([advisor]);
    const messages = structuredClone(session.messages);
    const tools = session.getAllTools();
    const systemPrompt = session.systemPrompt;

    await session.prompt("/advisor status");

    expect(
      manager
        .getBranch()
        .findLast((entry) => entry.type === "custom" && entry.customType === "pi-advisor-status"),
    ).toMatchObject({
      data: {
        state: "disabled",
        settings: {
          enabled: false,
          includeSubagents: false,
          allowedTools: ["read", "grep", "find", "ls"],
          catchUpThreshold: 3,
          reviewTimeoutMs: 120_000,
          maxToolCalls: 8,
          maxCorrectiveTurns: 1,
        },
        sources: { enabled: "default", allowedTools: "default" },
        backlog: 0,
        usage: null,
        cost: null,
      },
    });
    expect(requests).toEqual([]);
    expect(session.messages).toEqual(messages);
    expect(session.getAllTools()).toEqual(tools);
    expect(session.systemPrompt).toBe(systemPrompt);
  });
});
