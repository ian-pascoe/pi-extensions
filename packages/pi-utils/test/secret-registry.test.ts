import { expect, test } from "vitest";
import {
  heldSecretNames,
  holdRefreshableSecret,
  holdSecret,
  redactionGeneration,
  redactSecrets,
  refreshSecret,
  resolveSecret,
  revokeSecret,
  secretReference,
} from "../src/secret-registry.js";

const owner = { description: "test" };

test("a held Secret resolves by name and is redacted to its Secret Reference in nested values", () => {
  holdSecret("REGISTRY_API_KEY", "sk-live-4f9a2c", owner);
  expect(resolveSecret("REGISTRY_API_KEY")).toBe("sk-live-4f9a2c");
  expect(heldSecretNames()).toContain("REGISTRY_API_KEY");

  const output = {
    content: [{ type: "text", text: "token=sk-live-4f9a2c; again sk-live-4f9a2c" }],
    details: { exitCode: 0, lines: ["sk-live-4f9a2c", "unrelated"] },
  };
  expect(redactSecrets(output)).toEqual({
    content: [
      {
        type: "text",
        text: "token={{secret:REGISTRY_API_KEY}}; again {{secret:REGISTRY_API_KEY}}",
      },
    ],
    details: { exitCode: 0, lines: ["{{secret:REGISTRY_API_KEY}}", "unrelated"] },
  });
  // The input is never modified in place.
  expect(output.details.lines[0]).toBe("sk-live-4f9a2c");
});

test("a value with nothing to redact is returned as the same reference", () => {
  holdSecret("REGISTRY_UNUSED", "never-printed-7731", owner);
  const value = { text: "nothing secret here", nested: ["still nothing"] };
  expect(redactSecrets(value)).toBe(value);
});

test("redaction prefers the longest value and never re-redacts inserted references", () => {
  holdSecret("REGISTRY_SHORT", "hunter2", owner);
  holdSecret("REGISTRY_LONG", "hunter2-extended", owner);
  // A value that also occurs inside every Secret Reference's own text.
  holdSecret("REGISTRY_WORD", "secret", owner);
  expect(redactSecrets("hunter2-extended then hunter2 then secret")).toBe(
    "{{secret:REGISTRY_LONG}} then {{secret:REGISTRY_SHORT}} then {{secret:REGISTRY_WORD}}",
  );
  revokeSecret("REGISTRY_WORD", owner);
});

test("a held value is redacted in its common encodings too, at any base64 alignment", () => {
  const value = 'p@ss "word"/9f3k';
  holdSecret("REGISTRY_ENCODED", value, owner);
  const reference = secretReference("REGISTRY_ENCODED");
  const basic = Buffer.from(`user:${value}`).toString("base64");
  const encodings = [
    JSON.stringify({ password: value }),
    `https://example.test/?pw=${encodeURIComponent(value)}`,
    Buffer.from(value).toString("hex"),
    Buffer.from(value).toString("hex").toUpperCase(),
    Buffer.from(value).toString("base64"),
    Buffer.from(value).toString("base64url"),
    `Authorization: Basic ${basic}`,
    Buffer.from(`ab:${value}!`).toString("base64"),
    Buffer.from(`abc:${value}`).toString("base64url"),
  ];
  for (const text of encodings) {
    const [before, after, ...rest] = redactSecrets(text).split(reference);
    expect(rest, text).toEqual([]);
    expect(after, text).toBeDefined();
    // Only the characters that mix in neighbouring bytes, or padding, survive around it.
    expect(`${before ?? ""}${after ?? ""}`.length, text).toBeLessThanOrEqual(
      text.length - value.length,
    );
  }
  const header = redactSecrets(`Authorization: Basic ${basic}`);
  expect(header.startsWith(`Authorization: Basic ${basic.slice(0, 7)}${reference}`)).toBe(true);
});

test("a value shorter than eight characters is redacted only as written", () => {
  holdSecret("REGISTRY_TINY", "t1ny-pw", owner);
  const hex = Buffer.from("t1ny-pw").toString("hex");
  expect(redactSecrets(`t1ny-pw ${hex}`)).toBe(`${secretReference("REGISTRY_TINY")} ${hex}`);
});

test("a revoked Secret no longer resolves but is still redacted", () => {
  holdSecret("REGISTRY_REVOKED", "old-password-0042", owner);
  revokeSecret("REGISTRY_REVOKED", owner);
  expect(resolveSecret("REGISTRY_REVOKED")).toBeUndefined();
  expect(heldSecretNames()).not.toContain("REGISTRY_REVOKED");
  expect(redactSecrets("echo old-password-0042")).toBe("echo {{secret:REGISTRY_REVOKED}}");
});

test("a Secret held with an expiry stops resolving once it passes, even if never revoked", () => {
  holdSecret("REGISTRY_LAPSED", "lapsed-value-3141", owner, Date.now() - 1);
  holdSecret("REGISTRY_CURRENT", "current-value-2718", owner, Date.now() + 60_000);
  expect(resolveSecret("REGISTRY_LAPSED")).toBeUndefined();
  expect(heldSecretNames()).not.toContain("REGISTRY_LAPSED");
  expect(resolveSecret("REGISTRY_CURRENT")).toBe("current-value-2718");
  expect(redactSecrets("lapsed-value-3141")).toBe("{{secret:REGISTRY_LAPSED}}");
});

