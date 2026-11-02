import { posix, win32 } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { isMap, isScalar, parseDocument } from "yaml";
import { listRecentThroughCli, readConfiguredHostsSafely } from "./host-cli.js";
import type { HostEnvironment, IssueHost, IssueSummary } from "./issue-host.js";

// GitLab's project path grammar (`lib/gitlab/path_regex.rb`): a segment starts with a letter, digit,
// `_`, or `.`, continues with those and `-` up to 255 characters, is not `.` or `..`, and does not
// end in `.git` or `.atom`. A project sits at most 20 groups deep.
const SEGMENT = /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,254}$/;
const MIN_SEGMENTS = 2;
const MAX_SEGMENTS = 21;

function parseGitLabRepository(path: string): { owner: string; repo: string } | undefined {
  const segments = path.split("/");
  if (segments.length < MIN_SEGMENTS || segments.length > MAX_SEGMENTS) return undefined;
  for (const segment of segments) {
    if (!SEGMENT.test(segment) || segment === "." || segment === "..") return undefined;
    if (segment.endsWith(".git") || segment.endsWith(".atom")) return undefined;
  }
  return {
    owner: segments.slice(0, -1).join("/"),
    repo: segments.at(-1) ?? "",
  };
}

// A path written in prose: no leading or trailing `.` in a segment, so that sentence punctuation
// is not swallowed. `parseRepository` checks the rest.
const QSEG = "[A-Za-z0-9_](?:[A-Za-z0-9_.-]{0,253}[A-Za-z0-9_-])?";

function canonicalGitLabHost(host: string): string | undefined {
  return host.toLowerCase() === "gitlab.com" ? "gitlab.com" : undefined;
}

/**
 * The path of `glab`'s `config.yml`. `GLAB_CONFIG_DIR`, when non-empty, is the only place `glab`
 * looks. Otherwise it uses the first existing of the legacy `~/.config/glab-cli` and
 * `<base>/glab-cli`, where `<base>` is `$XDG_CONFIG_HOME`, else `~/Library/Application Support`
 * (macOS), `%LOCALAPPDATA%` (Windows), or `~/.config`. Candidates, in order of preference.
 */
function configFileCandidates({ env, platform, homedir }: HostEnvironment): string[] {
  const { join } = platform === "win32" ? win32 : posix;
  const configDir = env["GLAB_CONFIG_DIR"];
  if (configDir) return [join(configDir, "config.yml")];
  const xdg = env["XDG_CONFIG_HOME"];
  const localAppData = env["LOCALAPPDATA"];
  let base: string;
  if (xdg) base = xdg;
  else if (platform === "darwin") base = join(homedir, "Library", "Application Support");
  else if (platform === "win32") base = localAppData || join(homedir, "AppData", "Local");
  else base = join(homedir, ".config");
  const legacy = join(homedir, ".config", "glab-cli", "config.yml");
  const current = join(base, "glab-cli", "config.yml");
  return legacy === current ? [legacy] : [legacy, current];
}

/**
 * The host names under `hosts:` of a `config.yml`, each with the web host its remotes use: itself,
 * and for a host with an `ssh_host`, that SSH host name too. The file holds plaintext tokens, so
 * nothing but key names and `ssh_host` strings is read.
 */
function readHosts(text: string): Map<string, string> {
  const hosts = new Map<string, string>();
  const document = parseDocument(text, { logLevel: "silent" });
  if (document.errors.length > 0 || !isMap(document.contents)) return hosts;
  const section = document.contents.items.find(
    ({ key }) => isScalar(key) && key.value === "hosts",
  )?.value;
  if (!isMap(section)) return hosts;
  const aliases = new Map<string, string>();
  for (const { key, value } of section.items) {
    if (!isScalar(key)) continue;
    const host = String(key.value).toLowerCase();
    hosts.set(host, host);
    if (!isMap(value)) continue;
    const sshHost = value.get("ssh_host", true);
    const alias: unknown = isScalar(sshHost) ? sshHost.value : undefined;
    if (Value.Check(SshHost, alias)) aliases.set(alias.toLowerCase(), host);
  }
  // A host that is itself configured keeps its own name, whatever another host's ssh_host says.
  for (const [alias, host] of aliases) if (!hosts.has(alias)) hosts.set(alias, host);
  return hosts;
}

