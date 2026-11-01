import { expectToolOutputMatches } from "@ian-pascoe/pi-utils/tool-testing";
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
  result: { readonly structuredContent?: unknown; readonly isError?: boolean },
): void {
  expectToolOutputMatches(
    { name: `dap_${operation}`, outputSchema: DapToolOutputSchemas[operation] },
    result,
  );
}
