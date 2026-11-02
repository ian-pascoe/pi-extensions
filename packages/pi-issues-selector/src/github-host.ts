import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { IssueRepository, RunCommand } from "./issue-repository.js";

export interface IssueSummary {
  number: number;
  title: string;
  kind: "issue" | "pull request";
  state: "open" | "closed" | "draft" | "merged";
}

export type IssueListing =
  | { ok: true; issues: IssueSummary[] }
  | { ok: false; reason: "needs-cli" | "unavailable" };

/**
 * What one hosting service needs for Issue References. GitHub is the only one today; a future
 * provider adds an adapter here ([#509](https://github.com/ian-pascoe/pi-extensions/issues/509)).
 */
export interface IssueHost {
  /** The host this adapter serves under a remote's host name, or undefined for other hosts. */
  canonicalHost(host: string): string | undefined;
  /** The web page of issue or pull request `number`. */
  issueUrl(repository: IssueRepository, number: number | string): string;
  /** The most recently updated issues and pull requests, newest first. */
  listRecent(
    repository: IssueRepository,
    run: RunCommand,
    signal: AbortSignal,
  ): Promise<IssueListing>;
}

function canonicalGitHubHost(host: string): string | undefined {
  const lower = host.toLowerCase();
  if (lower === "github.com" || lower === "ssh.github.com") return "github.com";
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ghe\.com$/.test(lower) ? lower : undefined;
}

// The parts of an item of GitHub's issues listing that the popup reads. A pull request also has a
// `pull_request` object, and `merged_at` is set once it is merged.
const GitHubItem = Type.Object({
  number: Type.Integer(),
  title: Type.String(),
  state: Type.Union([Type.Literal("open"), Type.Literal("closed")]),
  draft: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  pull_request: Type.Optional(
    Type.Object({ merged_at: Type.Optional(Type.Union([Type.String(), Type.Null()])) }),
  ),
});

function summarize(item: Static<typeof GitHubItem>): IssueSummary {
  const { number, title, state, draft, pull_request: pullRequest } = item;
  if (pullRequest === undefined) return { number, title, kind: "issue", state };
  const merged = pullRequest.merged_at !== undefined && pullRequest.merged_at !== null;
  const pullRequestState = merged ? "merged" : state === "open" && draft === true ? "draft" : state;
  return { number, title, kind: "pull request", state: pullRequestState };
}

// `gh` exits 4 when it needs authentication, and prints nothing at all when it is not installed
// (Pi's exec reports a failed spawn as exit code 1 with no output).
function needsGitHubCli(code: number, stderr: string): boolean {
  return code === 4 || stderr.trim() === "" || /gh auth login|not logged in/i.test(stderr);
}

export const GITHUB: IssueHost = {
  canonicalHost: canonicalGitHubHost,
  issueUrl: (repository, number) =>
    `https://${canonicalGitHubHost(repository.host) ?? repository.host}/${repository.owner}/${repository.repo}/issues/${number}`,
  async listRecent(repository, run, signal) {
    const host = canonicalGitHubHost(repository.host) ?? repository.host;
    const path = `repos/${repository.owner}/${repository.repo}/issues?state=all&sort=updated&per_page=100`;
    try {
      const result = await run("gh", ["api", "--hostname", host, path], {
        signal,
        timeout: 20_000,
      });
      if (result.killed) return { ok: false, reason: "unavailable" };
      if (result.code !== 0) {
        const reason = needsGitHubCli(result.code, result.stderr) ? "needs-cli" : "unavailable";
        return { ok: false, reason };
      }
      const parsed: unknown = JSON.parse(result.stdout);
      if (!Array.isArray(parsed)) return { ok: false, reason: "unavailable" };
      const issues: IssueSummary[] = [];
      for (const item of parsed) if (Value.Check(GitHubItem, item)) issues.push(summarize(item));
      return { ok: true, issues };
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  },
};

const HOSTS: readonly IssueHost[] = [GITHUB];

/** The adapter serving a remote's host, with the canonical host its URLs use. */
export function findIssueHost(host: string): { adapter: IssueHost; host: string } | undefined {
  for (const adapter of HOSTS) {
    const canonical = adapter.canonicalHost(host);
    if (canonical !== undefined) return { adapter, host: canonical };
  }
  return undefined;
}
