import { posix, win32 } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { isMap, isScalar, parseDocument } from "yaml";
import type { HostedRepository, RunCommand } from "./issue-repository.js";

export interface IssueSummary {
  number: number;
  title: string;
  kind: "issue" | "pull request";
  state: "open" | "closed" | "draft" | "merged";
}

export type IssueListing =
  | { ok: true; issues: IssueSummary[] }
  | { ok: false; reason: "needs-cli" | "unavailable" };

/** What a host CLI's configuration depends on, injected so tests need no real files. */
export interface HostEnvironment {
  env: Readonly<Record<string, string | undefined>>;
  /** `process.platform`. */
  platform: string;
  homedir: string;
}

/** The text of the file at `path`, or undefined when it cannot be read. */
export type ReadText = (path: string) => Promise<string | undefined>;

/**
 * What one hosting service needs for Issue References. GitHub is the only one today; a future
 * provider adds an adapter here ([#509](https://github.com/ian-pascoe/pi-extensions/issues/509)).
 */
export interface IssueHost {
  /** The host this adapter serves under a remote's host name, or undefined for other hosts. */
  canonicalHost(host: string): string | undefined;
  /**
   * The lower-case hosts the service's CLI is signed in to or told to use, read offline from its
   * own configuration (key names only, never values). A missing or unreadable file yields none.
   * Hosts the adapter always serves (`canonicalHost`) need not be listed.
   */
  configuredHosts(environment: HostEnvironment, readText: ReadText): Promise<ReadonlySet<string>>;
  /**
   * The web page of issue or pull request `number`. Repositories passed to this and to
   * `listRecent` carry the host `canonicalHost` returned.
   */
  issueUrl(repository: HostedRepository, number: number | string): string;
  /** The most recently updated issues and pull requests, newest first. */
  listRecent(
    repository: HostedRepository,
    run: RunCommand,
    signal: AbortSignal,
  ): Promise<IssueListing>;
}

function canonicalGitHubHost(host: string): string | undefined {
  const lower = host.toLowerCase();
  if (lower === "github.com" || lower === "ssh.github.com") return "github.com";
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ghe\.com$/.test(lower) ? lower : undefined;
}

/** `gh`'s config directory, chosen as `gh` chooses it: the first of these that is set and non-empty. */
function ghConfigDirectory({ env, platform, homedir }: HostEnvironment): string {
  const { join } = platform === "win32" ? win32 : posix;
  const configDir = env["GH_CONFIG_DIR"];
  if (configDir) return configDir;
  const xdg = env["XDG_CONFIG_HOME"];
  if (xdg) return join(xdg, "gh");
  const appData = env["APPDATA"];
  if (platform === "win32" && appData) return join(appData, "GitHub CLI");
  return join(homedir, ".config", "gh");
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
  async configuredHosts(environment, readText) {
    const hosts = new Set<string>();
    const host = environment.env["GH_HOST"];
    if (host) hosts.add(host.toLowerCase());
    try {
      const text = await readText(
        (environment.platform === "win32" ? win32 : posix).join(
          ghConfigDirectory(environment),
          "hosts.yml",
        ),
      );
      if (text !== undefined) for (const key of hostKeys(text)) hosts.add(key.toLowerCase());
    } catch {
      // No readable configuration, so nothing is configured.
    }
    return hosts;
  },
  issueUrl: (repository, number) =>
    `https://${repository.host}/${repository.owner}/${repository.repo}/issues/${number}`,
  async listRecent(repository, run, signal) {
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

const HOSTS: readonly IssueHost[] = [GITHUB];

/** The hosts each adapter's CLI is configured for, by adapter. */
export type ConfiguredHosts = ReadonlyMap<IssueHost, ReadonlySet<string>>;

/**
 * Reads every adapter's configured hosts, afresh on each call: signing in to a host mid-session
 * takes effect on the next resolution.
 */
export async function readConfiguredHosts(
  environment: HostEnvironment,
  readText: ReadText,
): Promise<ConfiguredHosts> {
  const entries = await Promise.all(
    HOSTS.map(
      async (adapter) => [adapter, await adapter.configuredHosts(environment, readText)] as const,
    ),
  );
  return new Map(entries);
}

/**
 * The adapter serving a remote's host, with the host its URLs use. Built-in hosts are matched
 * first and never ask for `configured`. Any other host must be one an adapter's CLI is configured
 * for. A host claimed by more than one adapter is not served: no link beats a wrong link.
 */
export async function findIssueHost(
  host: string,
  configured: () => Promise<ConfiguredHosts>,
): Promise<{ adapter: IssueHost; host: string } | undefined> {
  const builtIn = HOSTS.flatMap((adapter) => {
    const canonical = adapter.canonicalHost(host);
    return canonical === undefined ? [] : [{ adapter, host: canonical }];
  });
  if (builtIn.length > 0) return builtIn.length === 1 ? builtIn[0] : undefined;
  const lower = host.toLowerCase();
  const claims = [...(await configured())].filter(([, hosts]) => hosts.has(lower));
  const [claim] = claims;
  return claims.length === 1 && claim !== undefined
    ? { adapter: claim[0], host: lower }
    : undefined;
}
