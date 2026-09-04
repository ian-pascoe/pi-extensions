import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";

const TRUNCATION_NOTICE_LINES = 2;

/** Exact complete-output metadata returned when a Web Tool result is truncated. */
export type WebToolTruncationDetails = {
  readonly outputLines: number;
  readonly totalLines: number;
  readonly outputBytes: number;
  readonly totalBytes: number;
  readonly fullOutputPath: string;
};

/** A complete Web Tool result could not be saved after model-visible truncation. */
export class WebToolOutputError extends Error {
  readonly _tag = "WebToolOutputFailed" as const;
  readonly operation = "spillWebToolOutput" as const;

  constructor(cause: unknown) {
    super("Unable to save complete Web Tool output", { cause });
  }
}

/** Model-visible Web Tool text plus optional metadata for its complete private spill. */
export type WebToolOutput = {
  readonly content: string;
  readonly truncation?: WebToolTruncationDetails;
};

/** Bounded Web Tool output or an expected private-spill failure. */
export type WebToolOutputResult =
  | { readonly _tag: "ok"; readonly value: WebToolOutput }
  | { readonly _tag: "err"; readonly error: WebToolOutputError };

async function removeTemporaryDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true }).catch(() => undefined);
}

/** Apply Pi's output limits and save complete truncated text to a private temporary file. */
export async function createWebToolOutput(text: string): Promise<WebToolOutputResult> {
  const initial = truncateHead(text, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  if (!initial.truncated) return { _tag: "ok", value: { content: text } };

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
    return { _tag: "err", error: new WebToolOutputError(cause) };
  }

  const largestNotice = `[Output truncated: showing ${initial.totalLines} of ${initial.totalLines} lines (${initial.totalBytes} of ${initial.totalBytes} bytes). Full output saved to: ${fullOutputPath}]`;
  const visibleBytes = DEFAULT_MAX_BYTES - Buffer.byteLength(largestNotice) - 2;
  if (visibleBytes < 0) {
    await removeTemporaryDirectory(directory);
    return {
      _tag: "err",
      error: new WebToolOutputError(
        new Error("Web Tool truncation notice exceeds Pi output limit"),
      ),
    };
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
    _tag: "ok",
    value: {
      content: visible.content.length === 0 ? notice : `${visible.content}\n\n${notice}`,
      truncation,
    },
  };
}
