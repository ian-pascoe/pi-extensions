import { expect, test } from "vitest";
import {
  heldSecretNames,
  holdSecret,
  redactSecrets,
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
