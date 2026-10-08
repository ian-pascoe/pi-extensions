import { describe, expect, it } from "vitest";
import { formatWorktreeSnapshot, parseWorktreeSnapshot } from "../src/worktree-snapshot.js";

const theme = { fg: (color: string, text: string) => `<${color}>${text}` };

describe("Worktree Snapshot", () => {
  it("counts ahead, behind, conflicted, untracked, and modified entries", () => {
    const porcelain = [
      "# branch.oid 0123",
      "# branch.head main",
      "# branch.ab +2 -1",
      "1 .M N... 100644 100644 100644 a b src/a.ts",
      "2 R. N... 100644 100644 100644 a b R100 src/b.ts\tsrc/c.ts",
      "u UU N... 100644 100644 100644 100644 a b c src/d.ts",
      "? notes.md",
      "? scratch.ts",
      "",
    ].join("\n");
    expect(parseWorktreeSnapshot(porcelain)).toEqual({
      ahead: 2,
      behind: 1,
      conflicted: 1,
      untracked: 2,
      modified: 2,
    });
  });

  it("formats every count with plain Unicode symbols", () => {
    const snapshot = { ahead: 1, behind: 2, conflicted: 3, untracked: 4, modified: 5 };
    expect(formatWorktreeSnapshot(snapshot, theme)).toBe(
      "<accent>⇡1<dim> · <warning>⇣2<dim> · <error>!3<dim> · <mdLink>?4<dim> · <warning>~5",
    );
  });

  it("marks a clean worktree", () => {
    const clean = parseWorktreeSnapshot("# branch.head main\n# branch.ab +0 -0\n");
    expect(formatWorktreeSnapshot(clean, theme)).toBe("<success>✓");
  });
});
