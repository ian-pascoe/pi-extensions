import type { ExecOptions, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  findIssueHost,
  readConfiguredHosts,
  type ConfiguredHosts,
  type HostEnvironment,
  type IssueHost,
  type ReadText,
} from "./github-host.js";

/** A repository on a hosting service: where a git remote points. `host` is lower-case, no port. */
export interface HostedRepository {
  host: string;
  owner: string;
  repo: string;
}

/** Runs a program without a shell, as Pi's `exec` does. */
export type RunCommand = ExtensionAPI["exec"];

/** Letters, digits, and single hyphens, not starting or ending with one. */
export const OWNER_PATTERN = "[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9]))*";
/** Letters, digits, `.`, `_`, and `-`. */
export const REPO_PATTERN = "[A-Za-z0-9._-]+";

const ownerPattern = new RegExp(`^${OWNER_PATTERN}$`);
const repoPattern = new RegExp(`^${REPO_PATTERN}$`);
const hostPattern = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

/** The owner and repository of exactly `owner/repo`, or undefined for any other text. */
export function parseOwnerRepo(text: string): { owner: string; repo: string } | undefined {
  const [owner, repo, ...rest] = text.split("/");
  if (rest.length > 0 || owner === undefined || repo === undefined) return undefined;
  if (!ownerPattern.test(owner) || !repoPattern.test(repo) || repo === "." || repo === "..") {
    return undefined;
  }
  return { owner, repo };
}

function repositoryAt(host: string, path: string): HostedRepository | undefined {
  const named = parseOwnerRepo(
    path
      .replace(/^\/+/, "")
      .replace(/\/+$/, "")
      .replace(/\.git$/, ""),
  );
  const lowerHost = host.toLowerCase();
  return named !== undefined && hostPattern.test(lowerHost)
    ? { host: lowerHost, ...named }
    : undefined;
}

/** The hosted repository a remote URL names: `https://`, `ssh://`, or `[user@]host:owner/repo`. */
export function parseRemoteUrl(url: string): HostedRepository | undefined {
  const trimmed = url.trim();
  const scheme = /^(?:https?|ssh):\/\/(?:[^@/]*@)?([^/:@]+)(?::\d+)?\/(.*)$/i.exec(trimmed);
  if (scheme?.[1] !== undefined && scheme[2] !== undefined) {
    return repositoryAt(scheme[1], scheme[2]);
  }
  if (trimmed.includes("://")) return undefined;
  const scp = /^(?:[^@/\s]+@)?([^/:@\s]+):(.*)$/.exec(trimmed);
  if (scp?.[1] !== undefined && scp[2] !== undefined) return repositoryAt(scp[1], scp[2]);
  return undefined;
}

interface RemoteConfig {
  name: string;
  urls: string[];
  resolved: string | undefined;
}

function readRemotes(configOutput: string): RemoteConfig[] {
  const remotes = new Map<string, RemoteConfig>();
  for (const line of configOutput.split("\n")) {
    const entry = /^remote\.(.+)\.(url|gh-resolved) (.*)$/.exec(line.trimEnd());
    if (entry?.[1] === undefined || entry[3] === undefined) continue;
    let remote = remotes.get(entry[1]);
    if (remote === undefined) {
      remote = { name: entry[1], urls: [], resolved: undefined };
      remotes.set(entry[1], remote);
    }
    if (entry[2] === "url") remote.urls.push(entry[3]);
    else remote.resolved ??= entry[3];
  }
  return [...remotes.values()];
}

function repositoryOf(remote: RemoteConfig): HostedRepository | undefined {
  for (const url of remote.urls) {
    const parsed = parseRemoteUrl(url);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

/**
 * The repository a bare `#123` resolves against, chosen the way `gh` chooses its base repository
 * from `git config --get-regexp '^remote\..*\.(url|gh-resolved)$'` output: the remote `gh`
 * resolved (`gh-resolved` is `base`, or `owner/repo` on that remote's host); else `upstream`,
 * `github`, `origin`; else the first remote whose URL parses.
 */
export function selectIssueRepository(configOutput: string): HostedRepository | undefined {
  const remotes = readRemotes(configOutput).flatMap((remote) => {
    const repository = repositoryOf(remote);
    return repository === undefined ? [] : [{ remote, repository }];
  });
  const resolved = remotes.find(({ remote }) => remote.resolved !== undefined);
  if (resolved?.remote.resolved !== undefined) {
    const named = repositoryAt(resolved.repository.host, resolved.remote.resolved);
    return named ?? resolved.repository;
  }
  for (const name of ["upstream", "github", "origin"]) {
    const preferred = remotes.find(({ remote }) => remote.name === name);
    if (preferred !== undefined) return preferred.repository;
  }
  return remotes[0]?.repository;
}

/**
 * What the git remotes say about the Issue Repository: `none` when there are no remotes to ask
 * (outside a checkout, or a checkout without any), `unresolved` when remotes exist but the
 * selected one names no repository on an Issue Host (a local path, `file://`, a nested GitLab
 * group, an unrecognised host), else the one chosen with the adapter serving it and the host its
 * URLs use. Another remote is never chosen in place of an unrecognised one.
 */
export type IssueRepositoryLookup =
  | { kind: "none" }
  | { kind: "unresolved" }
  | { kind: "found"; repository: HostedRepository; adapter: IssueHost; host: string };

export async function lookupIssueRepository(
  configOutput: string,
  configured: () => Promise<ConfiguredHosts>,
): Promise<IssueRepositoryLookup> {
  const repository = selectIssueRepository(configOutput);
  if (repository === undefined) {
    return readRemotes(configOutput).length > 0 ? { kind: "unresolved" } : { kind: "none" };
  }
  const served = await findIssueHost(repository.host, configured);
  return served === undefined
    ? { kind: "unresolved" }
    : { kind: "found", repository, adapter: served.adapter, host: served.host };
}

/** Where the CLIs' configured hosts come from: the environment and a way to read a file. */
export interface HostSources {
  environment: HostEnvironment;
  readText: ReadText;
}

/** The Issue Repository of the git checkout at `cwd`; `none` when git cannot say. */
export async function resolveIssueRepository(
  run: RunCommand,
  cwd: string,
  { environment, readText }: HostSources,
  signal?: AbortSignal,
): Promise<IssueRepositoryLookup> {
  const options: ExecOptions = { cwd, timeout: 5_000 };
  if (signal !== undefined) options.signal = signal;
  try {
    const result = await run(
      "git",
      ["config", "--get-regexp", "^remote\\..*\\.(url|gh-resolved)$"],
      options,
    );
    return result.code === 0
      ? await lookupIssueRepository(result.stdout, () => readConfiguredHosts(environment, readText))
      : { kind: "none" };
  } catch {
    return { kind: "none" };
  }
}
