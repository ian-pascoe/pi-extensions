import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import type { ContentBlock, JSONValue } from "@modelcontextprotocol/client";
import type { McpSessionFiles } from "./mcp-session-files.js";

/** MCP text content received from a Server Tool, Resource, or Prompt. */
export type McpTextContent = Extract<ContentBlock, { readonly type: "text" }>;

/** MCP image content represented as base64 data and its declared media type. */
export type McpImageContent = Extract<ContentBlock, { readonly type: "image" }>;

/** MCP audio content that Pi stores privately because Pi has no native audio tool content. */
export type McpAudioContent = Extract<ContentBlock, { readonly type: "audio" }>;

/** MCP embedded resource content, including either text or base64 binary data. */
export type McpResourceContent = Extract<ContentBlock, { readonly type: "resource" }>;

/** Text or binary resource embedded directly in MCP content. */
export type McpEmbeddedResource = McpResourceContent["resource"];

/** A server-provided reference to an MCP Resource that remains unread. */
export type McpResourceLinkContent = Extract<ContentBlock, { readonly type: "resource_link" }>;

/** Public MCP v2 content blocks that Pi can map to model content or private session files. */
export type McpContentBlock =
  | McpTextContent
  | McpImageContent
  | McpAudioContent
  | McpResourceContent
  | McpResourceLinkContent;

/** Pi-native text or image content that remains visible to the model. */
export type McpModelContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string };

/** One unsupported MCP content block stored privately instead of being discarded. */
export interface McpStoredContent {
  /** Original MCP content category that Pi cannot render natively. */
  readonly kind: "audio" | "embedded_binary";
  /** Server-declared media type, if it supplied one. */
  readonly mimeType?: string;
  /** Mode-safe private session file that contains the original bytes. */
  readonly path: string;
  /** Embedded resource URI when the stored bytes came from an MCP Resource. */
  readonly uri?: string;
}

/** Bounded diagnostic details retained beside mapped MCP model content. */
export interface McpContentResultDetails {
  /** Complete oversized text representation, retained only in a private Result Spill. */
  readonly spillPath?: string;
  /** Every audio or binary payload retained in a private session file. */
  readonly storedContent: readonly McpStoredContent[];
  /** Model-facing textual representation, bounded to Pi's line and byte limits. */
  readonly summary: string;
}

/** Pi-native content plus bounded diagnostic details produced from one MCP result. */
export interface McpContentResult {
  readonly content: readonly McpModelContent[];
  readonly details: McpContentResultDetails;
}

function hasMcpEmbeddedText(
  resource: McpEmbeddedResource,
): resource is Extract<McpEmbeddedResource, { readonly text: string }> {
  return "text" in resource;
}

function hasMcpEmbeddedBlob(
  resource: McpEmbeddedResource,
): resource is Extract<McpEmbeddedResource, { readonly blob: string }> {
  return "blob" in resource;
}

function describeMcpEmbeddedTextResource(
  resource: Extract<McpEmbeddedResource, { readonly text: string }>,
): string {
  const mediaType = resource.mimeType === undefined ? "unknown media type" : resource.mimeType;
  return `[MCP embedded resource: ${resource.uri} (${mediaType})]\n${resource.text}`;
}

function describeMcpResourceLink(resourceLink: McpResourceLinkContent): string {
  const details = [
    resourceLink.mimeType,
    resourceLink.size === undefined ? undefined : `${resourceLink.size} bytes`,
  ]
    .filter((detail): detail is string => detail !== undefined)
    .join(", ");
  const suffix = resourceLink.description === undefined ? "" : ` — ${resourceLink.description}`;
  return `[MCP resource link: ${resourceLink.name}] ${resourceLink.uri}${
    details.length === 0 ? "" : ` (${details})`
  }${suffix}`;
}

function stringifyMcpStructuredContent(structuredContent: JSONValue): string {
  try {
    const serialized = JSON.stringify(structuredContent);
    return serialized ?? "null";
  } catch (cause) {
    throw new Error("Pi MCP: cannot serialize structured content for model output", { cause });
  }
}

function decodeMcpBase64Content(data: string, subject: string): Uint8Array {
  try {
    return Buffer.from(data, "base64");
  } catch (cause) {
    throw new Error(`Pi MCP: cannot decode ${subject} base64 content`, { cause });
  }
}

/** Map MCP content losslessly to native Pi content or labelled mode-safe session-file references. */
export async function createMcpContentResult(
  contentBlocks: readonly McpContentBlock[],
  structuredContent: JSONValue | undefined,
  sessionFiles: McpSessionFiles,
): Promise<McpContentResult> {
  const textParts: string[] = [];
  const mappedContent: McpModelContent[] = [];
  const storedContent: McpStoredContent[] = [];
  const addModelText = (text: string): void => {
    textParts.push(text);
    mappedContent.push({ type: "text", text });
  };

  for (const content of contentBlocks) {
    switch (content.type) {
      case "text":
        addModelText(content.text);
        break;
      case "image":
        mappedContent.push({ type: "image", data: content.data, mimeType: content.mimeType });
        break;
      case "audio": {
        const path = await sessionFiles.writeUnsupportedContent(
          decodeMcpBase64Content(content.data, "audio"),
          content.mimeType,
        );
        storedContent.push({ kind: "audio", mimeType: content.mimeType, path });
        addModelText(`[MCP unsupported audio (${content.mimeType}) stored at: ${path}]`);
        break;
      }
      case "resource": {
        if (hasMcpEmbeddedText(content.resource)) {
          addModelText(describeMcpEmbeddedTextResource(content.resource));
          break;
        }
        if (hasMcpEmbeddedBlob(content.resource)) {
          const path = await sessionFiles.writeUnsupportedContent(
            decodeMcpBase64Content(content.resource.blob, "embedded resource"),
            content.resource.mimeType ?? "application/octet-stream",
          );
          storedContent.push({
            kind: "embedded_binary",
            ...(content.resource.mimeType !== undefined && { mimeType: content.resource.mimeType }),
            path,
            uri: content.resource.uri,
          });
          addModelText(
            `[MCP embedded binary resource: ${content.resource.uri} (${content.resource.mimeType ?? "unknown media type"}) stored at: ${path}]`,
          );
          break;
        }
        break;
      }
      case "resource_link":
        addModelText(describeMcpResourceLink(content));
        break;
    }
  }

  if (structuredContent !== undefined) {
    addModelText(`[MCP structured content]\n${stringifyMcpStructuredContent(structuredContent)}`);
  }

  const completeText = textParts.join("\n\n");
  const truncation = truncateHead(completeText, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  const spillPath = truncation.truncated
    ? await sessionFiles.writeResultSpill(completeText)
    : undefined;
  const modelText =
    spillPath === undefined
      ? completeText
      : `${truncation.content}\n\n[Pi MCP: content truncated; complete Result Spill: ${spillPath}]`;
  const content =
    spillPath === undefined
      ? mappedContent
      : [
          ...(modelText.length === 0 ? [] : [{ type: "text" as const, text: modelText }]),
          ...mappedContent.filter(
            (content): content is Extract<McpModelContent, { type: "image" }> =>
              content.type === "image",
          ),
        ];

  return {
    content,
    details: {
      ...(spillPath !== undefined && { spillPath }),
      storedContent,
      summary: truncation.content,
    },
  };
}
