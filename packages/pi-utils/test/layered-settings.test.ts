import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
  defineLayeredSettings,
  resolveLayeredOptions,
  rewriteNamespaceDocument,
} from "../src/layered-settings.js";

const schema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
    tools: Type.Optional(Type.Record(Type.String(), Type.Boolean())),
  },
  { additionalProperties: false },
);
interface Options {
  enabled?: boolean;
  limit?: number;
  tools?: Record<string, boolean>;
}
interface Config {
  enabled: boolean;
  limit: number;
  tools: Record<string, boolean>;
}
const defaults: Config = { enabled: false, limit: 3, tools: { read: true } };
const sessionEntryType = "test-settings";

const merge = {
  tools: (current: Config["tools"], next: Config["tools"]) => ({ ...current, ...next }),
};
const definition = { namespace: "demo", label: "Demo", schema, defaults, merge };
const define = () => defineLayeredSettings({ ...definition, sessionEntryType });
const defineWithoutSession = () => defineLayeredSettings(definition);

function storageHarness(global = "{}", project = "{}", trusted = true) {
  const documents = { global, project };
  const storage: Parameters<typeof SettingsManager.fromStorage>[0] = {
    withLock(scope, update) {
      const next = update(documents[scope]);
      if (next !== undefined) documents[scope] = next;
    },
  };
  return { documents, manager: SettingsManager.fromStorage(storage, { projectTrusted: trusted }) };
}

const errorMessage = (value: Error | Options) => (value instanceof Error ? value.message : "");

const branch = (...entries: unknown[]) => ({
  getBranch: () =>
    entries.map((data, index) => ({
      type: "custom" as const,
      customType: sessionEntryType,
      id: String(index),
      parentId: null,
      timestamp: "",
      data,
    })),
});

describe("layered settings resolution", () => {
  it("resolves default < global < project < session with per-key sources", () => {
    const { documents, manager } = storageHarness(
      JSON.stringify({ demo: { enabled: true, limit: 5 } }),
      JSON.stringify({ demo: { limit: 7 } }),
    );
    expect(documents.global).toContain("demo");
    const settings = define();
    const resolved = settings.readSettings({
      settingsManager: manager,
      sessionManager: branch({ version: 1, overrides: { enabled: false } }),
    });
    expect(resolved.settings).toEqual({ enabled: false, limit: 7, tools: { read: true } });
    expect(resolved.sources).toEqual({ enabled: "session", limit: "project", tools: "default" });
  });

  it("ignores untrusted project settings and an absent session layer", () => {
    const { manager } = storageHarness(
      JSON.stringify({ demo: { limit: 5 } }),
      JSON.stringify({ demo: { limit: 9, bogus: 1 } }),
      false,
    );
    const resolved = defineWithoutSession().readSettings({
      settingsManager: manager,
      sessionManager: branch({ version: 1, overrides: { limit: 1 } }),
    });
    expect(resolved.settings.limit).toBe(5);
    expect(resolved.sources.limit).toBe("global");
  });

  it("preserves per-scope errors and throws the failing scope on resolution", () => {
    const { manager } = storageHarness(
      JSON.stringify({ demo: { limit: 0 } }),
      JSON.stringify({ demo: { nope: true } }),
    );
    const settings = define();
    const layers = settings.readLayers(manager);
    expect(layers.global).toBeInstanceOf(Error);
    expect(errorMessage(layers.global)).toContain("Invalid global Demo settings/limit");
    expect(errorMessage(layers.project)).toContain("Invalid project Demo settings");
    expect(() =>
      settings.readSettings({ settingsManager: manager, sessionManager: branch() }),
    ).toThrow("Invalid global Demo settings");
  });

  it("merges record keys through the hook instead of replacing them", () => {
    const { manager } = storageHarness(
      JSON.stringify({ demo: { tools: { read: false, write: true } } }),
      JSON.stringify({ demo: { tools: { write: false, bash: true } } }),
    );
    const resolved = define().readSettings({
      settingsManager: manager,
      sessionManager: branch({ version: 1, overrides: { tools: { grep: true } } }),
    });
    expect(resolved.settings.tools).toEqual({
      read: false,
      write: false,
      bash: true,
      grep: true,
    });
    expect(resolved.sources.tools).toBe("session");
  });

  it("replays only the last override snapshot and rejects malformed ones", () => {
    const settings = define();
    expect(
      settings.readOverrides(
        branch(
          { version: 1, overrides: { limit: 2 } },
          { version: 1, overrides: { enabled: true } },
        ),
      ),
    ).toEqual({ enabled: true });
    expect(settings.readOverrides(branch())).toEqual({});
    expect(() => settings.readOverrides(branch({ version: 2, overrides: {} }))).toThrow(
      "Invalid Demo session settings",
    );
  });

  it("rejects an option key the schema does not declare", () => {
    const settings = define();
    expect(settings.optionKey("limit")).toBe("limit");
    expect(() => settings.optionKey("constructor")).toThrow("Unknown Demo option: constructor");
  });

  it("treats an authored undefined as inheriting and never passes it to a hook", () => {
    const calls: unknown[] = [];
    // Session overrides are in-process values, so an explicit `undefined` survives to the fold.
    type Authored = { [Key in keyof Options]?: Options[Key] | undefined };
    const resolved = resolveLayeredOptions<Authored, Config>({
      defaults,
      optionKeys: ["enabled", "limit", "tools"],
      layers: [
        ["global", { enabled: true, limit: 8, tools: { a: true } }],
        ["project", { enabled: undefined, limit: undefined, tools: undefined }],
        ["session", { tools: { b: true } }],
      ],
      merge: {
        tools: (current, next, source) => {
          calls.push([source, next]);
          return { ...current, ...next };
        },
      },
    });
    expect(calls).toEqual([
      ["global", { a: true }],
      ["session", { b: true }],
    ]);
    expect(resolved.settings).toEqual({
      enabled: true,
      limit: 8,
      tools: { read: true, a: true, b: true },
    });
    expect(resolved.sources).toEqual({ enabled: "global", limit: "global", tools: "session" });
  });
});

