import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

const TRUNCATION_NOTICE_LINES = 2;

/**
 * Largest UTF-8 byte length of the text a codemode script receives in `structuredContent`. Scripts
 * cannot read the private spill file, so this is far above the 50 KiB the model sees; it matches
 * the 1 MiB Pi gives scripts for `bash` output and keeps one result from exhausting memory.
 */
export const WEB_TOOL_STRUCTURED_MAX_BYTES = 1024 * 1024;

/** Result text for script callers and whether it was cut at the limit. */
export type WebToolStructuredText = {
  readonly content: string;
  readonly truncated: boolean;
};

/** Text for script callers: the head of a result, cut on a character boundary at the limit. */
export function boundWebToolStructuredText(text: string): WebToolStructuredText {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= WEB_TOOL_STRUCTURED_MAX_BYTES) return { content: text, truncated: false };
  let end = WEB_TOOL_STRUCTURED_MAX_BYTES;
  // Back up over UTF-8 continuation bytes so a multi-byte character is never split.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return { content: bytes.toString("utf8", 0, end), truncated: true };
}

/** Runtime contract for exact complete-output metadata returned after Web Tool truncation. */
export const WebToolTruncationDetailsSchema = Type.Object(
  {
    outputLines: Type.Number(),
    totalLines: Type.Number(),
    outputBytes: Type.Number(),
    totalBytes: Type.Number(),
    fullOutputPath: Type.String(),
  },
  { additionalProperties: false },
);

/** Exact complete-output metadata returned when a Web Tool result is truncated. */
export type WebToolTruncationDetails = Static<typeof WebToolTruncationDetailsSchema>;

/** Model-visible Web Tool text plus optional metadata for its complete private spill. */
export type WebToolOutput = {
  readonly content: string;
  readonly truncation?: WebToolTruncationDetails;
};

async function removeTemporaryDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true }).catch(() => undefined);
}

/** Options for {@link createWebToolOutput}. */
export type WebToolOutputOptions = {
  /** One-line note that always stays visible after the text, and is not part of the spill. */
  readonly footer?: string | undefined;
};

/**
 * Apply Pi's output limits and save complete truncated text to a private temporary file. The
 * footer, when given, is reserved inside the limits so it is never cut off.
 */
export async function createWebToolOutput(
  text: string,
  options: WebToolOutputOptions = {},
): Promise<WebToolOutput> {
  const footer = options.footer;
  const footerText = footer === undefined ? "" : `\n\n${footer}`;
  const withFooter = `${text}${footerText}`;
  const initial = truncateHead(withFooter, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  if (!initial.truncated) return { content: withFooter };

  let directory: string | undefined;
  let fullOutputPath: string;
  try {
    directory = await mkdtemp(resolve(tmpdir(), "pi-web-tools-"));
    await chmod(directory, 0o700);
    fullOutputPath = resolve(directory, "output.txt");
    await withFileMutationQueue(fullOutputPath, async () => {
      await writeFile(fullOutputPath, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    });
  } catch (cause) {
    if (directory !== undefined) await removeTemporaryDirectory(directory);
    throw new Error("Unable to save complete Web Tool output", { cause });
  }

  const largestNotice = `[Output truncated: showing ${initial.totalLines} of ${initial.totalLines} lines (${initial.totalBytes} of ${initial.totalBytes} bytes). Full output saved to: ${fullOutputPath}]`;
  const visibleBytes =
    DEFAULT_MAX_BYTES - Buffer.byteLength(largestNotice) - 2 - Buffer.byteLength(footerText);
  if (visibleBytes < 0) {
    await removeTemporaryDirectory(directory);
    throw new Error("Web Tool truncation notice exceeds Pi output limit");
  }
  const visible = truncateHead(text, {
    maxBytes: visibleBytes,
    maxLines: DEFAULT_MAX_LINES - TRUNCATION_NOTICE_LINES - footerText.split("\n").length + 1,
  });
  const truncation: WebToolTruncationDetails = {
    outputLines: visible.outputLines,
    totalLines: visible.totalLines,
    outputBytes: visible.outputBytes,
    totalBytes: visible.totalBytes,
    fullOutputPath,
  };
  const notice = `[Output truncated: showing ${visible.outputLines} of ${visible.totalLines} lines (${visible.outputBytes} of ${visible.totalBytes} bytes). Full output saved to: ${fullOutputPath}]`;
  return {
    content: `${visible.content.length === 0 ? notice : `${visible.content}\n\n${notice}`}${footerText}`,
    truncation,
  };
}
