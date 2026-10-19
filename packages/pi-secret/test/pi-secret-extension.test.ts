import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSecretHarness, keys, reply, toolCalls } from "./fixtures/secret-harness.js";

describe("Secret Request and Secret References", () => {
  it("resolves an entered Secret in another tool's arguments, while the transcript, session file, and provider requests hold only its Secret Reference", async () => {
    const value = "sk-opencode-71c2e9aa";
    const harness = await createSecretHarness({ dialogs: [[keys.paste(value), keys.enter]] });
    harness.responses.push(
      toolCalls(["secret_ask", { names: ["OPENCODE_API_KEY"], reason: "Deploy" }, "call-ask"]),
      toolCalls(["echo", { text: "key={{secret:OPENCODE_API_KEY}}" }, "call-echo"]),
      reply("Done."),
    );
    await harness.session.prompt("Use my OpenCode key.");

    // The tool received the value.
    expect(harness.received).toEqual([{ tool: "echo", args: { text: `key=${value}` } }]);
    // The model learned how to reference it, never the value.
    expect(harness.resultText("call-ask")).toContain("{{secret:OPENCODE_API_KEY}}");
    expect(harness.resultText("call-ask")).toContain("$PI_SECRET_OPENCODE_API_KEY");
    // The echoed value came back redacted to its Secret Reference.
    expect(harness.resultText("call-echo")).toBe("echo: key={{secret:OPENCODE_API_KEY}}");
    expect(harness.result("call-echo")).toMatchObject({
      details: { text: "key={{secret:OPENCODE_API_KEY}}" },
    });
    // Nothing that leaves the process or reaches disk holds the value.
    expect(harness.requests.join("\n")).not.toContain(value);
    expect(await harness.sessionFileText()).not.toContain(value);
    expect(harness.frames.flat().join("\n")).not.toContain(value);
  });

  it("exports a Secret as $PI_SECRET_NAME to shell commands and redacts it from their output", async () => {
    const value = "pw-bash-0d81f4c6";
    const harness = await createSecretHarness({
      builtinTools: true,
      dialogs: [[keys.paste(value), keys.enter]],
    });
    harness.responses.push(
      toolCalls(["secret_ask", { names: ["DB_PASSWORD"] }, "call-ask"]),
      toolCalls(["bash", { command: 'printf "pw=%s" "$PI_SECRET_DB_PASSWORD"' }, "call-bash"]),
      reply("Done."),
    );
    await harness.session.prompt("Check the database password.");

    expect(harness.resultText("call-bash")).toBe("pw={{secret:DB_PASSWORD}}");
    expect(harness.requests.join("\n")).not.toContain(value);
    expect(await harness.sessionFileText()).not.toContain(value);
  });

  it.each([
    ["a Secret Reference", { text: "{{secret:NEVER_PROVIDED}}" }, "{{secret:NEVER_PROVIDED}}"],
    [
      "an environment reference",
      { text: "curl -u $PI_SECRET_NEVER_PROVIDED" },
      "{{secret:NEVER_PROVIDED}}",
    ],
    ["a malformed Secret Name", { text: "{{secret:lower-case}}" }, "{{secret:lower-case}}"],
  ])(
    "blocks a call whose %s names no held Secret, and says to ask again",
    async (_kind, args, named) => {
      const harness = await createSecretHarness();
      harness.responses.push(toolCalls(["echo", args, "call-echo"]), reply("Done."));
      await harness.session.prompt("Go.");

      expect(harness.received).toEqual([]);
      const text = harness.resultText("call-echo");
      expect(text).toContain(named);
      expect(text).toContain("Call secret_ask to request it again");
    },
  );

  it("reports skipped and cancelled names and holds nothing for them", async () => {
    const harness = await createSecretHarness({
      // Skip the first field, fill the second; then cancel a second request outright.
      dialogs: [
        [keys.tab, keys.paste("token-kept-55e1a0"), keys.enter],
        [keys.paste("typed-then-cancelled"), keys.escape],
      ],
    });
    harness.responses.push(
      toolCalls(["secret_ask", { names: ["SKIPPED_ONE", "KEPT_ONE"] }, "call-ask-1"]),
      toolCalls(["secret_ask", { names: ["CANCELLED_ONE"] }, "call-ask-2"]),
      toolCalls(["secret_list", {}, "call-list"]),
      reply("Done."),
    );
    await harness.session.prompt("Ask twice.");

    expect(harness.result("call-ask-1")).toMatchObject({
      details: {
        secrets: [
          { name: "SKIPPED_ONE", status: "skipped" },
          { name: "KEPT_ONE", status: "provided", reference: "{{secret:KEPT_ONE}}" },
        ],
      },
    });
    expect(harness.result("call-ask-2")).toMatchObject({
      details: { secrets: [{ name: "CANCELLED_ONE", status: "cancelled" }] },
    });
    const listed = harness.resultText("call-list") ?? "";
    expect(listed).toContain("KEPT_ONE");
    expect(listed).not.toContain("SKIPPED_ONE");
    expect(listed).not.toContain("CANCELLED_ONE");
  });

  it("lists held Secrets with their expiry and forgets them on request", async () => {
    const harness = await createSecretHarness({
      dialogs: [[keys.paste("forget-me-6a7b8c9d"), keys.enter]],
    });
    harness.responses.push(
      toolCalls(["secret_ask", { names: ["FORGET_ME"] }, "call-ask"]),
      toolCalls(["secret_list", {}, "call-list"]),
      toolCalls(["secret_forget", { names: ["FORGET_ME", "NEVER_HELD"] }, "call-forget"]),
      toolCalls(["echo", { text: "{{secret:FORGET_ME}}" }, "call-echo"]),
      reply("Done."),
    );
    await harness.session.prompt("Use and forget.");

    // The default Secret Lifetime is 15 minutes from entry.
    expect(harness.resultText("call-list")).toContain(
      `FORGET_ME: held until ${new Date(harness.clock.now + 15 * 60_000).toISOString()}`,
    );
    expect(harness.result("call-forget")).toMatchObject({
      details: {
        secrets: [
          { name: "FORGET_ME", status: "forgotten" },
          { name: "NEVER_HELD", status: "not_held" },
        ],
      },
    });
    expect(process.env["PI_SECRET_FORGET_ME"]).toBeUndefined();
    expect(harness.received).toEqual([]);
    expect(harness.resultText("call-echo")).toContain("Call secret_ask to request it again");
  });

  it("redacts a full output file a tool result points at", async () => {
    const value = "spilled-secret-91f0e2";
    const harness = await createSecretHarness({
      dialogs: [[keys.paste(value), keys.enter]],
    });
    const path = join(harness.dir, "full-output.log");
    harness.responses.push(
      toolCalls(["secret_ask", { names: ["SPILLED"] }, "call-ask"]),
      toolCalls(["spill", { text: "line\n{{secret:SPILLED}}\n", path }, "call-spill"]),
      reply("Done."),
    );
    await harness.session.prompt("Spill.");

    expect(harness.received).toEqual([{ tool: "spill", args: { text: `line\n${value}\n`, path } }]);
    expect(await readFile(path, "utf8")).toBe("line\n{{secret:SPILLED}}\n");
  });

  it("never rewrites a file a tool result points at through a symbolic link", async () => {
    const value = "linked-secret-0c9d8e";
    const harness = await createSecretHarness({ dialogs: [[keys.paste(value), keys.enter]] });
    const target = join(harness.dir, "user-file.env");
    const link = join(harness.dir, "full-output-link.log");
    await writeFile(target, "");
    await symlink(target, link);
    harness.responses.push(
      toolCalls(["secret_ask", { names: ["LINKED"] }, "call-ask"]),
      toolCalls(["spill", { text: "TOKEN={{secret:LINKED}}", path: link }, "call-spill"]),
      reply("Done."),
    );
    await harness.session.prompt("Spill through a link.");

    expect(await readFile(target, "utf8")).toBe(`TOKEN=${value}`);
  });

  it("withholds a tool result it cannot check for Secret values", async () => {
    const harness = await createSecretHarness({
      dialogs: [[keys.paste("any-held-value-4242"), keys.enter]],
    });
    harness.responses.push(
      toolCalls(["secret_ask", { names: ["ANY_HELD"] }, "call-ask"]),
      toolCalls(["unreadable", {}, "call-unreadable"]),
      reply("Done."),
    );
    await harness.session.prompt("Run it.");

    expect(harness.received).toEqual([{ tool: "unreadable", args: {} }]);
    expect(harness.result("call-unreadable")).toMatchObject({ isError: true, details: {} });
    expect(harness.resultText("call-unreadable")).toMatch(
      /^Pi Secret could not check this tool result/,
    );
  });

  it("refuses to ask without the interactive terminal, as in print mode and Child Agents", async () => {
    const harness = await createSecretHarness({ headless: true });
    harness.responses.push(
      toolCalls(["secret_ask", { names: ["HEADLESS"] }, "call-ask"]),
      reply("Done."),
    );
    await harness.session.prompt("Ask.");

    expect(harness.result("call-ask")).toMatchObject({ isError: true });
    expect(harness.resultText("call-ask")).toContain("needs Pi's interactive terminal");
  });

  it("lets another session in the process, such as a Child Agent's, use a Secret the root holds", async () => {
    const value = "root-held-c0ffee11";
    const root = await createSecretHarness({ dialogs: [[keys.paste(value), keys.enter]] });
    root.responses.push(toolCalls(["secret_ask", { names: ["ROOT_HELD"] }, "call-ask"]));
    await root.session.prompt("Ask.");

    const child = await createSecretHarness({ headless: true });
    child.responses.push(
      toolCalls(["echo", { text: "{{secret:ROOT_HELD}}" }, "call-echo"]),
      toolCalls(["secret_forget", { names: ["ROOT_HELD"] }, "call-forget"]),
      toolCalls(["secret_list", {}, "call-list"]),
      reply("Done."),
    );
    await child.session.prompt("Use it.");

    expect(child.received).toEqual([{ tool: "echo", args: { text: value } }]);
    expect(child.resultText("call-echo")).toBe("echo: {{secret:ROOT_HELD}}");
    // Only the session that holds a Secret can forget it.
    expect(child.result("call-forget")).toMatchObject({
      details: { secrets: [{ name: "ROOT_HELD", status: "not_held" }] },
    });
    expect(child.resultText("call-list")).toContain("ROOT_HELD: held by another session");
  });
});

