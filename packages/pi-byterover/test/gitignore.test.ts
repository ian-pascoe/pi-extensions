import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { brvGitignore, brvGitignoreBeginMarker, brvGitignoreEndMarker } from "../src/config.js";
import { ensureBrvGitignore, normalizeBrvGitignore } from "../src/gitignore.js";

const execFileAsync = promisify(execFile);

const countOccurrences = (value: string, search: string) => value.split(search).length - 1;

const withTempDirectory = async (run: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-byterover-gitignore-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

describe("gitignore bootstrap", () => {
  test("creates the managed ByteRover gitignore when absent", async () => {
    await withTempDirectory(async (directory) => {
      await ensureBrvGitignore(directory);

      await expect(readFile(join(directory, ".brv", ".gitignore"), "utf8")).resolves.toBe(
        brvGitignore,
      );
    });
  });

  test("leaves an already-current managed gitignore unchanged", () => {
    expect(normalizeBrvGitignore(brvGitignore)).toBe(brvGitignore);
  });

  test("normalizes an old managed block while preserving custom rules", () => {
    const normalized = normalizeBrvGitignore(
      [
        "custom-before",
        brvGitignoreBeginMarker,
        "stale-generated-file",
        brvGitignoreEndMarker,
        "custom-after",
        "",
      ].join("\n"),
    );

    expect(normalized).toContain("custom-before");
    expect(normalized).toContain(brvGitignore.trimEnd());
    expect(normalized).toContain("custom-after");
    expect(normalized).not.toContain("stale-generated-file");
    expect(countOccurrences(normalized, brvGitignoreBeginMarker)).toBe(1);
    expect(countOccurrences(normalized, brvGitignoreEndMarker)).toBe(1);
  });

  test("converts a legacy generated-file rule block into the managed block", () => {
    const normalized = normalizeBrvGitignore(
      "custom-rule\n\n# ByteRover generated files\nconfig.json\n*.overview.md\n!config.json\n",
    );

    expect(normalized).toContain("custom-rule");
    expect(normalized).toContain(brvGitignore.trimEnd());
    expect(normalized).not.toContain("# ByteRover generated files");
    expect(countOccurrences(normalized, "config.json")).toBe(2);
    expect(countOccurrences(normalized, "*.overview.md")).toBe(1);
    expect(normalized.indexOf("custom-rule")).toBeLessThan(
      normalized.indexOf(brvGitignoreBeginMarker),
    );
    expect(normalized.indexOf("!config.json")).toBeGreaterThan(
      normalized.indexOf(brvGitignoreEndMarker),
    );
  });

  test("does not ignore ByteRover context tree source files", async () => {
    await withTempDirectory(async (directory) => {
      await execFileAsync("git", ["init"], { cwd: directory });
      await ensureBrvGitignore(directory);
      await mkdir(join(directory, ".brv", "context-tree", "facts"), { recursive: true });
      await writeFile(
        join(directory, ".brv", "context-tree", "facts", "generated.md"),
        "# Generated\n",
        "utf8",
      );

      await expect(
        execFileAsync("git", ["check-ignore", ".brv/context-tree/facts/generated.md"], {
          cwd: directory,
        }),
      ).rejects.toMatchObject({ code: 1 });
    });
  });
});
