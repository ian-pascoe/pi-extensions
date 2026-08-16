import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import type { LSPAny } from "vscode-languageserver-protocol";
import type { LspSessionFiles } from "./lsp-session-files.js";
import { LspToolResultDetailsSchema, type LspToolResultDetails } from "./lsp-tool-contract.js";

function deterministicLspValue(value: LSPAny): LSPAny {
  if (Array.isArray(value)) return value.map(deterministicLspValue);
  if (value instanceof Map) {
    return [...value.entries()]
      .sort(([left], [right]) => String(left).localeCompare(String(right)))
      .map(([key, entryValue]) => [key, deterministicLspValue(entryValue)]);
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Protocol output is recursively normalized at this rendering boundary.
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, deterministicLspValue(entryValue)]),
  );
}

/** Render a protocol result as stable compact JSON while retaining readable URI strings. */
export function formatLspToolValue(value: LSPAny): string {
  const text = JSON.stringify(deterministicLspValue(value));
  return text === undefined ? "null" : text;
}

/** Validate normalized details, truncate model-visible text, and spill every complete oversized result. */
export async function createLspToolOutput(
  text: string,
  details: LspToolResultDetails,
  sessionFiles: LspSessionFiles,
): Promise<AgentToolResult<LspToolResultDetails>> {
  const normalizedDetails = Value.Parse(LspToolResultDetailsSchema, details);
  const truncated = truncateHead(text, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  if (!truncated.truncated) {
    return { content: [{ type: "text", text }], details: normalizedDetails };
  }

  const spillPath = await sessionFiles.writeResultSpill(text);
  const notice = `\n\n[Pi LSP: output truncated; complete Result Spill: ${spillPath}]`;
  const visibleText = `${truncated.content}${notice}`;
  const detailsWithSpill =
    normalizedDetails.kind === "operation"
      ? Value.Parse(LspToolResultDetailsSchema, {
          ...normalizedDetails,
          spill_path: spillPath,
        })
      : normalizedDetails;
  return {
    content: [{ type: "text", text: visibleText }],
    details: detailsWithSpill,
  };
}
