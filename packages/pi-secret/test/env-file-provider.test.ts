import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EnvFileProvider,
  type EnvFileSettings,
  type ListedEnvFile,
} from "../src/env-file-provider.js";

let root: string;
let project: string;
let outside: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-secret-env-"));
  project = join(root, "project");
  outside = join(root, "outside");
  await mkdir(project);
  await mkdir(outside);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

function provider(files: ListedEnvFile[] = [], gitIgnores?: () => Promise<boolean | undefined>) {
  const settings: EnvFileSettings = { files };
  return new EnvFileProvider({
    projectDirectory: () => project,
    settings: () => settings,
    // Outside a repository unless a test says otherwise.
    gitIgnores: gitIgnores ?? (async () => undefined),
  });
}

describe("EnvFileProvider search", () => {
  it("lists nested Env Files, including gitignored ones, but none under .git or node_modules", async () => {
    await put(join(project, ".env"), "ROOT_KEY=root-value-0001\n");
    await put(join(project, ".env.local"), "LOCAL_KEY=local-value-0001\n");
    await put(join(project, "packages/api/.env"), "DATABASE_URL=postgres://db\n");
    await put(join(project, ".gitignore"), ".env*\n");
    await put(join(project, ".envrc"), "export NOT_AN_ENV_FILE=1\n");
    await put(join(project, "node_modules/dep/.env"), "DEP_KEY=dep\n");
    await put(join(project, ".git/.env"), "GIT_KEY=git\n");

    const listing = await provider().search({ limit: 20 });

    expect(listing.entries.map((entry) => entry.kind === "item" && entry.title)).toEqual([
      ".env",
      ".env.local",
      join("packages", "api", ".env"),
    ]);
    expect(listing.entries[0]).toEqual({
      kind: "item",
      provider: "dotenv",
      id: ".env",
      title: ".env",
      vault: "project",
      category: "env file",
    });
    expect(JSON.stringify(listing)).not.toContain("value-0001");
  });

  it("lists one Env File's keys with their locators, never their values", async () => {
    await put(join(project, "packages/api/.env"), "DATABASE_URL=postgres://secret\nAPI_KEY=abc\n");
    const path = join("packages", "api", ".env");

    const listing = await provider().search({ item: path, limit: 20 });

    expect(listing.entries).toEqual([
      expect.objectContaining({ label: "API_KEY", locator: `dotenv://${path}#API_KEY` }),
      {
        kind: "field",
        provider: "dotenv",
        item: path,
        vault: "project",
        label: "DATABASE_URL",
        type: "key",
        locator: `dotenv://${path}#DATABASE_URL`,
      },
    ]);
    expect(JSON.stringify(listing)).not.toContain("postgres://secret");
  });

  it("matches query against file paths and key names, and filters by vault", async () => {
    await put(join(project, ".env"), "STRIPE_KEY=a\n");
    await put(join(project, "web/.env.production"), "OTHER=b\n");
    await put(join(outside, ".env"), "OUTSIDE=c\n");
    const env = provider([{ path: join(outside, ".env"), scope: "global" }]);

    const titles = async (search: { query?: string; vault?: string }) =>
      (await env.search({ ...search, limit: 20 })).entries.map(
        (entry) => entry.kind === "item" && entry.title,
      );

    expect(await titles({ query: "stripe" })).toEqual([".env"]);
    expect(await titles({ query: "production" })).toEqual([join("web", ".env.production")]);
    expect(await titles({ vault: "outside project" })).toEqual([join(outside, ".env")]);
    expect(await titles({ vault: "PROJECT" })).toEqual([".env", join("web", ".env.production")]);
  });

  it("reports truncation past the limit", async () => {
    await put(join(project, ".env"), "A=1\n");
    await put(join(project, ".env.local"), "B=1\n");
    expect(await provider().search({ limit: 1 })).toMatchObject({ truncated: true });
  });
});

describe("EnvFileProvider reads", () => {
  it("reads values without expansion, the last definition winning, and again after an edit", async () => {
    await put(join(project, ".env"), "TOKEN=first\nPLAIN=${HOME}/x\nTOKEN=second\n");
    const env = provider();

    expect(await env.read("dotenv://.env#TOKEN")).toBe("second");
    expect(await env.read("dotenv://.env#PLAIN")).toBe("${HOME}/x");
    await writeFile(join(project, ".env"), "TOKEN=edited\n");
    expect(await env.read("dotenv://.env#TOKEN")).toBe("edited");
  });

  it("fails a read when the key or file is gone", async () => {
    await put(join(project, ".env"), "TOKEN=value\n");
    const env = provider();

    await expect(env.read("dotenv://.env#MISSING")).rejects.toThrow('.env has no key "MISSING"');
    await rm(join(project, ".env"));
    await expect(env.read("dotenv://.env#TOKEN")).rejects.toThrow(".env does not exist");
  });

  it("rejects malformed locators", async () => {
    const env = provider();
    for (const locator of ["dotenv://.env", "dotenv://#KEY", "op://a/b/c"])
      await expect(env.read(locator)).rejects.toThrow("is not an Env File locator");
  });

  it("describes a locator for the approval dialog", async () => {
    await put(join(project, "packages/api/.env"), "DATABASE_URL=x\n");
    const locator = "dotenv://packages/api/.env#DATABASE_URL";

    expect(await provider().describe(locator)).toEqual({
      locator,
      vault: "project",
      item: join("packages", "api", ".env"),
      field: "DATABASE_URL",
    });
  });
});

