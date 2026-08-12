import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  brvGitignore,
  brvGitignoreBeginMarker,
  brvGitignoreEndMarker,
  brvGitignoreRules,
} from "./config.js";

const hasCode = (error: unknown, code: string) => {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
};

const escapeRegExp = (value: string) => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

const managedGitignoreRules = new Set(
  brvGitignoreRules.split("\n").filter((line) => line.length > 0 && !line.startsWith("#")),
);

const managedGitignoreBlock = new RegExp(
  `(?:^|\\r?\\n)${escapeRegExp(brvGitignoreBeginMarker)}[\\s\\S]*?${escapeRegExp(
    brvGitignoreEndMarker,
  )}\\r?\\n?`,
  "gu",
);

export const normalizeBrvGitignore = (existing: string) => {
  const output: Array<string> = [];
  let insertedManagedBlock = false;
  let skippingManagedBlock = false;

  const insertManagedBlock = () => {
    if (insertedManagedBlock) return;
    if (output.length > 0 && output[output.length - 1] !== "") output.push("");
    output.push(...brvGitignore.trimEnd().split("\n"));
    insertedManagedBlock = true;
  };

  for (const line of existing
    .replace(managedGitignoreBlock, (match) => {
      const separator = match.startsWith("\r\n") ? "\r\n" : match.startsWith("\n") ? "\n" : "";
      return `${separator}${brvGitignore}`;
    })
    .split(/\r?\n/)) {
    if (line === brvGitignoreBeginMarker) {
      insertManagedBlock();
      skippingManagedBlock = true;
      continue;
    }
    if (skippingManagedBlock) {
      if (line === brvGitignoreEndMarker) skippingManagedBlock = false;
      continue;
    }
    if (line === "# ByteRover generated files" || managedGitignoreRules.has(line)) {
      insertManagedBlock();
      continue;
    }
    output.push(line);
  }

  while (output.length > 0 && output[output.length - 1] === "") output.pop();
  if (!insertedManagedBlock) insertManagedBlock();

  return `${output.join("\n")}\n`;
};

export const ensureBrvGitignore = async (cwd: string) => {
  await access(cwd);
  await mkdir(join(cwd, ".brv"), { recursive: true });

  const gitignorePath = join(cwd, ".brv", ".gitignore");

  try {
    const existing = await readFile(gitignorePath, "utf8");
    const normalized = normalizeBrvGitignore(existing);
    if (existing === normalized) return;
    await writeFile(gitignorePath, normalized, "utf8");
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    await writeFile(gitignorePath, brvGitignore, "utf8");
  }
};
