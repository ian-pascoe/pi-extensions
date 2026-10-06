import { Value } from "typebox/value";
import { expect } from "vitest";
import {
  DAP_OPERATIONS,
  DapToolOutputSchemas,
  type DapOperation,
} from "../src/dap-tool-contract.js";

/** Operations whose calls never fail because of the Debug Session state. */
export const NEVER_STATE_FAILING: readonly DapOperation[] = ["set_breakpoints", "status", "stop"];

/** Operations whose output schema declares `desired_breakpoints`. */
export const DESIRED_BREAKPOINT_OPERATIONS: readonly DapOperation[] = DAP_OPERATIONS.filter(
  (operation) => "desired_breakpoints" in DapToolOutputSchemas[operation].properties,
);

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
