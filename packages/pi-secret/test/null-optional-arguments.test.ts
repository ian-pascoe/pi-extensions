import {
  expectNullOptionalArgumentsOmitted,
  recordToolRegistrations,
} from "@ian-pascoe/pi-utils/tool-testing";
import { expect, test } from "vite-plus/test";
import { createPiSecretExtension } from "../src/pi-secret-extension.js";
import { FakeProvider } from "./fixtures/fake-provider.js";

function registeredTools() {
  const { pi, tools } = recordToolRegistrations();
  void createPiSecretExtension({ providers: () => [new FakeProvider()] })(pi);
  return tools;
}

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
