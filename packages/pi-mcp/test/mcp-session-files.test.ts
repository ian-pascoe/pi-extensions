import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  createMcpSessionFiles,
  MAX_MCP_SERVER_LOG_BYTES,
  RetainedMcpServerLog,
} from "../src/mcp-session-files.js";

test("retains the newest per-server stderr and log bytes", () => {
  const log = new RetainedMcpServerLog();

  log.append("a".repeat(MAX_MCP_SERVER_LOG_BYTES));
  log.append("tail");

  expect(log.read()).toBe(`${"a".repeat(MAX_MCP_SERVER_LOG_BYTES - 4)}tail`);
});

test("writes private Result Spills, binary content, and bounded per-server log tails", async () => {
  const sessionDirectory = await mkdtemp(join(tmpdir(), "pi-mcp-session-"));
  const files = await createMcpSessionFiles(sessionDirectory);
  try {
    const spillPath = await files.writeResultSpill("complete MCP output");
    const binaryPath = await files.writeUnsupportedContent(Buffer.from([0, 255, 7]), "audio/mpeg");
    await files.appendServerLog(
      "../../untrusted-server-name",
      "a".repeat(MAX_MCP_SERVER_LOG_BYTES),
    );
    await files.appendServerLog("../../untrusted-server-name", "tail");
    const logName = (await readdir(files.directoryPath)).find((name) =>
      name.startsWith("server-log-"),
    );
    if (logName === undefined) throw new Error("Expected private MCP Server log file");
    const logPath = join(files.directoryPath, logName);

    expect(await readFile(spillPath, "utf8")).toBe("complete MCP output");
    expect(await readFile(binaryPath)).toEqual(Buffer.from([0, 255, 7]));
    expect(await readFile(logPath, "utf8")).toBe(`${"a".repeat(MAX_MCP_SERVER_LOG_BYTES - 4)}tail`);
    expect(await files.readServerLog("../../untrusted-server-name")).toBe(
      `${"a".repeat(MAX_MCP_SERVER_LOG_BYTES - 4)}tail`,
    );
    expect((await stat(files.directoryPath)).mode & 0o777).toBe(0o700);
    expect((await stat(spillPath)).mode & 0o777).toBe(0o600);
    expect((await stat(binaryPath)).mode & 0o777).toBe(0o600);
    expect((await stat(logPath)).mode & 0o777).toBe(0o600);

    await files.close();
    await expect(stat(files.directoryPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(files.writeResultSpill("late output")).rejects.toThrow(
      "Pi MCP: session files are closed",
    );
  } finally {
    await files.close();
    await rm(sessionDirectory, { force: true, recursive: true });
  }
});
