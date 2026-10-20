import type { JsonValue } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  OnePasswordProvider,
  type OnePasswordSettings,
  type OpRunner,
} from "../src/one-password-provider.js";

interface Call {
  args: readonly string[];
  input: string | undefined;
}

const DEV = { id: "vault-dev", name: "Dev" };
const PERSONAL = { id: "vault-personal", name: "Personal" };

const githubItem = {
  id: "item-github",
  title: "GitHub",
  category: "API_CREDENTIAL",
  vault: DEV,
  fields: [
    {
      id: "credential",
      label: "credential",
      type: "CONCEALED",
      value: "ghp-value-never-listed",
      reference: "op://Dev/GitHub/credential",
    },
    {
      id: "username",
      label: "username",
      type: "STRING",
      value: "octocat",
      reference: "op://Dev/GitHub/username",
    },
  ],
};

/** A fake `op` that answers by subcommand with JSON text, and records every call. */
function fakeOp(answers: Readonly<Record<string, string>>) {
  const calls: Call[] = [];
  const run: OpRunner = async (args, options) => {
    calls.push({ args, input: options.input });
    const rest = args[0] === "--account" ? args.slice(2) : args;
    const words = rest.filter((arg) => !arg.startsWith("-"));
    const answer = answers[words.slice(0, 2).join(" ")] ?? answers[words[0] ?? ""];
    if (answer === undefined) throw new Error(`unexpected op ${args.join(" ")}`);
    return answer;
  };
  return { calls, run };
}

/** A fake `op` answering subcommands with JSON, or with raw text such as `op read` prints. */
function provider(
  answers: Readonly<Record<string, JsonValue>>,
  settings: OnePasswordSettings = {},
  raw: Readonly<Record<string, string>> = {},
) {
  const serialized = Object.entries(answers).map(([command, answer]) => [
    command,
    JSON.stringify(answer),
  ]);
  const op = fakeOp({ ...Object.fromEntries(serialized), ...raw });
  return { op, provider: new OnePasswordProvider(() => settings, op.run) };
}