test("only the owner that held a Secret can revoke it", () => {
  holdSecret("REGISTRY_OWNED", "owned-value-9911", owner);
  revokeSecret("REGISTRY_OWNED", { description: "other" });
  expect(resolveSecret("REGISTRY_OWNED")).toBe("owned-value-9911");
  revokeSecret("REGISTRY_OWNED", owner);
  expect(resolveSecret("REGISTRY_OWNED")).toBeUndefined();
});

test("holding a Secret again replaces its value and keeps redacting the old one", () => {
  holdSecret("REGISTRY_ROTATED", "first-value-1234", owner);
  holdSecret("REGISTRY_ROTATED", "second-value-5678", owner);
  expect(resolveSecret("REGISTRY_ROTATED")).toBe("second-value-5678");
  expect(redactSecrets("first-value-1234 second-value-5678")).toBe(
    "{{secret:REGISTRY_ROTATED}} {{secret:REGISTRY_ROTATED}}",
  );
});

test("redacting at an earlier Redaction Generation leaves values held since then as written", () => {
  holdSecret("REGISTRY_EARLIER", "earlier-value-2468", owner);
  const generation = redactionGeneration();
  holdSecret("REGISTRY_LATER", "later-value-1357", owner);
  // Holding a value again, even under another name, keeps the generation.
  holdSecret("REGISTRY_EARLIER_AGAIN", "earlier-value-2468", owner);
  expect(redactionGeneration()).toBe(generation + 1);

  const text = "earlier-value-2468 later-value-1357";
  expect(redactSecrets(text, generation)).toBe(
    "{{secret:REGISTRY_EARLIER_AGAIN}} later-value-1357",
  );
  expect(redactSecrets(text, generation + 1)).toBe(redactSecrets(text));
  expect(redactSecrets(text, 0)).toBe(text);
});

test("every copy of pi-utils in the process shares one registry", async () => {
  // A second module instance, as when two packages each install their own pi-utils.
  const copy: typeof import("../src/secret-registry.js") = await import(
    // @ts-expect-error -- the query string makes Vite load a separate module instance.
    "../src/secret-registry.ts?second-copy"
  );
  expect(copy.holdSecret).not.toBe(holdSecret);
  copy.holdSecret("REGISTRY_SHARED", "shared-value-5150", owner);
  expect(resolveSecret("REGISTRY_SHARED")).toBe("shared-value-5150");
  expect(redactSecrets("shared-value-5150")).toBe("{{secret:REGISTRY_SHARED}}");
});

test("Secret Names must be environment-variable style and values non-empty", () => {
  expect(() => holdSecret("lower_case", "value-1", owner)).toThrow(/Secret Name/);
  expect(() => holdSecret("1STARTS_WITH_DIGIT", "value-1", owner)).toThrow(/Secret Name/);
  expect(() => holdSecret("EMPTY_VALUE", "", owner)).toThrow(/empty/);
  expect(secretReference("OPENCODE_API_KEY")).toBe("{{secret:OPENCODE_API_KEY}}");
});

test("a refreshable Secret reads its value on each refresh, and every value read stays redacted", async () => {
  const codes = ["otp-code-111111", "otp-code-222222"];
  const refresh = async () => codes.shift() ?? "exhausted";
  holdRefreshableSecret("REGISTRY_OTP", owner, { refresh });
  expect(heldSecretNames()).toContain("REGISTRY_OTP");
  // Nothing has been read yet, so nothing resolves until it is refreshed.
  expect(resolveSecret("REGISTRY_OTP")).toBeUndefined();

  expect(await refreshSecret("REGISTRY_OTP")).toBe("otp-code-111111");
  expect(resolveSecret("REGISTRY_OTP")).toBe("otp-code-111111");
  expect(await refreshSecret("REGISTRY_OTP")).toBe("otp-code-222222");
  expect(redactSecrets("otp-code-111111 otp-code-222222")).toBe(
    "{{secret:REGISTRY_OTP}} {{secret:REGISTRY_OTP}}",
  );
  revokeSecret("REGISTRY_OTP", owner);
  expect(await refreshSecret("REGISTRY_OTP")).toBeUndefined();
});

test("refreshing a Secret without a refresh callback returns its held value", async () => {
  holdSecret("REGISTRY_TYPED", "typed-value-9e8d7c", owner);
  expect(await refreshSecret("REGISTRY_TYPED")).toBe("typed-value-9e8d7c");
  revokeSecret("REGISTRY_TYPED", owner);
});

test("a failed refresh rejects and keeps the last value read", async () => {
  let fail = false;
  holdRefreshableSecret("REGISTRY_FLAKY", owner, {
    value: "flaky-value-5a5a5a",
    refresh: async () => {
      if (fail) throw new Error("1Password is locked");
      return "flaky-value-6b6b6b";
    },
  });
  expect(resolveSecret("REGISTRY_FLAKY")).toBe("flaky-value-5a5a5a");
  fail = true;
  await expect(refreshSecret("REGISTRY_FLAKY")).rejects.toThrow("1Password is locked");
  expect(resolveSecret("REGISTRY_FLAKY")).toBe("flaky-value-5a5a5a");
  revokeSecret("REGISTRY_FLAKY", owner);
});
