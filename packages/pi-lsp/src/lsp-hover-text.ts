import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { assembleLspReadText, type LspRead, type LspReadTextBlock } from "./lsp-location-text.js";
import { formatLspToolValue } from "./lsp-tool-output.js";

/** A deprecated `MarkedString`: markdown text, or a code block in a language. */
const MarkedStringSchema = Type.Union([
  Type.String(),
  Type.Object({ language: Type.String(), value: Type.String() }),
]);
const MarkupContentSchema = Type.Object({ kind: Type.String(), value: Type.String() });
const HoverSchema = Type.Object({
  contents: Type.Union([MarkupContentSchema, MarkedStringSchema, Type.Array(MarkedStringSchema)]),
});

function markedStringText(marked: Static<typeof MarkedStringSchema>): string {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- A MarkedString is a string or a code block.
  if (typeof marked === "string") return marked;
  return `\`\`\`${marked.language}\n${marked.value}\n\`\`\``;
}

function hoverContentsText(contents: Static<typeof HoverSchema>["contents"]): string {
  if (Array.isArray(contents)) return contents.map(markedStringText).join("\n\n").trim();
  if (Value.Check(MarkupContentSchema, contents)) return contents.value.trim();
  return markedStringText(contents).trim();
}

/** The inputs of one hover read's model-visible text. */
export interface LspHoverReadTextInput {
  readonly reads: readonly LspRead[];
  readonly warnings: readonly string[];
  /** Lines shown before the contents, such as the queried position. */
  readonly scope: readonly string[];
  /** The line shown for a server that has no hover contents at the position. */
  readonly emptyMessage: (read: LspRead) => string;
}

/** One server's hover lines, or undefined when it has no hover contents at the position. */
function hoverLines(read: LspRead): readonly string[] | undefined {
  if (read.value === null || read.value === undefined) return undefined;
  if (!Value.Check(HoverSchema, read.value)) return [formatLspToolValue(read.value)];
  const text = hoverContentsText(read.value.contents);
  return text === "" ? undefined : text.split("\n");
}

/**
 * Render a hover read as its markdown or plaintext contents only. Results are grouped by server
 * only when more than one server answered, and server failures follow as warnings. When no server
 * has hover contents, the result says so once. A response that is not hover-shaped is shown as
 * compact JSON instead.
 */
export function formatLspHoverReadText(input: LspHoverReadTextInput): string {
  const hovers = input.reads.map((read) => ({ read, lines: hoverLines(read) }));
  if (hovers.every(({ lines }) => lines === undefined)) {
    return assembleLspReadText({
      blocks: [{ server_id: "", lines: [...new Set(input.reads.map(input.emptyMessage))] }],
      warnings: input.warnings,
    });
  }
  const blocks = hovers.map(({ read, lines }): LspReadTextBlock => ({
    server_id: read.server_id,
    lines: lines ?? [input.emptyMessage(read)],
  }));
  return assembleLspReadText({ blocks, warnings: input.warnings, scope: input.scope });
}