describe("/secret command", () => {
  it("lists held Secrets with their expiry and forgets one or all of them", async () => {
    const harness = await createSecretHarness({
      dialogs: [
        [keys.paste("command-one-1111"), keys.tab, keys.paste("command-two-2222"), keys.enter],
      ],
    });
    harness.responses.push(
      toolCalls(["secret_ask", { names: ["COMMAND_ONE", "COMMAND_TWO"] }, "call-ask"]),
      reply("Ok."),
    );
    await harness.session.prompt("Ask.");
    const expires = new Date(harness.clock.now + 15 * 60_000).toISOString();

    await harness.session.prompt("/secret");
    expect(harness.notices.at(-1)).toBe(
      `COMMAND_ONE: expires ${expires}\nCOMMAND_TWO: expires ${expires}`,
    );
    await harness.session.prompt("/secret forget COMMAND_ONE");
    expect(harness.notices.at(-1)).toBe("COMMAND_ONE: forgotten.");
    expect(process.env["PI_SECRET_COMMAND_ONE"]).toBeUndefined();
    await harness.session.prompt("/secret forget all");
    expect(harness.notices.at(-1)).toBe("COMMAND_TWO: forgotten.");
    await harness.session.prompt("/secret list");
    expect(harness.notices.at(-1)).toBe("No Secrets are held");
    // Commands never reach the model.
    expect(harness.requests).toHaveLength(2);
  });
});

describe("provider requests", () => {
  it("redacts a held value wherever it appears, and keeps the cached prefix stable across turns", async () => {
    const value = "typed-into-chat-77aa";
    const harness = await createSecretHarness({ dialogs: [[keys.paste(value), keys.enter]] });
    harness.responses.push(
      toolCalls(["secret_ask", { names: ["CHAT_TYPED"] }, "call-ask"]),
      reply("Stored."),
    );
    await harness.session.prompt("Store my token.");
    await harness.session.prompt(`Oops, I pasted it here too: ${value}`);
    await harness.session.prompt("Carry on.");

    expect(harness.requests.join("\n")).not.toContain(value);
    // Each request's messages begin with the previous request's messages, unchanged.
    const [, , second, third] = harness.requestMessages;
    expect(second).toBeDefined();
    expect(third?.slice(0, second?.length)).toEqual(second);
    expect(JSON.stringify(second)).toContain("Oops, I pasted it here too: {{secret:CHAT_TYPED}}");
  });
});
