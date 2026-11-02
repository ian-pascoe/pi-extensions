import type { ExecOptions, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseOwnerRepo } from "./github-host.js";
import {
  findIssueHost,
  readConfiguredHosts,
  type ConfiguredHosts,
  type HostSources,
  type IssueHost,
} from "./issue-host.js";

/**
 * A project on a hosting service: where a git remote points. `host` is lower-case, no port.
 * `owner` is the namespace path: for GitHub the one owner segment, for GitLab every segment before
 * the project (`group/sub` for `group/sub/project`), so `owner/repo` is always the full path.
 */
export interface HostedRepository {
  host: string;
  owner: string;
  repo: string;
}

/**
 * Where a git remote points before any Issue Host reads the path: a lower-case host without a port
 * and the path after it, without leading or trailing slashes or one trailing `.git`.
 */
export interface RemoteLocation {
  host: string;
  path: string;
}

/** Runs a program without a shell, as Pi's `exec` does. */
export type RunCommand = ExtensionAPI["exec"];

const hostPattern = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

function locationAt(host: string, path: string): RemoteLocation | undefined {
  const normalized = normalizePath(path);
  const lowerHost = host.toLowerCase();
  return normalized !== "" && hostPattern.test(lowerHost)
    ? { host: lowerHost, path: normalized }
    : undefined;
}

function normalizePath(path: string): string {
  return path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
}

/** The location a remote URL names: `https://`, `ssh://`, or `[user@]host:path`. */
export function parseRemoteUrl(url: string): RemoteLocation | undefined {
  const trimmed = url.trim();
  const scheme = /^(?:https?|ssh):\/\/(?:[^@/]*@)?([^/:@]+)(?::\d+)?\/(.*)$/i.exec(trimmed);
  if (scheme?.[1] !== undefined && scheme[2] !== undefined) {
    return locationAt(scheme[1], scheme[2]);
  }
  if (trimmed.includes("://")) return undefined;
  const scp = /^(?:[^@/\s]+@)?([^/:@\s]+):(.*)$/.exec(trimmed);
  if (scp?.[1] !== undefined && scp[2] !== undefined) return locationAt(scp[1], scp[2]);
  return undefined;
}

interface RemoteConfig {
  name: string;
  urls: string[];
  ghResolved: string | undefined;
  glabResolvedBase: string | undefined;
  glabResolvedLegacy: string | undefined;
}

/** What `git config --get-regexp` is asked for: remote URLs and the `gh` and `glab` markers. */
const REMOTE_CONFIG_PATTERN = "^remote\\..*\\.(url|gh-resolved|glab-resolved-base|glab-resolved)$";

const REMOTE_KEYS = /^remote\.(.+)\.(url|gh-resolved|glab-resolved-base|glab-resolved) (.*)$/;

function readRemotes(configOutput: string): RemoteConfig[] {
  const remotes = new Map<string, RemoteConfig>();
  for (const line of configOutput.split("\n")) {
    const entry = REMOTE_KEYS.exec(line.trimEnd());
    if (entry?.[1] === undefined || entry[3] === undefined) continue;
    let remote = remotes.get(entry[1]);
    if (remote === undefined) {
      remote = {
        name: entry[1],
        urls: [],
        ghResolved: undefined,
        glabResolvedBase: undefined,
        glabResolvedLegacy: undefined,
      };
      remotes.set(entry[1], remote);
    }
    if (entry[2] === "url") remote.urls.push(entry[3]);
    else if (entry[2] === "gh-resolved") remote.ghResolved ??= entry[3];
    else if (entry[2] === "glab-resolved-base") remote.glabResolvedBase ??= entry[3];
    else remote.glabResolvedLegacy ??= entry[3];
  }
  return [...remotes.values()];
}

