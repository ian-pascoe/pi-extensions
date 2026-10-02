import { Value } from "typebox/value";
import { expect } from "vitest";
import { DapToolOutputSchemas, type DapOperation } from "../src/dap-tool-contract.js";

/**
 * Assert a tool result's `structuredContent` satisfies its operation's declared `outputSchema`.
 * Codemode hands scripts exactly this value, so every executed result, including state-failure
 * and cancelled-wait results, must conform.
 */
export function expectDapToolOutput(
  operation: DapOperation,
  result: { readonly structuredContent?: unknown },
): void {
  const schema = DapToolOutputSchemas[operation];
  expect(
    result.structuredContent,
    `dap_${operation} must return structuredContent`,
  ).not.toBeUndefined();
  expect(
    [...Value.Errors(schema, result.structuredContent)].map(
      ({ instancePath, message }) => `${instancePath || "/"} ${message}`,
    ),
    `dap_${operation} structuredContent violates its outputSchema`,
  ).toEqual([]);
}
