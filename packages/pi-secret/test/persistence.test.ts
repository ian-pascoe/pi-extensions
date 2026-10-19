import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSecretHarness, keys, reply, toolCalls } from "./fixtures/secret-harness.js";

type Harness = Awaited<ReturnType<typeof createSecretHarness>>;

const keyFile = (harness: Harness) => join(harness.dir, "pi-secret", "keys.json");

/** The data of every `pi-secret` entry in a session file's text. */
function sealedEntries(sessionText: string): { name: string; keyId: string }[] {
  return sessionText
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.customType === "pi-secret")
    .map((entry) => entry.data);
}

/** Enter one Secret in a fresh session, then end that session as quitting Pi would. */
async function enterAndQuit(name: string, value: string) {
  const first = await createSecretHarness({ dialogs: [[keys.paste(value), keys.enter]] });
  first.responses.push(toolCalls(["secret_ask", { names: [name] }, "call-ask"]), reply("Ok."));
  await first.session.prompt("Ask.");
  const sessionFile = first.session.sessionManager.getSessionFile();
  if (sessionFile === undefined) throw new Error("The session has no file");
  const sessionText = await first.sessionFileText();
  await first.quit();
  return { first, sessionFile, sessionText };
}

/** Resume `sessionFile` in a new session and try to use `name`. */
async function resumeAndUse(first: Harness, sessionFile: string, name: string) {
  const resumed = await createSecretHarness({
    dir: first.dir,
    sessionFile,
    clock: first.clock,
  });
  resumed.responses.push(
    toolCalls(["echo", { text: `{{secret:${name}}}` }, "call-echo"]),
    reply("Done."),
  );
  await resumed.session.prompt("Use it.");
  return resumed;
}

