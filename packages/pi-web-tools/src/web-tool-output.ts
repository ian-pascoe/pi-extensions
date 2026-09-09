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

/** Apply Pi's output limits and save complete truncated text to a private temporary file. */
export async function createWebToolOutput(text: string): Promise<WebToolOutput> {
  const initial = truncateHead(text, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  if (!initial.truncated) return { content: text };

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
  const visibleBytes = DEFAULT_MAX_BYTES - Buffer.byteLength(largestNotice) - 2;
  if (visibleBytes < 0) {
    await removeTemporaryDirectory(directory);
    throw new Error("Web Tool truncation notice exceeds Pi output limit");
  }
  const visible = truncateHead(text, {
    maxBytes: visibleBytes,
    maxLines: DEFAULT_MAX_LINES - TRUNCATION_NOTICE_LINES,
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
    content: visible.content.length === 0 ? notice : `${visible.content}\n\n${notice}`,
    truncation,
  };
}
