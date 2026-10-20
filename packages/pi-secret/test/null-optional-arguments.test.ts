import {
  expectNullOptionalArgumentsOmitted,
  recordToolRegistrations,
} from "@ian-pascoe/pi-utils/tool-testing";
import { expect, test } from "vitest";
import { createPiSecretExtension, SECRET_PROVIDER_GUIDELINE } from "../src/pi-secret-extension.js";
import { FakeProvider } from "./fixtures/fake-provider.js";

function registeredTools(withProvider = true) {
  const { pi, tools } = recordToolRegistrations();
  void createPiSecretExtension({ providers: () => (withProvider ? [new FakeProvider()] : []) })(pi);
  return tools;
}

test("registers the Secret Provider tools only when a Secret Provider is available at load", () => {
  expect(registeredTools(false).map(({ name }) => name)).toEqual([
    "secret_ask",
    "secret_list",
    "secret_forget",
  ]);
  expect(registeredTools().map(({ name }) => name)).toEqual([
    "secret_ask",
    "secret_ask_grant",
    "secret_list",
    "secret_save",
    "secret_forget",
  ]);
});

test("adds the Secret Provider guidance through secret_ask_grant, so it appears only with a provider", () => {
  const grant = registeredTools().find(({ name }) => name === "secret_ask_grant");
  expect(grant).toMatchObject({ promptGuidelines: [SECRET_PROVIDER_GUIDELINE] });
});

test.each([
  ["secret_ask", { names: ["API_KEY"] }, ["reason"]],
  ["secret_ask_grant", { grants: [{ name: "API_KEY", locator: "fake://a/b/c" }] }, ["reason"]],
  ["secret_list", {}, ["query", "provider", "vault", "item", "status", "limit"]],
  ["secret_save", { name: "API_KEY", locator: "fake://a/b/c" }, ["category"]],
  ["secret_forget", { names: ["API_KEY"] }, []],
] as const)("%s treats null for an optional parameter like omitting it", (name, args, optional) => {
  const tool = registeredTools().find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`Missing ${name}`);
  expect(expectNullOptionalArgumentsOmitted(tool, structuredClone(args))).toEqual(optional);
});
