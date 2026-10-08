import type { Theme } from "@earendil-works/pi-coding-agent";

/** Counts derived from one `git status --porcelain=v2 --branch` query. */
export interface WorktreeSnapshot {
  ahead: number;
  behind: number;
  conflicted: number;
  untracked: number;
  modified: number;
}

export const WORKTREE_SNAPSHOT_GIT_ARGS = [
  "status",
  "--porcelain=v2",
  "--branch",
  "--untracked-files=normal",
];

export function parseWorktreeSnapshot(porcelain: string): WorktreeSnapshot {
  const snapshot = { ahead: 0, behind: 0, conflicted: 0, untracked: 0, modified: 0 };
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("# branch.ab ")) {
      const match = line.match(/\+(\d+) -(\d+)/);
      snapshot.ahead = Number(match?.[1] ?? 0);
      snapshot.behind = Number(match?.[2] ?? 0);
    } else if (line.startsWith("u ")) {
      snapshot.conflicted += 1;
    } else if (line.startsWith("? ")) {
      snapshot.untracked += 1;
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      snapshot.modified += 1;
    }
  }
  return snapshot;
}

const ICONS = { conflicted: "!", modified: "~", clean: "✓" };

/** Format a Worktree Snapshot as colored Deck Header tokens. */
export function formatWorktreeSnapshot(
  snapshot: WorktreeSnapshot,
  theme: Pick<Theme, "fg">,
): string {
  const tokens: string[] = [];
  if (snapshot.ahead) tokens.push(theme.fg("accent", `⇡${snapshot.ahead}`));
  if (snapshot.behind) tokens.push(theme.fg("warning", `⇣${snapshot.behind}`));
  if (snapshot.conflicted)
    tokens.push(theme.fg("error", `${ICONS.conflicted}${snapshot.conflicted}`));
  if (snapshot.untracked) tokens.push(theme.fg("mdLink", `?${snapshot.untracked}`));
  if (snapshot.modified) tokens.push(theme.fg("warning", `${ICONS.modified}${snapshot.modified}`));
  if (tokens.length === 0) tokens.push(theme.fg("success", ICONS.clean));
  return tokens.join(theme.fg("dim", " · "));
}
