import { describe, expect, it } from "vitest";
import { FakeProvider } from "./fixtures/fake-provider.js";
import { createSecretHarness, keys, reply, toolCalls } from "./fixtures/secret-harness.js";

const TOKEN = "fake://Dev/GitHub/token";
const OTP = "fake://Dev/Bank/otp";

/** A one-time password that changes at every read. */
function otp(): () => string {
  let count = 0;
  return () => `otp-code-${String(++count).padStart(6, "0")}`;
}

describe("Secret Grants", () => {
  it("reads a granted Secret again at each use, so a one-time password is always current, and stores only its locator", async () => {
    const provider = new FakeProvider({ [OTP]: otp() });
    const harness = await createSecretHarness({ providers: [provider], dialogs: [[keys.enter]] });
    harness.responses.push(
      toolCalls([
        "secret_ask_grant",
        { grants: [{ name: "BANK_OTP", locator: OTP }], reason: "Log in" },
        "call-grant",
      ]),
      toolCalls(["echo", { text: "code={{secret:BANK_OTP}}" }, "call-echo-1"]),
      toolCalls(["echo", { text: "code={{secret:BANK_OTP}}" }, "call-echo-2"]),
      reply("Done."),
    );
    await harness.session.prompt("Log in to the bank.");

    expect(harness.result("call-grant")).toMatchObject({
      details: {
        secrets: [
          { name: "BANK_OTP", status: "granted", locator: OTP, reference: "{{secret:BANK_OTP}}" },
        ],
      },
    });
    // One read checks the grant on approval, then one per use.
    expect(harness.received).toEqual([
      { tool: "echo", args: { text: "code=otp-code-000002" } },
      { tool: "echo", args: { text: "code=otp-code-000003" } },
    ]);
    expect(harness.resultText("call-echo-2")).toBe("echo: code={{secret:BANK_OTP}}");
    // The dialog showed where the value is read from, and the session holds the locator only.
    const dialog = harness.frames[0]?.join("\n") ?? "";
    expect(dialog).toContain("Grant request");
    expect(dialog).toContain("Fake Vault · Dev / Bank / otp · concealed");
    const sessionText = await harness.sessionFileText();
    expect(sessionText).toContain(`"customType":"pi-secret-grant"`);
    expect(sessionText).toContain(OTP);
    for (const code of ["otp-code-000001", "otp-code-000002", "otp-code-000003"]) {
      expect(sessionText).not.toContain(code);
      expect(harness.requests.join("\n")).not.toContain(code);
    }
  });

  it("reports denied, cancelled, and failed grants and holds none of them", async () => {
    const provider = new FakeProvider({ [TOKEN]: "ghp-token-0a1b2c3d", [OTP]: otp() });
    const harness = await createSecretHarness({
      providers: [provider],
      // Deny the first row, allow the second; then cancel a second request outright.
      dialogs: [[" ", keys.enter], [keys.escape]],
    });
    harness.responses.push(
      toolCalls([
        "secret_ask_grant",
        {
          grants: [
            { name: "DENIED_ONE", locator: TOKEN },
            { name: "MISSING_ONE", locator: "fake://Dev/Nowhere/field" },
            { name: "UNKNOWN_SCHEME", locator: "vault://x/y/z" },
            { name: "GRANTED_ONE", locator: OTP },
          ],
        },
        "call-grant-1",
      ]),
      toolCalls([
        "secret_ask_grant",
        { grants: [{ name: "CANCELLED_ONE", locator: TOKEN }] },
        "call-grant-2",
      ]),
      reply("Done."),
    );
    await harness.session.prompt("Grant.");

    expect(harness.result("call-grant-1")).toMatchObject({
      details: {
        secrets: [
          { name: "DENIED_ONE", status: "denied" },
          { name: "MISSING_ONE", status: "failed", error: "no field at fake://Dev/Nowhere/field" },
          { name: "UNKNOWN_SCHEME", status: "failed" },
          { name: "GRANTED_ONE", status: "granted" },
        ],
      },
    });
    expect(harness.resultText("call-grant-1")).toContain("available schemes: fake://");
    expect(harness.result("call-grant-2")).toMatchObject({
      details: { secrets: [{ name: "CANCELLED_ONE", status: "cancelled" }] },
    });
    // Only rows a provider could describe reach the dialog.
    expect(harness.frames[0]?.join("\n")).not.toContain("MISSING_ONE");
  });

  it("fails a grant whose check read fails, without holding it", async () => {
    const provider = new FakeProvider({ [TOKEN]: "ghp-token-0a1b2c3d" });
    provider.locked = true;
    const harness = await createSecretHarness({ providers: [provider], dialogs: [[keys.enter]] });
    harness.responses.push(
      toolCalls([
        "secret_ask_grant",
        { grants: [{ name: "LOCKED", locator: TOKEN }] },
        "call-grant",
      ]),
      toolCalls(["secret_list", { status: "held" }, "call-list"]),
      reply("Done."),
    );
    await harness.session.prompt("Grant.");

    expect(harness.resultText("call-grant")).toBe("LOCKED: not granted: Fake Vault is locked");
    expect(harness.resultText("call-list")).not.toContain("LOCKED");
  });

  it("blocks a call when the Secret Provider cannot be read at use, and keeps the grant", async () => {
    const provider = new FakeProvider({ [TOKEN]: "ghp-token-0a1b2c3d" });
    const harness = await createSecretHarness({ providers: [provider], dialogs: [[keys.enter]] });
    harness.responses.push(
      toolCalls([
        "secret_ask_grant",
        { grants: [{ name: "GH_TOKEN", locator: TOKEN }] },
        "call-grant",
      ]),
    );
    await harness.session.prompt("Grant.");
    provider.locked = true;
    harness.responses.push(
      toolCalls(["echo", { text: "curl -H $PI_SECRET_GH_TOKEN" }, "call-echo"]),
      toolCalls(["secret_list", { status: "held" }, "call-list"]),
      reply("Done."),
    );
    await harness.session.prompt("Use it.");

    expect(harness.received).toEqual([]);
    expect(harness.resultText("call-echo")).toContain(
      "could not read {{secret:GH_TOKEN}} from its Secret Provider: Fake Vault is locked",
    );
    expect(harness.resultText("call-list")).toContain(`GH_TOKEN: held from ${TOKEN}`);
  });

  it("replaces a typed Secret with a grant under the same name, and the other way round", async () => {
    const provider = new FakeProvider({ [TOKEN]: "ghp-granted-5e6f7a8b" });
    const harness = await createSecretHarness({
      providers: [provider],
      dialogs: [[keys.paste("typed-value-1a2b3c4d"), keys.enter], [keys.enter]],
    });
    harness.responses.push(
      toolCalls(["secret_ask", { names: ["SWAPPED"] }, "call-ask"]),
      toolCalls([
        "secret_ask_grant",
        { grants: [{ name: "SWAPPED", locator: TOKEN }] },
        "call-grant",
      ]),
      toolCalls(["echo", { text: "{{secret:SWAPPED}}" }, "call-echo"]),
      reply("Done."),
    );
    await harness.session.prompt("Swap.");

    expect(harness.received).toEqual([{ tool: "echo", args: { text: "ghp-granted-5e6f7a8b" } }]);
  });

  it("lets a Child Agent use its root's grant, read fresh through the registry", async () => {
    const provider = new FakeProvider({ [OTP]: otp() });
    const root = await createSecretHarness({ providers: [provider], dialogs: [[keys.enter]] });
    root.responses.push(
      toolCalls([
        "secret_ask_grant",
        { grants: [{ name: "ROOT_OTP", locator: OTP }] },
        "call-grant",
      ]),
    );
    await root.session.prompt("Grant.");

    const child = await createSecretHarness({ headless: true });
    child.responses.push(
      toolCalls(["echo", { text: "{{secret:ROOT_OTP}}" }, "call-echo"]),
      reply("Done."),
    );
    await child.session.prompt("Use it.");

    expect(child.received).toEqual([{ tool: "echo", args: { text: "otp-code-000002" } }]);
    expect(child.resultText("call-echo")).toBe("echo: {{secret:ROOT_OTP}}");
  });
});