describe("EnvFileProvider path rules", () => {
  it("refuses files outside the project, and non-Env Files inside it, unless they are listed", async () => {
    await put(join(outside, ".env"), "OUT=outside-value\n");
    await put(join(project, "config/secrets.txt"), "IN=inside-value\n");
    await put(join(project, "node_modules/dep/.env"), "DEP=dep-value\n");

    for (const locator of [
      "dotenv://../outside/.env#OUT",
      `dotenv://${join(outside, ".env")}#OUT`,
      "dotenv://config/secrets.txt#IN",
      "dotenv://node_modules/dep/.env#DEP",
    ])
      await expect(provider().read(locator)).rejects.toThrow(
        "is not an Env File Pi Secret may use",
      );

    const listed = provider([
      { path: join(outside, ".env"), scope: "global" },
      { path: join(project, "config/secrets.txt"), scope: "project" },
    ]);
    expect(await listed.read(`dotenv://${join(outside, ".env")}#OUT`)).toBe("outside-value");
    expect(await listed.read("dotenv://../outside/.env#OUT")).toBe("outside-value");
    expect(await listed.read("dotenv://config/secrets.txt#IN")).toBe("inside-value");
  });

  it("only lets global settings list files outside the project", async () => {
    await put(join(outside, ".env"), "OUT=outside-value\n");
    const env = provider([{ path: join(outside, ".env"), scope: "project" }]);

    await expect(env.read(`dotenv://${join(outside, ".env")}#OUT`)).rejects.toThrow(
      "is not an Env File Pi Secret may use",
    );
    expect((await env.search({ limit: 20 })).entries).toEqual([]);
  });

  it("expands ~ to the home directory", async () => {
    vi.stubEnv("HOME", outside);
    await put(join(outside, ".config/tool/.env"), "TOKEN=home-value\n");
    const env = provider([{ path: "~/.config/tool/.env", scope: "global" }]);

    expect(await env.read("dotenv://~/.config/tool/.env#TOKEN")).toBe("home-value");
    expect(await env.describe("dotenv://~/.config/tool/.env#TOKEN")).toMatchObject({
      locator: `dotenv://${join(outside, ".config/tool/.env")}#TOKEN`,
    });
    expect((await env.search({ limit: 20 })).entries).toEqual([
      expect.objectContaining({ title: join(outside, ".config/tool/.env") }),
    ]);
  });

  it("reads a linked Env File whose target is outside the project only when the target is listed", async () => {
    await put(join(outside, "real.env"), "LINKED=linked-value\n");
    await symlink(join(outside, "real.env"), join(project, ".env"));
    await put(join(project, "inner.env"), "INNER=inner-value\n");
    await symlink(join(project, "inner.env"), join(project, ".env.inner"));

    await expect(provider().read("dotenv://.env#LINKED")).rejects.toThrow(
      "is not an Env File Pi Secret may use",
    );
    expect((await provider().search({ limit: 20 })).entries).toEqual([
      expect.objectContaining({ title: ".env.inner" }),
    ]);
    expect(await provider().read("dotenv://.env.inner#INNER")).toBe("inner-value");
    const listed = provider([{ path: join(outside, "real.env"), scope: "global" }]);
    expect(await listed.read("dotenv://.env#LINKED")).toBe("linked-value");
    // Shown as outside the project, where the value really is, and listed once.
    expect(await listed.describe("dotenv://.env#LINKED")).toMatchObject({
      vault: "outside project",
    });
    const titles = (await listed.search({ limit: 20 })).entries.map(
      (entry) => entry.kind === "item" && entry.title,
    );
    expect(titles).toEqual([".env", ".env.inner"]);
  });
});

