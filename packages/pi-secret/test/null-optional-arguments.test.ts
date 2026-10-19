import {
  expectNullOptionalArgumentsOmitted,
  recordToolRegistrations,
} from "@ian-pascoe/pi-utils/tool-testing";
import { expect, test } from "vitest";
import { createPiSecretExtension } from "../src/pi-secret-extension.js";

function registeredTools() {
  const { pi, tools } = recordToolRegistrations();
  void createPiSecretExtension()(pi);
  return tools;
}

test("registers exactly the secret tools", () => {
  expect(registeredTools().map(({ name }) => name)).toEqual([
    "secret_ask",
    "secret_list",
    "secret_forget",
  ]);
});

test.each([
  ["secret_ask", { names: ["API_KEY"] }, ["reason"]],
  ["secret_list", {}, []],
  ["secret_forget", { names: ["API_KEY"] }, []],
] as const)("%s treats null for an optional parameter like omitting it", (name, args, optional) => {
  const tool = registeredTools().find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`Missing ${name}`);
  expect(expectNullOptionalArgumentsOmitted(tool, structuredClone(args))).toEqual(optional);
});
