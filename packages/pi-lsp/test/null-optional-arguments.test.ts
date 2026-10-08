import {
  expectNullOptionalArgumentsOmitted,
  recordToolRegistrations,
} from "@ian-pascoe/pi-utils/tool-testing";
import { expect, test } from "vitest";
import { LSP_OPERATION_NAMES } from "../src/lsp-tool-contract.js";
import { createPiLspExtension } from "../src/pi-lsp-extension.js";

test("every lsp_* tool treats null for an optional parameter like omitting it", async () => {
  const { pi, tools } = recordToolRegistrations();
  await createPiLspExtension({ getAgentDirectory: () => "/nonexistent" })(pi);

  expect(tools.map(({ name }) => name)).toEqual(
    LSP_OPERATION_NAMES.map((operation) => `lsp_${operation}`),
  );
  const proven = new Map<string, string[]>();
  for (const tool of tools) {
    // lsp_apply resolves its Mutation Manifest from a session's preview ledger (see its own test).
    if (tool.name === "lsp_apply") continue;
    proven.set(tool.name, expectNullOptionalArgumentsOmitted(tool));
  }
  // The reported call: `depth: null` on lsp_document_symbols.
  expect(proven.get("lsp_document_symbols")).toContain("depth");
  expect(proven.get("lsp_find_references")).toContain("include_declaration");
  expect([...proven.values()].filter((names) => names.length > 0).length).toBeGreaterThan(10);
});