describe("EnvFileProvider saves", () => {
  const tricky = [
    "plain-value_0123",
    "with spaces inside",
    "hash # inside",
    "single ' quote",
    'double " quote',
    "both ' and \" quotes",
    "line one\nline two",
    "  padded  ",
    "back\\slash\\n",
    "${NOT_EXPANDED}",
  ];

  it.each(tricky)("appends %j so util.parseEnv reads it back exactly", async (value) => {
    await put(join(project, ".env"), "EXISTING=keep # comment\nUNTERMINATED_NEWLINE=yes");
    const env = provider();

    const locator = await env.save({ locator: "dotenv://.env#NEW_KEY", value });

    expect(locator).toBe("dotenv://.env#NEW_KEY");
    const text = await readFile(join(project, ".env"), "utf8");
    expect(text.startsWith("EXISTING=keep # comment\nUNTERMINATED_NEWLINE=yes\n")).toBe(true);
    expect(parseEnv(text)).toEqual({
      EXISTING: "keep",
      UNTERMINATED_NEWLINE: "yes",
      NEW_KEY: value,
    });
    expect(await env.read(locator)).toBe(value);
  });

  it("refuses a key the file already defines, a category, and a value that cannot round-trip", async () => {
    await put(join(project, ".env"), "TOKEN=old\n");
    const env = provider();

    await expect(env.save({ locator: "dotenv://.env#TOKEN", value: "new" })).rejects.toThrow(
      ".env already defines TOKEN",
    );
    await expect(
      env.save({ locator: "dotenv://.env#OTHER", value: "new", category: "Password" }),
    ).rejects.toThrow("Env Files have no item categories");
    await expect(env.save({ locator: "dotenv://.env#OTHER", value: "a'b\"c`d" })).rejects.toThrow(
      "cannot write this value",
    );
    await expect(env.save({ locator: "dotenv://.env#1BAD", value: "new" })).rejects.toThrow(
      "is not a key secret_save writes",
    );
    expect(await readFile(join(project, ".env"), "utf8")).toBe("TOKEN=old\n");
  });

  it("creates a missing Env File with owner-only permissions", async () => {
    await mkdir(join(project, "packages/api"), { recursive: true });

    const locator = await provider().save({
      locator: "dotenv://packages/api/.env.local#TOKEN",
      value: "created-value",
    });

    expect(locator).toBe(`dotenv://${join("packages", "api", ".env.local")}#TOKEN`);
    const path = join(project, "packages/api/.env.local");
    expect(await readFile(path, "utf8")).toBe("TOKEN=created-value\n");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("refuses to create a file not named .env*, outside the project, or in a missing directory", async () => {
    const env = provider();
    await expect(
      env.save({ locator: "dotenv://secrets.txt#TOKEN", value: "value" }),
    ).rejects.toThrow("creates only files named .env or .env.*");
    await expect(
      env.save({ locator: `dotenv://${join(outside, ".env")}#TOKEN`, value: "value" }),
    ).rejects.toThrow("is not an Env File Pi Secret may use");
    await expect(
      env.save({ locator: "dotenv://missing/.env#TOKEN", value: "value" }),
    ).rejects.toThrow("the directory of");
  });

  it("saves to a listed file outside the project, naming it by its full path", async () => {
    vi.stubEnv("HOME", outside);
    const env = provider([{ path: "~/.env.tool", scope: "global" }]);

    const locator = await env.save({ locator: "dotenv://~/.env.tool#TOKEN", value: "value" });

    expect(locator).toBe(`dotenv://${join(outside, ".env.tool")}#TOKEN`);
    expect(await env.read(locator)).toBe("value");
  });

  it("refuses to write through a dangling link", async () => {
    await symlink(join(outside, "nowhere.env"), join(project, ".env"));
    await expect(
      provider().save({ locator: "dotenv://.env#TOKEN", value: "value" }),
    ).rejects.toThrow("is a link to a file that does not exist");
  });

  it("describes a save, saying when the file is new", async () => {
    await put(join(project, ".env"), "OLD=1\n");
    const env = provider();

    expect(await env.describeSave({ locator: "dotenv://.env#NEW" })).toMatchObject({
      item: ".env",
      field: "NEW",
      fieldType: "new key",
    });
    expect(await env.describeSave({ locator: "dotenv://.env.local#NEW" })).toMatchObject({
      item: ".env.local",
      fieldType: "new key, new file",
    });
  });
});

describe("EnvFileProvider git warning", () => {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: project, stdio: "ignore" });

  it("warns about a project Env File git does not ignore, and not about an ignored one", async () => {
    git("init", "--quiet");
    await put(join(project, ".gitignore"), ".env.local\n");
    await put(join(project, ".env"), "TOKEN=a\n");
    await put(join(project, ".env.local"), "TOKEN=b\n");
    const env = new EnvFileProvider({
      projectDirectory: () => project,
      settings: () => ({ files: [] }),
    });

    expect(await env.describe("dotenv://.env#TOKEN")).toMatchObject({
      warning: "not ignored by git",
    });
    expect(await env.describe("dotenv://.env.local#TOKEN")).not.toHaveProperty("warning");
    expect(await env.describeSave({ locator: "dotenv://.env#NEW" })).toMatchObject({
      warning: "not ignored by git",
    });
  });

  it("warns about nothing outside a git repository", async () => {
    await put(join(project, ".env"), "TOKEN=a\n");
    const env = new EnvFileProvider({
      projectDirectory: () => project,
      settings: () => ({ files: [] }),
    });
    expect(await env.describe("dotenv://.env#TOKEN")).not.toHaveProperty("warning");
  });
});