describe("prompt cache", () => {
  it("keeps the system prompt and ordered tool definitions identical across turns that grant, use, and forget", async () => {
    const provider = new FakeProvider({ [TOKEN]: "ghp-token-0a1b2c3d" });
    const harness = await createSecretHarness({ providers: [provider], dialogs: [[keys.enter]] });
    harness.responses.push(
      toolCalls([
        "secret_ask_grant",
        { grants: [{ name: "GH_TOKEN", locator: TOKEN }] },
        "call-grant",
      ]),
      toolCalls(["echo", { text: "{{secret:GH_TOKEN}}" }, "call-echo"]),
      toolCalls(["secret_forget", { names: ["GH_TOKEN"] }, "call-forget"]),
      reply("Done."),
    );
    await harness.session.prompt("Grant, use, forget.");

    // Pi carries the system prompt and the ordered tool declarations in the first system message.
    const prefixes = harness.requests.map((request) =>
      JSON.stringify(JSON.parse(request).messages[0]),
    );
    expect(prefixes).toHaveLength(4);
    expect(new Set(prefixes).size).toBe(1);
    const [prefix = ""] = prefixes;
    expect(JSON.parse(prefix).role).toBe("system");
    const positions = [
      "secret_ask",
      "secret_ask_grant",
      "secret_list",
      "secret_save",
      "secret_forget",
    ].map((name) => prefix.indexOf(`"${name}"`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual(positions.toSorted((a, b) => a - b));
  });
});

describe("secret_list", () => {
  it("lists held Secrets with their source and searches Secret Providers without values", async () => {
    const provider = new FakeProvider({
      [TOKEN]: "ghp-token-0a1b2c3d",
      "fake://Dev/Stripe/key": "sk-stripe-9f8e7d6c",
    });
    const harness = await createSecretHarness({ providers: [provider], dialogs: [[keys.enter]] });
    harness.responses.push(
      toolCalls([
        "secret_ask_grant",
        { grants: [{ name: "GH_TOKEN", locator: TOKEN }] },
        "call-grant",
      ]),
      toolCalls(["secret_list", {}, "call-list"]),
      toolCalls(["secret_list", { query: "Stripe", item: "Stripe" }, "call-fields"]),
      toolCalls(["secret_list", { provider: "other" }, "call-other"]),
      reply("Done."),
    );
    await harness.session.prompt("List.");

    const listed = harness.resultText("call-list") ?? "";
    expect(listed).toContain(`GH_TOKEN: held from ${TOKEN}`);
    expect(listed).toContain("Available to request with secret_ask_grant:");
    expect(listed).toContain("- Stripe (password) in Dev");
    expect(harness.result("call-fields")).toMatchObject({
      details: {
        secrets: [],
        available: [{ kind: "field", label: "key", locator: "fake://Dev/Stripe/key" }],
      },
    });
    expect(harness.resultText("call-other")).toMatch(/^No Secrets matched/);
    for (const value of ["ghp-token-0a1b2c3d", "sk-stripe-9f8e7d6c"])
      expect(harness.requests.join("\n")).not.toContain(value);
  });

  it("still lists held Secrets when a Secret Provider cannot be searched", async () => {
    const provider = new FakeProvider({ [TOKEN]: "ghp-token-0a1b2c3d" });
    provider.locked = true;
    const harness = await createSecretHarness({
      providers: [provider],
      dialogs: [[keys.paste("typed-value-1a2b3c4d"), keys.enter]],
    });
    harness.responses.push(
      toolCalls(["secret_ask", { names: ["TYPED"] }, "call-ask"]),
      toolCalls(["secret_list", {}, "call-list"]),
      reply("Done."),
    );
    await harness.session.prompt("List.");

    const listed = harness.resultText("call-list") ?? "";
    expect(listed).toContain("TYPED: held until");
    expect(listed).toContain("Could not search Fake Vault: Fake Vault is locked");
  });
});

describe("secret_save", () => {
  it("saves a typed Secret into a new item after approval, then reads it from there with its original expiry", async () => {
    const value = "typed-to-save-4c5d6e7f";
    const provider = new FakeProvider();
    const harness = await createSecretHarness({
      providers: [provider],
      dialogs: [[keys.paste(value), keys.enter], [keys.enter]],
    });
    const expiresAt = new Date(harness.clock.now + 15 * 60_000).toISOString();
    harness.responses.push(
      toolCalls(["secret_ask", { names: ["NEW_KEY"] }, "call-ask"]),
      toolCalls([
        "secret_save",
        { name: "NEW_KEY", locator: "fake://Dev/New API/credential" },
        "call-save",
      ]),
      toolCalls(["echo", { text: "{{secret:NEW_KEY}}" }, "call-echo"]),
      reply("Done."),
    );
    await harness.session.prompt("Save it.");

    expect(provider.saved).toEqual([{ locator: "fake://Dev/New API/credential", value }]);
    expect(harness.result("call-save")).toMatchObject({
      details: {
        secrets: [
          {
            name: "NEW_KEY",
            status: "saved",
            locator: "fake://Dev/item-1/credential",
            expires_at: expiresAt,
          },
        ],
      },
    });
    expect(harness.frames.at(-1)?.join("\n")).toContain("Save Secret");
    expect(harness.received).toEqual([{ tool: "echo", args: { text: value } }]);
    expect(provider.reads).toEqual(["fake://Dev/item-1/credential"]);
    expect(harness.requests.join("\n")).not.toContain(value);
    expect(await harness.sessionFileText()).not.toContain(value);
  });

  it("saves nothing when the user denies, and refuses Secrets that were not typed here", async () => {
    const provider = new FakeProvider({ [TOKEN]: "ghp-token-0a1b2c3d" });
    const harness = await createSecretHarness({
      providers: [provider],
      dialogs: [[keys.paste("typed-value-1a2b3c4d"), keys.enter], [" ", keys.enter], [keys.enter]],
    });
    harness.responses.push(
      toolCalls(["secret_ask", { names: ["TYPED"] }, "call-ask"]),
      toolCalls([
        "secret_save",
        { name: "TYPED", locator: "fake://Dev/New/credential" },
        "call-deny",
      ]),
      toolCalls([
        "secret_ask_grant",
        { grants: [{ name: "GRANTED", locator: TOKEN }] },
        "call-grant",
      ]),
      toolCalls([
        "secret_save",
        { name: "GRANTED", locator: "fake://Dev/Copy/credential" },
        "call-granted",
      ]),
      reply("Done."),
    );
    await harness.session.prompt("Save.");

    expect(harness.result("call-deny")).toMatchObject({
      details: { secrets: [{ name: "TYPED", status: "denied" }] },
    });
    expect(harness.result("call-granted")).toMatchObject({ isError: true });
    expect(harness.resultText("call-granted")).toContain("only those can be saved");
    expect(provider.saved).toEqual([]);
  });
});

describe("Secret Grants across sessions", () => {
  async function grantAndQuit(provider: FakeProvider) {
    const first = await createSecretHarness({ providers: [provider], dialogs: [[keys.enter]] });
    first.responses.push(
      toolCalls([
        "secret_ask_grant",
        { grants: [{ name: "GH_TOKEN", locator: TOKEN }] },
        "call-grant",
      ]),
      reply("Ok."),
    );
    await first.session.prompt("Grant.");
    const sessionFile = first.session.sessionManager.getSessionFile();
    if (sessionFile === undefined) throw new Error("The session has no file");
    return { first, sessionFile };
  }

  it("restores a grant on resume without reading it until it is used", async () => {
    const provider = new FakeProvider({ [TOKEN]: "ghp-token-0a1b2c3d" });
    const { first, sessionFile } = await grantAndQuit(provider);
    await first.quit();
    provider.reads.length = 0;

    const resumed = await createSecretHarness({
      dir: first.dir,
      sessionFile,
      clock: first.clock,
      providers: [provider],
    });
    expect(provider.reads).toEqual([]);
    resumed.responses.push(
      toolCalls(["echo", { text: "{{secret:GH_TOKEN}}" }, "call-echo"]),
      reply("Done."),
    );
    await resumed.session.prompt("Use it.");

    expect(resumed.received).toEqual([{ tool: "echo", args: { text: "ghp-token-0a1b2c3d" } }]);
  });

  it("does not restore a grant after its lifetime or once forgotten", async () => {
    const provider = new FakeProvider({ [TOKEN]: "ghp-token-0a1b2c3d" });
    const { first, sessionFile } = await grantAndQuit(provider);
    first.responses.push(
      toolCalls(["secret_forget", { names: ["GH_TOKEN"] }, "call-forget"]),
      reply("Ok."),
    );
    await first.session.prompt("Forget it.");
    await first.quit();

    const resumed = await createSecretHarness({
      dir: first.dir,
      sessionFile,
      clock: first.clock,
      providers: [provider],
    });
    resumed.responses.push(
      toolCalls(["echo", { text: "{{secret:GH_TOKEN}}" }, "call-echo"]),
      reply("Done."),
    );
    await resumed.session.prompt("Use it.");
    expect(resumed.received).toEqual([]);
    await resumed.quit();

    const { first: other, sessionFile: otherFile } = await grantAndQuit(provider);
    await other.quit();
    other.clock.now += 16 * 60_000;
    const late = await createSecretHarness({
      dir: other.dir,
      sessionFile: otherFile,
      clock: other.clock,
      providers: [provider],
    });
    late.responses.push(
      toolCalls(["echo", { text: "{{secret:GH_TOKEN}}" }, "call-echo"]),
      reply("Done."),
    );
    await late.session.prompt("Use it.");
    expect(late.received).toEqual([]);
  });
});