// A host's `ssh_host` setting, when it is text.
const SshHost = Type.String({ minLength: 1 });

// The parts of an item of GitLab's issue and merge request listings that the popup reads.
// `iid` is the number in the project; `id` is global. Issues are `opened` or `closed`; a merge
// request may also be `merged` or, briefly, `locked`.
const GitLabIssue = Type.Object({
  iid: Type.Integer(),
  title: Type.String(),
  state: Type.Union([Type.Literal("opened"), Type.Literal("closed")]),
});
const GitLabMergeRequest = Type.Object({
  iid: Type.Integer(),
  title: Type.String(),
  state: Type.Union([
    Type.Literal("opened"),
    Type.Literal("closed"),
    Type.Literal("merged"),
    Type.Literal("locked"),
  ]),
  draft: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
});

function summarizeIssue(item: Static<typeof GitLabIssue>): IssueSummary {
  return {
    number: item.iid,
    title: item.title,
    kind: "issue",
    state: item.state === "opened" ? "open" : "closed",
  };
}

function summarizeMergeRequest(item: Static<typeof GitLabMergeRequest>): IssueSummary {
  const { iid: number, title, state, draft } = item;
  const kind = "merge request";
  if (state === "merged" || state === "closed") return { number, title, kind, state };
  return {
    number,
    title,
    kind,
    state: state === "opened" && draft === true ? "draft" : "open",
  };
}

// `glab api` sends the request unauthenticated when signed out, so a private project answers 404:
// that, a 401, a missing `glab` (no output at all), and a sign-in hint all ask for the CLI.
function needsGitLabCli({ stdout, stderr }: { stdout: string; stderr: string }): boolean {
  if (stdout.trim() === "" && stderr.trim() === "") return true;
  return (
    /glab auth login/i.test(stderr) ||
    /^glab: (?:401\b|HTTP 401\b)|unauthorized/im.test(stderr) ||
    /^glab: (?:404\b|HTTP 404\b)/m.test(stderr)
  );
}

export const GITLAB: IssueHost = {
  sigils: ["#", "!"],
  cli: { name: "GitLab CLI", command: "glab" },
  qualifier: `${QSEG}(?:/${QSEG}){1,20}`,
  canonicalHost: canonicalGitLabHost,
  parseRepository: parseGitLabRepository,
  configuredHosts({ environment, readText }) {
    return readConfiguredHostsSafely(async () => {
      for (const path of configFileCandidates(environment)) {
        const text = await readText(path);
        if (text !== undefined) return readHosts(text);
      }
      return new Map();
    });
  },
  issueUrl: (repository, number, sigil) =>
    `https://${repository.host}/${repository.owner}/${repository.repo}/-/${sigil === "!" ? "merge_requests" : "issues"}/${number}`,
  listRecent(repository, sigil, run, signal) {
    const project = encodeURIComponent(`${repository.owner}/${repository.repo}`);
    const resource = sigil === "!" ? "merge_requests" : "issues";
    const path = `projects/${project}/${resource}?state=all&order_by=updated_at&sort=desc&per_page=100`;
    const request = {
      cli: GITLAB.cli,
      args: ["api", "--hostname", repository.host, path],
      run,
      signal,
      needsCli: needsGitLabCli,
    };
    return sigil === "!"
      ? listRecentThroughCli({
          ...request,
          schema: GitLabMergeRequest,
          summarize: summarizeMergeRequest,
        })
      : listRecentThroughCli({ ...request, schema: GitLabIssue, summarize: summarizeIssue });
  },
};
