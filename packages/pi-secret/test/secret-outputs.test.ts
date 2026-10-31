import type { JsonValue } from "@earendil-works/pi-ai";
import { createCodemodeExtension, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { SECRET_ENV_PREFIX } from "../src/secret-references.js";
import {
  SecretAskGrantOutputSchema,
  SecretAskOutputSchema,
  SecretForgetOutputSchema,
  SecretListOutputSchema,
  SecretSaveOutputSchema,
} from "../src/secret-outputs.js";
import { FakeProvider } from "./fixtures/fake-provider.js";
import { createSecretHarness, keys, reply, toolCalls } from "./fixtures/secret-harness.js";

const TOKEN = "fake://Dev/GitHub/token";

describe("values for codemode scripts", () => {
  it("declares an outputSchema on every secret_* tool", async () => {
    const harness = await createSecretHarness({ providers: [new FakeProvider()] });
    const declared = Object.fromEntries(
      ["secret_ask", "secret_ask_grant", "secret_list", "secret_save", "secret_forget"].map(
        (name) => [name, harness.session.getToolDefinition(name)?.outputSchema],
      ),
    );

    expect(declared).toEqual({
      secret_ask: SecretAskOutputSchema,
      secret_ask_grant: SecretAskGrantOutputSchema,
      secret_list: SecretListOutputSchema,
      secret_save: SecretSaveOutputSchema,
      secret_forget: SecretForgetOutputSchema,
    });
  });

  it("hands a script each tool's value, holding references and never values", async () => {
    const typed = "typed-in-script-3e4f5a6b";
    const granted = "ghp-script-token-7c8d9e0f";
    const provider = new FakeProvider({ [TOKEN]: granted });
    // Loaded before Pi Secret, so it sees each value as the tool returned it, before redaction.
    const unredacted: JsonValue[] = [];
    const recordUnredacted: ExtensionFactory = (pi) => {
      pi.on("tool_result", (event) => {
        if (event.toolName.startsWith("secret_") && event.structuredContent !== undefined)
          unredacted.push(structuredClone(event.structuredContent));
      });
    };
    const harness = await createSecretHarness({
      before: [createCodemodeExtension(), recordUnredacted],
      providers: [provider],
      // The Secret Request (fill the first field, skip the second), the Grant Request, the save.
      dialogs: [[keys.paste(typed), keys.tab, keys.enter], [keys.enter], [keys.enter]],
    });
    // Pi's built-in codemode registers inactive; SDK sessions activate it explicitly.
    harness.session.setActiveToolsByName([...harness.session.getActiveToolNames(), "codemode"]);
    const code = `
      const asked = await tools.secret_ask({ names: ["TYPED_KEY", "SKIPPED_KEY"] });
      const grant = await tools.secret_ask_grant({ grants: [{ name: "GH_TOKEN", locator: "${TOKEN}" }] });
      const saved = await tools.secret_save({ name: "TYPED_KEY", locator: "fake://Dev/New/credential" });
      const listed = await tools.secret_list({ query: "GitHub" });
      const forgotten = await tools.secret_forget({ names: ["GH_TOKEN", "NEVER_HELD"] });
      return {
        asked: asked.secrets.map((s) => [s.name, s.status, s.env ?? null]),
        granted: [grant.secrets[0].status, grant.secrets[0].locator],
        saved: [saved.secrets[0].status, saved.secrets[0].locator],
        held: listed.secrets.map((s) => [s.name, s.locator ?? null]),
        available: listed.available.map((e) => [e.kind, e.title]),
        forgotten: forgotten.secrets.map((s) => s.status),
      };`;
    harness.responses.push(toolCalls(["codemode", { code }, "call-code"]), reply("Done."));
    await harness.session.prompt("Script it.");

    expect(harness.resultText("call-code")).toContain(
      JSON.stringify({
        asked: [
          ["TYPED_KEY", "provided", `${SECRET_ENV_PREFIX}TYPED_KEY`],
          ["SKIPPED_KEY", "skipped", null],
        ],
        granted: ["granted", TOKEN],
        saved: ["saved", "fake://Dev/item-1/credential"],
        held: [["GH_TOKEN", TOKEN]],
        available: [["item", "GitHub"]],
        forgotten: ["forgotten", "not_held"],
      }),
    );
    // One value per secret_* call, none holding a Secret value even before redaction.
    expect(unredacted).toHaveLength(5);
    for (const value of [typed, granted]) {
      expect(JSON.stringify(unredacted)).not.toContain(value);
      expect(harness.requests.join("\n")).not.toContain(value);
      expect(await harness.sessionFileText()).not.toContain(value);
    }
  });
});
