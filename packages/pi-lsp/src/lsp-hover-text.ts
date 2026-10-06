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

/**
 * Render a hover read as its markdown or plaintext contents only. Results are grouped by server
 * only when more than one server answered, and server failures follow as warnings. A response
 * that is not hover-shaped is shown as compact JSON instead.
 */
export function formatLspHoverReadText(input: LspHoverReadTextInput): string {
  const blocks = input.reads.map((read): LspReadTextBlock => {
    if (read.value === null || read.value === undefined) {
      return { server_id: read.server_id, lines: [input.emptyMessage(read)] };
    }
    if (!Value.Check(HoverSchema, read.value)) {
      return { server_id: read.server_id, lines: [formatLspToolValue(read.value)] };
    }
    const text = hoverContentsText(read.value.contents);
    return {
      server_id: read.server_id,
      lines: text === "" ? [input.emptyMessage(read)] : text.split("\n"),
    };
  });
  return assembleLspReadText({ blocks, warnings: input.warnings, scope: input.scope });
}
