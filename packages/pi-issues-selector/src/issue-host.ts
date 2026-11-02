import { GITHUB } from "./github-host.js";
import { GITLAB } from "./gitlab-host.js";
import type { HostedRepository, RunCommand } from "./issue-repository.js";

/**
 * A Reference Sigil an Issue Host may use: `#` for issues (and GitHub pull requests), `!` for
 * GitLab merge requests.
 */
export type Sigil = "#" | "!";

/** A hosting service's command-line tool, which the popup lists through and the notice names. */
export interface HostCli {
  name: string;
  command: string;
}

export interface IssueSummary {
  number: number;
  title: string;
  kind: "issue" | "pull request" | "merge request";
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

/** Where the CLIs' configured hosts come from: the environment and a way to read a file. */
export interface HostSources {
  environment: HostEnvironment;
  readText: ReadText;
}

/**
 * The adapter for one Issue Host: what the hosting service needs for Issue References. GitHub and
 * GitLab have one each in `HOSTS`; another Issue Host adds an adapter there.
 */
export interface IssueHost {
  /**
   * The Reference Sigils the service uses, in the order references are converted: `#` for issues
   * (GitHub pull requests included), and `!` for GitLab merge requests.
   */
  sigils: readonly Sigil[];
  /** The service's command-line tool. */
  cli: HostCli;
  /**
   * Regular-expression source for a repository written in prose before the sigil, such as
   * `owner/repo` in `owner/repo#12`. Capture groups are not allowed. `parseRepository` re-checks
   * what it matches.
   */
  qualifier: string;
  /** The host this adapter serves under a remote's host name, or undefined for other hosts. */
  canonicalHost(host: string): string | undefined;
  /**
   * The owner (namespace path) and repository (project) that `path`, the path of a remote URL
   * without `.git`, names on this service, or undefined when it is not one of its repositories.
   */
  parseRepository(path: string): { owner: string; repo: string } | undefined;
  /**
   * The hosts the service's CLI is signed in to or told to use, read offline from its own
   * configuration (key names only, never values): each lower-case host a remote may name, mapped
   * to the host its web pages use (itself, unless an SSH host stands for a web host). A missing or
   * unreadable file yields none. Hosts the adapter always serves (`canonicalHost`) need not be
   * listed.
   */
  configuredHosts(sources: HostSources): Promise<ReadonlyMap<string, string>>;
  /**
   * The web page of issue, pull request, or merge request `number` for `sigil`. Repositories
   * passed to this and to `listRecent` carry the host `canonicalHost` or `configuredHosts`
   * returned.
   */
  issueUrl(repository: HostedRepository, number: number | string, sigil: Sigil): string;
  /** The most recently updated items `sigil` stands for, newest first. */
  listRecent(
    repository: HostedRepository,
    sigil: Sigil,
    run: RunCommand,
    signal: AbortSignal,
  ): Promise<IssueListing>;
}

const HOSTS: readonly IssueHost[] = [GITHUB, GITLAB];

/**
 * Whether `path` is a repository path an Issue Host accepts on `host`: when an adapter serves
 * `host` as a built-in, that adapter must accept it; for any other host, which only the CLIs'
 * configured hosts can classify, an adapter's accepting it is enough.
 */
export function acceptsRepository(host: string, path: string): boolean {
  const builtIn = HOSTS.filter((adapter) => adapter.canonicalHost(host) !== undefined);
  return (builtIn.length > 0 ? builtIn : HOSTS).some(
    (adapter) => adapter.parseRepository(path) !== undefined,
  );
}

/** An adapter and the host its URLs use for a remote. */
export interface ServingHost {
  adapter: IssueHost;
  host: string;
}

/** What serves a qualified `owner/repo#123` when the checkout has no remotes at all. */
export const DEFAULT_ISSUE_HOST: ServingHost = {
  adapter: GITHUB,
  host: "github.com",
};

/** The hosts each adapter's CLI is configured for, by adapter. */
export type ConfiguredHosts = ReadonlyMap<IssueHost, ReadonlyMap<string, string>>;

/**
 * Reads every adapter's configured hosts, afresh on each call: signing in to a host mid-session
 * takes effect on the next resolution.
 */
export async function readConfiguredHosts(sources: HostSources): Promise<ConfiguredHosts> {
  const entries = await Promise.all(
    HOSTS.map(async (adapter) => [adapter, await adapter.configuredHosts(sources)] as const),
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
): Promise<ServingHost | undefined> {
  const builtIn = HOSTS.flatMap((adapter) => {
    const canonical = adapter.canonicalHost(host);
    return canonical === undefined ? [] : [{ adapter, host: canonical }];
  });
  if (builtIn.length > 0) return builtIn.length === 1 ? builtIn[0] : undefined;
  const lower = host.toLowerCase();
  const claims = [...(await configured())].filter(([, hosts]) => hosts.has(lower));
  const [claim] = claims;
  const web = claim?.[1].get(lower);
  return claims.length === 1 && claim !== undefined && web !== undefined
    ? { adapter: claim[0], host: web }
    : undefined;
}
