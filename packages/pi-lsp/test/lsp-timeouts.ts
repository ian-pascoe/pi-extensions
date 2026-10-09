import type { LspTimeouts } from "../src/pi-lsp-settings.js";

/** Complete timeouts for a test, so a new timeout field needs one change here, not one per literal. */
export function testTimeouts(overrides: Partial<LspTimeouts> = {}): LspTimeouts {
  return {
    diagnosticsMs: 3000,
    initializeMs: 45000,
    requestMs: 3000,
    shutdownMs: 5000,
    workspaceRequestMs: 15000,
    ...overrides,
  };
}
