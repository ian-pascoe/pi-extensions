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

/** Where a Web Tool's text sits within the longer text it was selected from, in 1-indexed lines. */
export type WebToolLineWindow = {
  /** Line of the source text that the first line of the output text came from. */
  readonly firstLine: number;
  /** Line count of the whole source text. */
  readonly totalLines: number;
};

/** Options for {@link createWebToolOutput}. */
export type WebToolOutputOptions = {
  /**
   * Source position of the text. When lines of the source remain after what the model can see, the
   * output ends with a continuation note naming the `offset` to read next.
   */
  readonly window?: WebToolLineWindow | undefined;
};

/** Lines a continuation note adds: a blank line and the note itself. */
const CONTINUATION_NOTE_LINES = 2;

function continuationNote(window: WebToolLineWindow, shownLines: number): string {
  const lastLine = window.firstLine + shownLines - 1;
  const remaining = window.totalLines - lastLine;
  return `[Showing lines ${window.firstLine}-${lastLine} of ${window.totalLines}. ${remaining} ${remaining === 1 ? "line remains" : "lines remain"}. Use offset=${lastLine + 1} to continue.]`;
}

/** The continuation note after `shownLines` lines of the text, or nothing when no source line remains. */
function continuationSuffix(window: WebToolLineWindow | undefined, shownLines: number): string {
  if (window === undefined || shownLines === 0) return "";
  if (window.firstLine + shownLines - 1 >= window.totalLines) return "";
  return `\n\n${continuationNote(window, shownLines)}`;
}

/**
 * Apply Pi's output limits and save complete truncated text to a private temporary file. A
 * continuation note, when the window has lines left after the visible ones, is reserved inside the
 * limits and built from the lines actually shown, so it is never cut off or wrong; the spill holds
 * the text only.
 */
export async function createWebToolOutput(
  text: string,
  options: WebToolOutputOptions = {},
): Promise<WebToolOutput> {
  const window = options.window;
  const textLines = text.split("\n").length;
  // Every figure in a note for fewer shown lines is no longer than in this one.
  const largestSuffix = window === undefined ? "" : `\n\n${continuationNote(window, textLines)}`;
  const initial = truncateHead(`${text}${continuationSuffix(window, textLines)}`, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  if (!initial.truncated) return { content: initial.content };

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
    DEFAULT_MAX_BYTES - Buffer.byteLength(largestNotice) - 2 - Buffer.byteLength(largestSuffix);
  if (visibleBytes < 0) {
    await removeTemporaryDirectory(directory);
    throw new Error("Web Tool truncation notice exceeds Pi output limit");
  }
  const visible = truncateHead(text, {
    maxBytes: visibleBytes,
    maxLines:
      DEFAULT_MAX_LINES -
      TRUNCATION_NOTICE_LINES -
      (largestSuffix === "" ? 0 : CONTINUATION_NOTE_LINES),
  });
  const truncation: WebToolTruncationDetails = {
    outputLines: visible.outputLines,
    totalLines: visible.totalLines,
    outputBytes: visible.outputBytes,
    totalBytes: visible.totalBytes,
    fullOutputPath,
  };
  const notice = `[Output truncated: showing ${visible.outputLines} of ${visible.totalLines} lines (${visible.outputBytes} of ${visible.totalBytes} bytes). Full output saved to: ${fullOutputPath}]`;
  const shown = `${visible.content.length === 0 ? notice : `${visible.content}\n\n${notice}`}`;
  return {
    content: `${shown}${continuationSuffix(window, visible.outputLines)}`,
    truncation,
  };
}
