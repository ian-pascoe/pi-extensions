import { GITHUB } from "./github-host.js";
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

/** Where the CLIs' configured hosts come from: the environment and a way to read a file. */
export interface HostSources {
  environment: HostEnvironment;
  readText: ReadText;
}

/**
 * The adapter for one Issue Host: what the hosting service needs for Issue References. GitHub is
 * the only one today; another Issue Host adds an adapter to `HOSTS`
 * ([#509](https://github.com/ian-pascoe/pi-extensions/issues/509)).
 */
export interface IssueHost {
  /** The host this adapter serves under a remote's host name, or undefined for other hosts. */
  canonicalHost(host: string): string | undefined;
  /**
   * The lower-case hosts the service's CLI is signed in to or told to use, read offline from its
   * own configuration (key names only, never values). A missing or unreadable file yields none.
   * Hosts the adapter always serves (`canonicalHost`) need not be listed.
   */
  configuredHosts(sources: HostSources): Promise<ReadonlySet<string>>;
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

const HOSTS: readonly IssueHost[] = [GITHUB];

/** The hosts each adapter's CLI is configured for, by adapter. */
export type ConfiguredHosts = ReadonlyMap<IssueHost, ReadonlySet<string>>;

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
