import { posix, win32 } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { isMap, isScalar, parseDocument } from "yaml";
import type { HostEnvironment, IssueHost, IssueSummary } from "./issue-host.js";

/** Letters, digits, and single hyphens, not starting or ending with one. */
const OWNER_PATTERN = "[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9]))*";
/** Letters, digits, `.`, `_`, and `-`. */
const REPO_PATTERN = "[A-Za-z0-9._-]+";

const ownerPattern = new RegExp(`^${OWNER_PATTERN}$`);
const repoPattern = new RegExp(`^${REPO_PATTERN}$`);

/** The owner and repository of exactly `owner/repo`, or undefined for any other text. */
export function parseOwnerRepo(text: string): { owner: string; repo: string } | undefined {
  const [owner, repo, ...rest] = text.split("/");
  if (rest.length > 0 || owner === undefined || repo === undefined) return undefined;
  if (!ownerPattern.test(owner) || !repoPattern.test(repo) || repo === "." || repo === "..") {
    return undefined;
  }
  return { owner, repo };
}

function canonicalGitHubHost(host: string): string | undefined {
  const lower = host.toLowerCase();
  if (lower === "github.com" || lower === "ssh.github.com") return "github.com";
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ghe\.com$/.test(lower) ? lower : undefined;
}

/**
 * The path of `gh`'s `hosts.yml`. The directory is chosen as `gh` chooses it: the first of
 * `GH_CONFIG_DIR`, `$XDG_CONFIG_HOME/gh`, on Windows `%APPDATA%\GitHub CLI`, and `~/.config/gh`
 * that is set and non-empty.
 */
function hostsFilePath({ env, platform, homedir }: HostEnvironment): string {
  const { join } = platform === "win32" ? win32 : posix;
  const configDir = env["GH_CONFIG_DIR"];
  if (configDir) return join(configDir, "hosts.yml");
  const xdg = env["XDG_CONFIG_HOME"];
  if (xdg) return join(xdg, "gh", "hosts.yml");
  const appData = env["APPDATA"];
  if (platform === "win32" && appData) return join(appData, "GitHub CLI", "hosts.yml");
  return join(homedir, ".config", "gh", "hosts.yml");
}

/** The top-level keys of a `hosts.yml`, which are host names. Values may hold tokens, so are never read. */
function hostKeys(text: string): string[] {
  const document = parseDocument(text, { logLevel: "silent" });
  if (document.errors.length > 0 || !isMap(document.contents)) return [];
  return document.contents.items.flatMap(({ key }) => (isScalar(key) ? [String(key.value)] : []));
}

// The parts of an item of GitHub's issues listing that the popup reads. A pull request also has a
// `pull_request` object, and `merged_at` is set once it is merged.
const GitHubItem = Type.Object({
  number: Type.Integer(),
  title: Type.String(),
  state: Type.Union([Type.Literal("open"), Type.Literal("closed")]),
  draft: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  pull_request: Type.Optional(
    Type.Object({
      merged_at: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    }),
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
  sigils: ["#"],
  cli: { name: "GitHub CLI", command: "gh" },
  qualifier: `${OWNER_PATTERN}/${REPO_PATTERN}`,
  canonicalHost: canonicalGitHubHost,
  parseRepository: parseOwnerRepo,
  async configuredHosts({ environment, readText }) {
    const hosts = new Map<string, string>();
    const add = (host: string): void => {
      const lower = host.toLowerCase();
      hosts.set(lower, lower);
    };
    const host = environment.env["GH_HOST"];
    if (host) add(host);
    try {
      const text = await readText(hostsFilePath(environment));
      if (text !== undefined) for (const key of hostKeys(text)) add(key);
    } catch {
      // No readable configuration, so nothing is configured.
    }
    return hosts;
  },
  issueUrl: (repository, number) =>
    `https://${repository.host}/${repository.owner}/${repository.repo}/issues/${number}`,
  async listRecent(repository, _sigil, run, signal) {
    const path = `repos/${repository.owner}/${repository.repo}/issues?state=all&sort=updated&per_page=100`;
    try {
      const result = await run("gh", ["api", "--hostname", repository.host, path], {
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