describe("Secrets across sessions", () => {
  it("stores only ciphertext in the session, with the key in a private file outside it", async () => {
    const value = "persist-me-0b5e9d";
    const { first, sessionText } = await enterAndQuit("PERSISTED", value);

    expect(sessionText).not.toContain(value);
    const [entry] = sealedEntries(sessionText);
    expect(entry).toMatchObject({ version: 1, name: "PERSISTED" });
    expect(Object.keys(entry ?? {}).toSorted()).toEqual(
      ["ciphertext", "expiresAt", "iv", "keyId", "name", "tag", "version"].toSorted(),
    );
    // The key is not in the session, and only the user can read the key file.
    const keys = JSON.parse(await readFile(keyFile(first), "utf8"));
    const record = keys.keys[entry?.keyId ?? ""];
    expect(record).toBeDefined();
    expect(sessionText).not.toContain(record.key);
    expect((await stat(keyFile(first))).mode & 0o777).toBe(0o600);
    // Quitting stopped exporting the Secret.
    expect(process.env["PI_SECRET_PERSISTED"]).toBeUndefined();
  });

  it("restores a Secret when its session resumes within the Secret Lifetime", async () => {
    const value = "resume-me-3c4d5e";
    const { first, sessionFile } = await enterAndQuit("RESUMED", value);
    first.clock.now += 14 * 60_000;
    const resumed = await resumeAndUse(first, sessionFile, "RESUMED");

    expect(resumed.received).toEqual([{ tool: "echo", args: { text: value } }]);
    expect(process.env["PI_SECRET_RESUMED"]).toBe(value);
  });

  it("cannot restore a Secret once its lifetime has passed, and deletes its key", async () => {
    const { first, sessionFile } = await enterAndQuit("LAPSED", "lapse-me-7f8e9d");
    first.clock.now += 15 * 60_000;
    const resumed = await resumeAndUse(first, sessionFile, "LAPSED");

    expect(resumed.received).toEqual([]);
    expect(resumed.resultText("call-echo")).toContain("Call secret_ask to request it again");
    const keys = JSON.parse(await readFile(keyFile(first), "utf8"));
    expect(keys.keys).toEqual({});
  });

  it("cannot restore a Secret that was forgotten", async () => {
    const harness = await createSecretHarness({
      dialogs: [[keys.paste("forgotten-1a2b3c"), keys.enter]],
    });
    harness.responses.push(
      toolCalls(["secret_ask", { names: ["FORGOTTEN"] }, "call-ask"]),
      toolCalls(["secret_forget", { names: ["FORGOTTEN"] }, "call-forget"]),
      reply("Ok."),
    );
    await harness.session.prompt("Ask and forget.");
    const sessionFile = harness.session.sessionManager.getSessionFile() ?? "";
    await harness.quit();
    const resumed = await resumeAndUse(harness, sessionFile, "FORGOTTEN");

    expect(resumed.received).toEqual([]);
  });

  it("restores every readable Secret even when another one cannot be opened", async () => {
    const first = await createSecretHarness({
      dialogs: [[keys.paste("damaged-1f2e3d"), keys.tab, keys.paste("intact-4c5b6a"), keys.enter]],
    });
    first.responses.push(
      toolCalls(["secret_ask", { names: ["DAMAGED", "INTACT"] }, "call-ask"]),
      reply("Ok."),
    );
    await first.session.prompt("Ask.");
    const sessionFile = first.session.sessionManager.getSessionFile() ?? "";
    const damagedKeyId = sealedEntries(await first.sessionFileText()).find(
      (data) => data.name === "DAMAGED",
    )?.keyId;
    if (damagedKeyId === undefined) throw new Error("No sealed entry for DAMAGED");
    await first.quit();
    // Replace DAMAGED's key with another valid key, so opening it fails authentication.
    const file = JSON.parse(await readFile(keyFile(first), "utf8"));
    file.keys[damagedKeyId].key = Buffer.alloc(32, 7).toString("base64");
    await writeFile(keyFile(first), JSON.stringify(file));
    const resumed = await createSecretHarness({ dir: first.dir, sessionFile, clock: first.clock });

    expect(process.env["PI_SECRET_INTACT"]).toBe("intact-4c5b6a");
    expect(process.env["PI_SECRET_DAMAGED"]).toBeUndefined();
    expect(resumed.notices).toEqual([
      expect.stringMatching(/^Pi Secret: cannot restore Secret DAMAGED/),
    ]);
  });

  it("keeps the key file owner-only even after its permissions were loosened", async () => {
    const harness = await createSecretHarness({
      dialogs: [
        [keys.paste("first-aa11bb22"), keys.enter],
        [keys.paste("second-cc33dd44"), keys.enter],
      ],
    });
    harness.responses.push(
      toolCalls(["secret_ask", { names: ["MODE_ONE"] }, "call-1"]),
      reply("Ok."),
    );
    await harness.session.prompt("Ask.");
    await chmod(keyFile(harness), 0o644);
    harness.responses.push(
      toolCalls(["secret_ask", { names: ["MODE_TWO"] }, "call-2"]),
      reply("Ok."),
    );
    await harness.session.prompt("Ask again.");

    expect((await stat(keyFile(harness))).mode & 0o777).toBe(0o600);
  });

  it("expires a Secret during a session once its lifetime passes", async () => {
    const harness = await createSecretHarness({
      dialogs: [[keys.paste("short-lived-4e5f6a"), keys.enter]],
    });
    harness.responses.push(
      toolCalls(["secret_ask", { names: ["SHORT_LIVED"] }, "call-ask"]),
      reply("Ok."),
    );
    await harness.session.prompt("Ask.");
    harness.clock.now += 15 * 60_000;
    harness.responses.push(
      toolCalls(["echo", { text: "$PI_SECRET_SHORT_LIVED" }, "call-echo"]),
      reply("Done."),
    );
    await harness.session.prompt("Use it.");

    expect(harness.received).toEqual([]);
    expect(process.env["PI_SECRET_SHORT_LIVED"]).toBeUndefined();
    expect(JSON.parse(await readFile(keyFile(harness), "utf8")).keys).toEqual({});
  });

  it("holds only the Secrets entered on the selected branch", async () => {
    const harness = await createSecretHarness({
      dialogs: [[keys.paste("branch-held-8b9c0d"), keys.enter]],
    });
    harness.responses.push(reply("Hello."));
    await harness.session.prompt("Hi.");
    const beforeAsk = harness.session.sessionManager.getLeafId();
    harness.responses.push(
      toolCalls(["secret_ask", { names: ["BRANCH_HELD"] }, "call-ask"]),
      reply("Ok."),
    );
    await harness.session.prompt("Ask.");
    const afterAsk = harness.session.sessionManager.getLeafId();
    if (beforeAsk === null || afterAsk === null) throw new Error("Missing session leaves");

    await harness.session.navigateTree(beforeAsk);
    expect(process.env["PI_SECRET_BRANCH_HELD"]).toBeUndefined();
    await harness.session.navigateTree(afterAsk);
    expect(process.env["PI_SECRET_BRANCH_HELD"]).toBe("branch-held-8b9c0d");
  });
});

describe("Secret Lifetime setting", () => {
  it("uses secret.lifetimeMinutes from Pi's settings", async () => {
    const harness = await createSecretHarness({
      settings: { secret: { lifetimeMinutes: 60 } },
      dialogs: [[keys.paste("hour-long-5d6e7f"), keys.enter]],
    });
    harness.responses.push(
      toolCalls(["secret_ask", { names: ["HOUR_LONG"] }, "call-ask"]),
      reply("Ok."),
    );
    await harness.session.prompt("Ask.");

    expect(harness.result("call-ask")).toMatchObject({
      details: {
        secrets: [
          { name: "HOUR_LONG", expires_at: new Date(harness.clock.now + 3_600_000).toISOString() },
        ],
      },
    });
    expect(harness.frames[0]?.join("\n")).toContain("kept for 1 hour");
  });

  it("warns and keeps the default for a lifetime outside 1–1440 minutes", async () => {
    const harness = await createSecretHarness({ settings: { secret: { lifetimeMinutes: 0 } } });

    expect(harness.notices).toEqual([
      expect.stringMatching(/^Pi Secret: .*using a 15-minute Secret Lifetime.*\/skill:pi-secret/),
    ]);
  });
});