describe("1Password Secret Provider", () => {
  it("reads a 1Password Reference with op read, passing the account as a global flag", async () => {
    const { op, provider: onePassword } = provider(
      {},
      { account: "my.1password.com" },
      { read: "ghp-value-1234" },
    );

    expect(await onePassword.read("op://Dev/GitHub/credential")).toBe("ghp-value-1234");
    expect(op.calls[0]?.args).toEqual([
      "--account",
      "my.1password.com",
      "read",
      "--no-newline",
      "--",
      "op://Dev/GitHub/credential",
    ]);
  });

  it("rejects a locator that is not a 1Password Reference before running op", async () => {
    const { op, provider: onePassword } = provider({});
    await expect(onePassword.read("op://Dev/GitHub")).rejects.toThrow(
      "is not a 1Password Reference",
    );
    await expect(onePassword.describe("vault://Dev/GitHub/x")).rejects.toThrow(
      "is not a 1Password Reference",
    );
    expect(op.calls).toEqual([]);
  });

  it("describes a field, including a one-time password attribute", async () => {
    const { provider: onePassword } = provider({ "item get": githubItem });

    expect(await onePassword.describe("op://Dev/GitHub/credential")).toEqual({
      locator: "op://Dev/GitHub/credential",
      vault: "Dev",
      item: "GitHub",
      field: "credential",
      fieldType: "concealed",
    });
    expect((await onePassword.describe("op://Dev/GitHub/username?attribute=otp")).fieldType).toBe(
      "otp",
    );
    await expect(onePassword.describe("op://Dev/GitHub/password")).rejects.toThrow(
      'item "GitHub" has no field "password"',
    );
  });

  it("refuses items outside the configured vaults", async () => {
    const { provider: onePassword } = provider(
      { "item get": { ...githubItem, vault: PERSONAL } },
      { vaults: ["Dev"] },
    );
    await expect(onePassword.describe("op://Personal/GitHub/credential")).rejects.toThrow(
      "that item is not in a vault listed in secret.providers.1password.vaults",
    );
  });

  it("searches items in the configured vaults by title, and lists one item's fields without values", async () => {
    const items = [
      { id: "item-github", title: "GitHub", category: "API_CREDENTIAL", vault: DEV },
      { id: "item-gitlab", title: "GitLab", category: "LOGIN", vault: DEV },
      { id: "item-bank", title: "Bank", category: "LOGIN", vault: PERSONAL },
    ];
    const { provider: onePassword } = provider(
      { "item list": items, "item get": githubItem },
      { vaults: ["vault-dev"] },
    );

    expect(await onePassword.search({ query: "git", limit: 1 })).toEqual({
      entries: [
        {
          kind: "item",
          provider: "1password",
          id: "item-github",
          title: "GitHub",
          vault: "Dev",
          category: "api credential",
        },
      ],
      truncated: true,
    });
    const fields = await onePassword.search({ item: "GitHub", limit: 20 });
    expect(fields.entries.map((entry) => entry.kind === "field" && entry.locator)).toEqual([
      "op://Dev/GitHub/credential",
      "op://Dev/GitHub/username",
    ]);
    expect(JSON.stringify(fields)).not.toContain("ghp-value-never-listed");
    expect(JSON.stringify(fields)).not.toContain("octocat");
  });

  it("creates a new item from a template on stdin, never putting the value on the command line", async () => {
    const created = { id: "item-new", title: "OpenAI", vault: DEV, fields: [] };
    const { op, provider: onePassword } = provider({
      "vault get": DEV,
      "item list": [],
      "item create": created,
    });

    const locator = await onePassword.save({
      locator: "op://Dev/OpenAI/credential",
      value: "sk-openai-5c6d7e8f",
    });

    expect(locator).toBe("op://vault-dev/item-new/credential");
    const create = op.calls.find((call) => call.args.includes("create"));
    expect(create?.args.join(" ")).not.toContain("sk-openai-5c6d7e8f");
    expect(JSON.parse(create?.input ?? "{}")).toEqual({
      title: "OpenAI",
      category: "API_CREDENTIAL",
      fields: [
        { id: "credential", label: "credential", type: "CONCEALED", value: "sk-openai-5c6d7e8f" },
      ],
    });
  });

  it("refuses to save over an existing item title or outside the configured vaults", async () => {
    const existing = provider({
      "vault get": DEV,
      "item list": [{ id: "item-github", title: "GitHub", vault: DEV }],
    });
    await expect(
      existing.provider.describeSave({ locator: "op://Dev/github/credential" }),
    ).rejects.toThrow("already has an item titled");

    const outside = provider({ "vault get": PERSONAL }, { vaults: ["Dev"] });
    await expect(
      outside.provider.describeSave({ locator: "op://Personal/New/credential" }),
    ).rejects.toThrow("not in a vault listed in secret.providers.1password.vaults");
    expect(outside.op.calls.some((call) => call.args.includes("create"))).toBe(false);
  });

  it("checks the vault at every read when vaults are configured, looking each vault up once", async () => {
    const { op, provider: onePassword } = provider(
      { "vault get": PERSONAL },
      { vaults: ["Dev"] },
      { read: "never-read-value" },
    );
    await expect(onePassword.read("op://Personal/Bank/password")).rejects.toThrow(
      "not in a vault listed in secret.providers.1password.vaults",
    );
    await expect(onePassword.read("op://Personal/Bank/pin")).rejects.toThrow("not in a vault");
    expect(op.calls.map((call) => call.args[0])).toEqual(["vault"]);
  });

  it("lists a one-time password field with the locator that reads its current code", async () => {
    const otpItem = {
      ...githubItem,
      fields: [
        {
          id: "totp",
          label: "one-time password",
          type: "OTP",
          reference: "op://Dev/GitHub/one-time password",
        },
      ],
    };
    const { provider: onePassword } = provider({ "item get": otpItem });
    const { entries } = await onePassword.search({ item: "GitHub", limit: 20 });
    expect(entries).toMatchObject([
      { kind: "field", type: "otp", locator: "op://Dev/GitHub/one-time password?attribute=otp" },
    ]);
  });

  it("looks an item up only in the configured vaults", async () => {
    const { op, provider: onePassword } = provider({ "item get": githubItem }, { vaults: ["Dev"] });
    await onePassword.search({ item: "GitHub", limit: 20 });
    expect(op.calls[0]?.args).toEqual([
      "item",
      "get",
      "--vault",
      "Dev",
      "--format",
      "json",
      "--",
      "GitHub",
    ]);
  });

  it("saves into a built-in field by its purpose", async () => {
    const created = { id: "item-new", title: "Router", vault: DEV, fields: [] };
    const { op, provider: onePassword } = provider({
      "vault get": DEV,
      "item list": [],
      "item create": created,
    });
    await onePassword.save({
      locator: "op://Dev/Router/password",
      value: "router-pass-1a2b",
      category: "Password",
    });
    const create = op.calls.find((call) => call.args.includes("create"));
    expect(JSON.parse(create?.input ?? "{}")).toMatchObject({
      category: "PASSWORD",
      fields: [{ id: "password", purpose: "PASSWORD", type: "CONCEALED" }],
    });
  });

  it("treats an empty vault list, as invalid settings fall back to, as no vaults", async () => {
    const { provider: onePassword } = provider({ "item get": githubItem }, { vaults: [] });
    await expect(onePassword.describe("op://Dev/GitHub/credential")).rejects.toThrow(
      "not in a vault listed in secret.providers.1password.vaults",
    );
  });
});
