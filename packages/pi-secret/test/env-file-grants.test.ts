import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import type { JsonValue } from "@earendil-works/pi-ai";
import { recordToolRegistrations } from "@ian-pascoe/pi-utils/tool-testing";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  createPiSecretExtension,
  defaultSecretProviders,
  type ProviderEnvironment,
} from "../src/pi-secret-extension.js";
import {
  createSecretHarness,
  keys,
  reply,
  toolCalls,
  type DialogScript,
  type SecretHarnessOptions,
} from "./fixtures/secret-harness.js";

async function workspace(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-secret-env-"));
  onTestFinished(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  return dir;
}

/** Pi started in `dir`, without `op` on `PATH`. */
const startedIn = (dir: string): ProviderEnvironment => ({
  cwd: dir,
  agentDirectory: dir,
  onPath: () => false,
});

interface EnvHarnessOptions {
  files?: Record<string, string>;
  settings?: Record<string, JsonValue>;
  projectSettings?: Record<string, JsonValue>;
  dialogs?: DialogScript[];
  git?: boolean;
}

/** A session in a project with Env Files, through the default Secret Providers. */
async function envHarness(options: EnvHarnessOptions = {}) {
  const dir = await workspace(options.files);
  if (options.git) execFileSync("git", ["init", "--quiet"], { cwd: dir, stdio: "ignore" });
  const harnessOptions: SecretHarnessOptions = {
    dir,
    dialogs: options.dialogs ?? [],
    providers: (context) => defaultSecretProviders(context, startedIn(dir)),
  };
  if (options.settings !== undefined) harnessOptions.settings = options.settings;
  if (options.projectSettings !== undefined)
    harnessOptions.projectSettings = options.projectSettings;
  return createSecretHarness(harnessOptions);
}

describe("Env File Secret Provider activation", () => {
  async function registered(files: Record<string, string>, settings?: Record<string, JsonValue>) {
    const dir = await workspace(files);
    if (settings !== undefined)
      await writeFile(join(dir, "settings.json"), JSON.stringify(settings));
    const { pi, tools } = recordToolRegistrations();
    void createPiSecretExtension({
      getAgentDirectory: () => dir,
      providers: (context) => defaultSecretProviders(context, startedIn(dir)),
    })(pi);
    return tools;
  }
  const names = (tools: Awaited<ReturnType<typeof registered>>) => tools.map(({ name }) => name);
  const withProviders = [
    "secret_ask",
    "secret_ask_grant",
    "secret_list",
    "secret_save",
    "secret_forget",
  ];
  const withoutProviders = ["secret_ask", "secret_list", "secret_forget"];

  it("turns on with a top-level Env File and no op on PATH, and names Env files in the prompt", async () => {
    const tools = await registered({ ".env": "KEY=value\n" });
    expect(names(tools)).toEqual(withProviders);
    const grant = tools.find(({ name }) => name === "secret_ask_grant");
    expect(grant).toMatchObject({
      promptGuidelines: [expect.stringContaining("in a Secret Provider such as Env files")],
    });
    expect(JSON.stringify(grant?.parameters)).toContain("dotenv://.env#API_KEY");
  });

  it("stays off without an Env File, op, or settings, leaving today's tool set", async () => {
    const tools = await registered({ "packages/api/.env": "NESTED=1\n", ".envrc": "x" });
    expect(names(tools)).toEqual(withoutProviders);
    expect(tools.find(({ name }) => name === "secret_list")).toMatchObject({
      description:
        "List the Secrets this session can use and when each expires, and search Secret Providers such as 1Password for items and fields to request with secret_ask_grant; never values.",
    });
  });

  it("follows global settings: enabled false wins over Env Files, and files or enabled true turn it on", async () => {
    const dotenv = (value: JsonValue) => ({ secret: { providers: { dotenv: value } } });
    expect(names(await registered({ ".env": "K=v\n" }, dotenv({ enabled: false })))).toEqual(
      withoutProviders,
    );
    expect(
      names(await registered({ ".env": "K=v\n" }, dotenv({ enabled: false, files: ["/x/.env"] }))),
    ).toEqual(withoutProviders);
    expect(names(await registered({}, dotenv({ files: ["~/.env.tool"] })))).toEqual(withProviders);
    expect(names(await registered({}, dotenv({ enabled: true })))).toEqual(withProviders);
    // Invalid settings list no files, and an `enabled: false` among them still turns it off.
    expect(names(await registered({}, dotenv({ files: ["relative/.env"] })))).toEqual(
      withoutProviders,
    );
    expect(
      names(
        await registered(
          { ".env": "K=v\n" },
          { secret: { lifetimeMinutes: 0, providers: { dotenv: { enabled: false } } } },
        ),
      ),
    ).toEqual(withoutProviders);
  });
});

describe("Env File Secret Grants", () => {
  it("resolves a granted key through both reference forms, follows edits, and blocks once it is gone", async () => {
    const harness = await envHarness({
      files: { ".env": "API_TOKEN=env-token-0a1b2c3d\nOTHER=${API_TOKEN}\n" },
      dialogs: [[keys.enter]],
    });
    harness.responses.push(
      toolCalls([
        "secret_ask_grant",
        {
          grants: [
            { name: "API_TOKEN", locator: "dotenv://.env#API_TOKEN" },
            { name: "LITERAL", locator: `dotenv://${join(harness.dir, ".env")}#OTHER` },
          ],
        },
        "call-grant",
      ]),
      toolCalls(["echo", { text: "a={{secret:API_TOKEN}} b={{secret:LITERAL}}" }, "call-echo-1"]),
    );
    await harness.session.prompt("Use the token.");

    expect(harness.result("call-grant")).toMatchObject({
      details: {
        secrets: [
          { name: "API_TOKEN", status: "granted", locator: "dotenv://.env#API_TOKEN" },
          // Recorded relative to the project, so the grant follows it.
          { name: "LITERAL", status: "granted", locator: "dotenv://.env#OTHER" },
        ],
      },
    });
    expect(harness.frames[0]?.join("\n")).toContain("Env files · ");
    // Outside a git repository, no git warning.
    expect(harness.frames[0]?.join("\n")).not.toContain("not ignored by git");
    expect(harness.frames[0]?.join("\n")).toContain(" / .env / API_TOKEN");
    expect(harness.received).toEqual([
      { tool: "echo", args: { text: "a=env-token-0a1b2c3d b=${API_TOKEN}" } },
    ]);

    await writeFile(join(harness.dir, ".env"), "API_TOKEN=edited-token-4e5f6a7b\n");
    harness.responses.push(
      toolCalls(["echo", { text: "$PI_SECRET_API_TOKEN" }, "call-echo-2"]),
      toolCalls(["echo", { text: "{{secret:LITERAL}}" }, "call-echo-3"]),
      reply("Done."),
    );
    await harness.session.prompt("Again.");

    expect(process.env["PI_SECRET_API_TOKEN"]).toBe("edited-token-4e5f6a7b");
    expect(harness.resultText("call-echo-3")).toContain("could not read");
    expect(harness.resultText("call-echo-3")).toContain('.env has no key "OTHER"');
    expect(await harness.sessionFileText()).not.toContain("env-token-0a1b2c3d");
    expect(harness.requests.join("\n")).not.toContain("edited-token-4e5f6a7b");
  });

  it("lists nested Env Files and their keys, never their values", async () => {
    const harness = await envHarness({
      files: {
        ".env": "ROOT=root-value-11223344\n",
        "packages/api/.env": "DATABASE_URL=postgres://value-55667788\n",
        "node_modules/dep/.env": "DEP=dep\n",
      },
    });
    harness.responses.push(
      toolCalls(["secret_list", { provider: "dotenv" }, "call-files"]),
      toolCalls(["secret_list", { item: join("packages", "api", ".env") }, "call-keys"]),
      reply("Done."),
    );
    await harness.session.prompt("List.");

    const files = harness.resultText("call-files") ?? "";
    expect(files).toContain(`- .env (env file) in ${harness.dir.split("/").at(-1)}`);
    expect(files).toContain(join("packages", "api", ".env"));
    expect(files).not.toContain("node_modules");
    expect(harness.resultText("call-keys")).toContain(
      `- DATABASE_URL (key) of ${join("packages", "api", ".env")}: dotenv://${join("packages", "api", ".env")}#DATABASE_URL`,
    );
    const everything = JSON.stringify(harness.session.messages);
    expect(everything).not.toContain("root-value-11223344");
    expect(everything).not.toContain("value-55667788");
  });
});

describe("Env File settings", () => {
  it("grants from a global file outside the project, but drops one listed in project settings with a warning", async () => {
    const elsewhere = await workspace({
      "global/.env": "GLOBAL_TOKEN=global-token-1a2b\n",
      "project/.env": "PROJECT_TOKEN=project-token-3c4d\n",
    });
    const harness = await envHarness({
      files: { ".env": "LOCAL=1\n" },
      settings: { secret: { providers: { dotenv: { files: [join(elsewhere, "global/.env")] } } } },
      projectSettings: {
        secret: {
          providers: { dotenv: { enabled: false, files: [join(elsewhere, "project/.env")] } },
        },
      },
      dialogs: [[keys.enter]],
    });
    harness.responses.push(
      toolCalls(["secret_list", { vault: "outside project" }, "call-list"]),
      toolCalls([
        "secret_ask_grant",
        {
          grants: [
            {
              name: "GLOBAL_TOKEN",
              locator: `dotenv://${join(elsewhere, "global/.env")}#GLOBAL_TOKEN`,
            },
            {
              name: "PROJECT_TOKEN",
              locator: `dotenv://${join(elsewhere, "project/.env")}#PROJECT_TOKEN`,
            },
          ],
        },
        "call-grant",
      ]),
      reply("Done."),
    );
    await harness.session.prompt("Grant.");

    const notices = harness.notices.join("\n");
    expect(notices).toContain("secret.providers.dotenv.enabled in project settings is ignored");
    expect(notices).toContain(
      `ignoring ${join(elsewhere, "project/.env")} in project secret.providers.dotenv.files`,
    );
    const listed = harness.resultText("call-list") ?? "";
    expect(listed).toContain(join(elsewhere, "global/.env"));
    expect(listed).not.toContain(join(elsewhere, "project/.env"));
    expect(harness.result("call-grant")).toMatchObject({
      details: {
        secrets: [
          { name: "GLOBAL_TOKEN", status: "granted" },
          { name: "PROJECT_TOKEN", status: "failed" },
        ],
      },
    });
    expect(harness.frames[0]?.join("\n")).toContain("outside project");
  });

  it("keeps the project's Env Files readable when the settings are invalid, with a warning", async () => {
    const elsewhere = await workspace({ ".env": "OUTSIDE=outside\n" });
    const harness = await envHarness({
      files: { ".env": "LOCAL_TOKEN=local-token-5e6f\n" },
      settings: {
        secret: {
          lifetimeMinutes: 0,
          providers: { dotenv: { enabled: true, files: [join(elsewhere, ".env")] } },
        },
      },
      dialogs: [[keys.enter]],
    });
    harness.responses.push(
      toolCalls(["secret_list", { provider: "dotenv" }, "call-list"]),
      toolCalls([
        "secret_ask_grant",
        { grants: [{ name: "LOCAL_TOKEN", locator: "dotenv://.env#LOCAL_TOKEN" }] },
        "call-grant",
      ]),
      reply("Done."),
    );
    await harness.session.prompt("Grant.");

    expect(harness.notices.join("\n")).toContain("only the project's own Env Files");
    expect(harness.resultText("call-list")).not.toContain(elsewhere);
    expect(harness.result("call-grant")).toMatchObject({
      details: { secrets: [{ name: "LOCAL_TOKEN", status: "granted" }] },
    });
  });
});

describe("secret_save into Env Files", () => {
  it("appends a typed Secret after approval, warning that git does not ignore the file, and grants it with its original expiry", async () => {
    const harness = await envHarness({
      files: { ".env": "EXISTING=1\n" },
      git: true,
      dialogs: [[keys.paste("placeholder-0000"), keys.enter], [keys.enter]],
    });
    harness.responses.push(
      toolCalls(["secret_ask", { names: ["NEW_TOKEN"] }, "call-ask"]),
      toolCalls([
        "secret_save",
        { name: "NEW_TOKEN", locator: "dotenv://.env#NEW_TOKEN" },
        "call-save",
      ]),
      toolCalls(["echo", { text: "{{secret:NEW_TOKEN}}" }, "call-echo"]),
      reply("Done."),
    );
    const expiresAt = new Date(harness.clock.now + 15 * 60_000).toISOString();
    await harness.session.prompt("Save it.");

    expect(harness.result("call-save")).toMatchObject({
      details: {
        secrets: [
          {
            name: "NEW_TOKEN",
            status: "saved",
            locator: "dotenv://.env#NEW_TOKEN",
            expires_at: expiresAt,
          },
        ],
      },
    });
    const dialog = harness.frames.at(-1)?.join("\n") ?? "";
    expect(dialog).toContain("Save Secret");
    expect(dialog).toContain(".env / NEW_TOKEN · new");
    expect(dialog).toContain("<warning>not ignored by git</warning>");
    expect(parseEnv(await readFile(join(harness.dir, ".env"), "utf8"))).toEqual({
      EXISTING: "1",
      NEW_TOKEN: "placeholder-0000",
    });
    expect(harness.received).toEqual([{ tool: "echo", args: { text: "placeholder-0000" } }]);
  });

  it("shows no git warning for an ignored Env File", async () => {
    const harness = await envHarness({
      files: { ".env.local": "TOKEN=ignored-token-7a8b\n", ".gitignore": ".env.local\n" },
      git: true,
      dialogs: [[keys.enter]],
    });
    harness.responses.push(
      toolCalls([
        "secret_ask_grant",
        { grants: [{ name: "TOKEN", locator: "dotenv://.env.local#TOKEN" }] },
        "call-grant",
      ]),
      reply("Done."),
    );
    await harness.session.prompt("Grant.");

    expect(harness.frames[0]?.join("\n")).not.toContain("not ignored by git");
    expect(harness.result("call-grant")).toMatchObject({
      details: { secrets: [{ name: "TOKEN", status: "granted" }] },
    });
  });
});
