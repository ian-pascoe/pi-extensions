import type { ExecResult } from "@earendil-works/pi-coding-agent";

/** A hosted repository as a git remote names it; `host` is lower-case and carries no port. */
export interface IssueRepository {
  host: string;
  owner: string;
  repo: string;
}

export interface CommandOptions {
  cwd?: string;
  signal?: AbortSignal;
  timeout?: number;
}

/** Runs a program without a shell, as Pi's `exec` does. */
export type RunCommand = (
  command: string,
  args: string[],
  options: CommandOptions,
) => Promise<ExecResult>;

/** Letters, digits, and single hyphens, not starting or ending with one. */
export const OWNER_PATTERN = "[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9]))*";
/** Letters, digits, `.`, `_`, and `-`. */
export const REPO_PATTERN = "[A-Za-z0-9._-]+";

const ownerPattern = new RegExp(`^${OWNER_PATTERN}$`);
const repoPattern = new RegExp(`^${REPO_PATTERN}$`);
const hostPattern = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

function repositoryAt(host: string, path: string): IssueRepository | undefined {
  const segments = path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/");
  const [owner, repo] = segments;
  if (segments.length !== 2 || owner === undefined || repo === undefined) return undefined;
  if (!ownerPattern.test(owner) || !repoPattern.test(repo) || repo === "." || repo === "..") {
    return undefined;
  }
  const lowerHost = host.toLowerCase();
  return hostPattern.test(lowerHost) ? { host: lowerHost, owner, repo } : undefined;
}

/** The hosted repository a remote URL names: `https://`, `ssh://`, or `[user@]host:owner/repo`. */
export function parseRemoteUrl(url: string): IssueRepository | undefined {
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

function repositoryOf(remote: RemoteConfig): IssueRepository | undefined {
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
export function selectIssueRepository(configOutput: string): IssueRepository | undefined {
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

/** The Issue Repository of the git checkout at `cwd`, or undefined outside one or without remotes. */
export async function resolveIssueRepository(
  run: RunCommand,
  cwd: string,
  signal?: AbortSignal,
): Promise<IssueRepository | undefined> {
  const options: CommandOptions = { cwd, timeout: 5_000 };
  if (signal !== undefined) options.signal = signal;
  try {
    const result = await run(
      "git",
      ["config", "--get-regexp", "^remote\\..*\\.(url|gh-resolved)$"],
      options,
    );
    return result.code === 0 ? selectIssueRepository(result.stdout) : undefined;
  } catch {
    return undefined;
  }
}
