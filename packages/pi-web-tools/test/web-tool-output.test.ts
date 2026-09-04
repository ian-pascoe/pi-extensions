import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import { createWebToolOutput, type WebToolOutput } from "../src/web-tool-output.js";

const spillDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    spillDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function outputFor(text: string): Promise<WebToolOutput> {
  const result = await createWebToolOutput(text);
  if (result._tag === "err") throw result.error;
  return result.value;
}

async function recordSpill(result: WebToolOutput): Promise<string> {
  const path = result.truncation?.fullOutputPath;
  if (path === undefined) throw new Error("Expected Web Tool output spill");
  spillDirectories.push(dirname(path));
  return path;
}

describe("Web Tool output", () => {
  test("returns fitting text unchanged without creating a temporary directory", async () => {
    const isolatedTemporaryDirectory = await mkdtemp(resolve(tmpdir(), "pi-web-tools-test-"));
    spillDirectories.push(isolatedTemporaryDirectory);
    const previousTemporaryDirectory = process.env.TMPDIR;
    process.env.TMPDIR = isolatedTemporaryDirectory;
    try {
      const result = await outputFor("small result");

      expect(result).toEqual({ content: "small result" });
      expect(await readdir(isolatedTemporaryDirectory)).toEqual([]);
    } finally {
      if (previousTemporaryDirectory === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTemporaryDirectory;
    }
  });

  test("bounds byte-truncated content and saves the exact complete text privately", async () => {
    const complete = "😀".repeat(DEFAULT_MAX_BYTES);
    const result = await outputFor(complete);
    const path = await recordSpill(result);

    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    expect(result.content.split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
    expect(result.content).toContain(`Full output saved to: ${path}`);
    expect(result.truncation).toMatchObject({
      outputBytes: 0,
      outputLines: 0,
      totalBytes: Buffer.byteLength(complete),
      totalLines: 1,
      fullOutputPath: path,
    });
    expect(await readFile(path, "utf8")).toBe(complete);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
  });

  test("reserves notice space when the line limit truncates output", async () => {
    const complete = Array.from(
      { length: DEFAULT_MAX_LINES + 20 },
      (_, index) => `line ${index}`,
    ).join("\n");
    const result = await outputFor(complete);
    const path = await recordSpill(result);

    expect(result.content.split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    expect(result.truncation?.outputLines).toBe(DEFAULT_MAX_LINES - 2);
    expect(result.truncation?.totalLines).toBe(DEFAULT_MAX_LINES + 20);
    expect(result.content).toContain(
      `showing ${result.truncation?.outputLines} of ${result.truncation?.totalLines} lines`,
    );
    expect(await readFile(path, "utf8")).toBe(complete);
  });
});
