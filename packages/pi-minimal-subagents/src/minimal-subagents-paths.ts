import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

/** Canonicalize one path, resolving symlinks only when the target exists. */
export function canonicalPath(path: string): string {
  const absolutePath = resolve(path);
  return existsSync(absolutePath) ? realpathSync(absolutePath) : absolutePath;
}