describe("layered settings definition", () => {
  it("requires every schema property to be optional", () => {
    expect(() =>
      defineLayeredSettings({
        namespace: "demo",
        label: "Demo",
        schema: Type.Object({ limit: Type.Integer() }),
        defaults: { limit: 1 },
      }),
    ).toThrow("Demo settings schema must make every option optional");
  });
});

describe("layered settings writes", () => {
  const set = (patch: Options) => ({ action: "set", key: "limit", patch }) as const;

  it("writes through the lock, strips a BOM, and keeps other settings", async () => {
    const { documents, manager } = storageHarness(`\uFEFF${JSON.stringify({ theme: "dark" })}`);
    const updated = await define().writeSettings(manager, "global", set({ limit: 4 }), () => true);
    expect(updated).toEqual({ limit: 4 });
    expect(documents.global).toBe(
      `${JSON.stringify({ theme: "dark", demo: { limit: 4 } }, null, 2)}\n`,
    );
  });

  it("deletes an empty namespace on inherit", async () => {
    const { documents, manager } = storageHarness(JSON.stringify({ x: 1, demo: { limit: 4 } }));
    await define().writeSettings(
      manager,
      "global",
      { action: "inherit", key: "limit" },
      () => true,
    );
    expect(JSON.parse(documents.global)).toEqual({ x: 1 });
  });

  it("refuses invalid documents and invalid results without writing", async () => {
    const settings = define();
    for (const document of ["[]", '{"demo":null}']) {
      const { documents, manager } = storageHarness(document);
      await expect(
        settings.writeSettings(manager, "global", set({ limit: 2 }), () => true),
      ).rejects.toThrow("Invalid global settings document; refusing to overwrite it");
      expect(documents.global).toBe(document);
    }
    // A malformed document surfaces the original SyntaxError.
    const malformed = storageHarness("{");
    await expect(
      settings.writeSettings(malformed.manager, "global", set({ limit: 2 }), () => true),
    ).rejects.toBeInstanceOf(SyntaxError);
    expect(malformed.documents.global).toBe("{");
    const invalid = storageHarness();
    await expect(
      settings.writeSettings(invalid.manager, "global", set({ limit: 0 }), () => true),
    ).rejects.toThrow("Invalid global Demo settings/limit");
    expect(invalid.documents.global).toBe("{}");
  });

  it("requires a trusted project and a current caller", async () => {
    const untrusted = storageHarness("{}", "{}", false);
    await expect(
      define().writeSettings(untrusted.manager, "project", set({ limit: 2 }), () => true),
    ).rejects.toThrow("Demo project settings require a trusted project");
    const { documents, manager } = storageHarness();
    await expect(
      define().writeSettings(manager, "global", set({ limit: 2 }), () => false),
    ).resolves.toBeUndefined();
    expect(documents.global).toBe("{}");
  });

  it("rejects an opaque settings backend", async () => {
    const manager = new Proxy(SettingsManager.inMemory(), {
      getOwnPropertyDescriptor: (target, property) =>
        property === "storage" ? undefined : Reflect.getOwnPropertyDescriptor(target, property),
    });
    await expect(
      define().writeSettings(manager, "global", set({ limit: 2 }), () => true),
    ).rejects.toThrow("Unsupported Pi settings backend: Demo cannot safely write scoped settings");
  });
});

describe("rewriteNamespaceDocument", () => {
  const invalid = (reason: string) => new Error(reason);
  it("creates a missing document", () => {
    expect(
      rewriteNamespaceDocument({
        current: undefined,
        namespace: "demo",
        invalid,
        update: (options) => ({ ...options, enabled: true }),
      }),
    ).toBe('{\n  "demo": {\n    "enabled": true\n  }\n}\n');
  });

  it("reports why a document cannot be rewritten", () => {
    const rewrite = (current: string) => () =>
      rewriteNamespaceDocument({ current, namespace: "demo", invalid, update: (o) => o });
    expect(rewrite("{")).toThrow("malformed");
    expect(rewrite("[]")).toThrow("root");
    expect(rewrite('{"demo":[]}')).toThrow("namespace");
  });
});