function locationOf(remote: RemoteConfig): RemoteLocation | undefined {
  for (const url of remote.urls) {
    const parsed = parseRemoteUrl(url);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

interface LocatedRemote {
  remote: RemoteConfig;
  location: RemoteLocation;
}

// gh's value is `base` or `owner/repo` on the remote's host.
function ghResolvedLocation({ remote, location }: LocatedRemote): RemoteLocation | undefined {
  if (remote.ghResolved === undefined) return undefined;
  const path = normalizePath(remote.ghResolved);
  return {
    host: location.host,
    path: parseOwnerRepo(path) === undefined ? location.path : path,
  };
}

// glab's value is `base`, `base:<path>` on the remote's host, or a `head` value that marks nothing.
// The legacy key counts only for a remote that has no `glab-resolved-base` at all.
function glabResolvedLocation({ remote, location }: LocatedRemote): RemoteLocation | undefined {
  const value = remote.glabResolvedBase ?? remote.glabResolvedLegacy;
  if (value === "base") return location;
  if (value?.startsWith("base:") !== true) return undefined;
  const path = normalizePath(value.slice("base:".length));
  return { host: location.host, path: path === "" ? location.path : path };
}

/**
 * Where a bare `#123` or `!123` resolves, chosen from `git config --get-regexp
 * '^remote\..*\.(url|gh-resolved|glab-resolved-base|glab-resolved)$'` output, the way `gh` and
 * `glab` choose their base repository: the remote `gh` resolved (`gh-resolved` is `base`, or
 * `owner/repo` on that remote's host); else the remote `glab` resolved (`glab-resolved-base` is
 * `base`, or `base:<path>` on that remote's host; the legacy `glab-resolved` is read only for a
 * remote without the newer key; `head` values mark nothing); else `upstream`, `github`, `origin`,
 * `gitlab`; else the first remote whose URL parses. glab itself ranks `gitlab` above `origin`, so a
 * GitLab-only checkout with both and no `upstream` picks `origin` here.
 */
export function selectIssueRepository(configOutput: string): RemoteLocation | undefined {
  const remotes = readRemotes(configOutput).flatMap((remote) => {
    const location = locationOf(remote);
    return location === undefined ? [] : [{ remote, location }];
  });
  for (const resolve of [ghResolvedLocation, glabResolvedLocation]) {
    for (const located of remotes) {
      const resolved = resolve(located);
      if (resolved !== undefined) return resolved;
    }
  }
  for (const name of ["upstream", "github", "origin", "gitlab"]) {
    const preferred = remotes.find(({ remote }) => remote.name === name);
    if (preferred !== undefined) return preferred.location;
  }
  return remotes[0]?.location;
}

/**
 * What the git remotes say about the Issue Repository: `none` when there are no remotes to ask
 * (outside a checkout, or a checkout without any), `unresolved` when remotes exist but the
 * selected one names no repository on a host name an Issue Host serves (a local path, `file://`,
 * a path its Issue Host does not accept, an unrecognised host), else the one chosen with the
 * adapter serving it and the host its URLs use. Another remote is never chosen in place of an
 * unrecognised one.
 */
export type IssueRepositoryLookup =
  | { kind: "none" }
  | { kind: "unresolved" }
  | {
      kind: "found";
      repository: HostedRepository;
      adapter: IssueHost;
      host: string;
    };

export async function lookupIssueRepository(
  configOutput: string,
  configured: () => Promise<ConfiguredHosts>,
): Promise<IssueRepositoryLookup> {
  const location = selectIssueRepository(configOutput);
  if (location === undefined) {
    return readRemotes(configOutput).length > 0 ? { kind: "unresolved" } : { kind: "none" };
  }
  const served = await findIssueHost(location.host, configured);
  const named = served?.adapter.parseRepository(location.path);
  return served === undefined || named === undefined
    ? { kind: "unresolved" }
    : {
        kind: "found",
        repository: { host: location.host, ...named },
        adapter: served.adapter,
        host: served.host,
      };
}

/** The Issue Repository of the git checkout at `cwd`; `none` when git cannot say. */
export async function resolveIssueRepository(
  run: RunCommand,
  cwd: string,
  sources: HostSources,
  signal?: AbortSignal,
): Promise<IssueRepositoryLookup> {
  const options: ExecOptions = { cwd, timeout: 5_000 };
  if (signal !== undefined) options.signal = signal;
  try {
    const result = await run("git", ["config", "--get-regexp", REMOTE_CONFIG_PATTERN], options);
    return result.code === 0
      ? await lookupIssueRepository(result.stdout, () => readConfiguredHosts(sources))
      : { kind: "none" };
  } catch {
    return { kind: "none" };
  }
}
