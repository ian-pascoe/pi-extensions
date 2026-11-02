# Pi Issues Selector

Reference GitHub issues and pull requests, or GitLab issues and merge requests,
with `#123` or `owner/repo#123` (GitLab also `!123`) anywhere in a user message.
Type `#` (or, on GitLab, `!`) to open Pi's native completion popup, then pick from
the repository's recent items, filter by number, or fuzzy-match a title. Selecting
one leaves `#123` or `!123` in the editor.

```bash
pi install npm:@ian-pascoe/pi-issues-selector
```

Requires Pi `>=1.1.0` and Node `>=22.19.0`. There are no settings or extra tools.
Prose Span detection and the completion popup stack come from
[`@ian-pascoe/pi-utils/prose-references`](../pi-utils/README.md#prose-references).

## Submission

Typed, pasted, and selected references are equivalent. On submission:

```text
Fix #123, as in acme/other#7.
→ Fix [#123](https://github.com/acme/widgets/issues/123), as in [acme/other#7](https://github.com/acme/other/issues/7).
```

The model receives links, not issue text, and chooses whether to read them (`gh`
and `glab` read private items). On GitHub the link always ends in
`/issues/<number>`: an issue and a pull request of one repository share a number
sequence, and GitHub redirects `/issues/<number>` to `/pull/<number>` for a pull
request, so conversion needs no network lookup. The submitted transcript stores
the links rather than a separate raw message.

On GitLab, issues and merge requests are numbered separately in each project and
no URL redirects between them, so the sigil decides the link:

```text
Fix #12 and !3 in group/sub/project.
→ Fix [#12](https://gitlab.com/group/sub/project/-/issues/12) and [!3](https://gitlab.com/group/sub/project/-/merge_requests/3) in group/sub/project.
```

`#12` links `/-/issues/12`, `!3` links `/-/merge_requests/3`, and
`group/sub/project#12` or `group/sub/project!3` link the named project on the Issue
Repository's host. `!` is a reference only where the Issue Host has merge requests,
so on a GitHub checkout `!3` stays literal. `!=` and `!3x` are never references.

- **`#123`** (and GitLab's **`!123`**) resolves against the _Issue Repository_
  (below). Outside a Git repository, or when no Issue Host serves the selected
  remote's host name (below), it stays literal.
- **`owner/repo#123`** names its repository and uses the Issue Repository's host,
  or `github.com` when the checkout has no remotes at all (or is not a checkout).
  When remotes exist but no Issue Host serves the selected one's host name (a
  local path, a `file://` URL, an SSH host alias, a host `gh` or `glab` is not
  signed in to), it stays literal. The qualifier follows the Issue Host:
  - **GitHub:** exactly two segments. Owners are letters, digits, and single
    hyphens; repositories add `.` and `_`. A file path such as `docs/guide.md#12`
    looks the same, so put paths in code.
  - **GitLab:** 2 to 21 segments (`group/sub/project`) of letters, digits, `_`,
    `.`, and `-`, with no segment starting or ending in `.`, none ending in `.git`
    or `.atom`. A single-segment `project#12` is not supported. Path-like prose
    such as `src/foo#12` converts too, so put paths in code.
- Numbers are 1 to 10 digits with no leading zero. A token (the number, or
  `owner/repo` and its number) converts only at a boundary:
  - It is not preceded by a letter, digit, `_`, `#`, `/`, `+`, `-`, `&`, `.`, `:`,
    or `@`: so `issue#123`, `PR#1`, `##123`, `a-#1`, `&#123;`, `/acme/other#1`, and
    `@acme/other#1` stay literal, while a start of text, whitespace, or an opening
    bracket or quote lets it convert.
  - It is not followed by a letter, digit, `_`, `#`, `/`, `+`, or `-`, nor by a `.` and
    a letter, digit, or `_`: so `#1st`, `#123abc`, `#123.5`, `#12/3`, and `#12-3` stay
    literal, while `#123.`, `#123)`, `#123,`, `#123;`, and `#123: …` convert.
  - `0` and a leading zero (`#0`, `#0123`) are not numbers.

  A heading's `## Fix #123` and `my #1 priority` convert (as on GitHub). `\#123`,
  code, link text, existing Markdown links, and HTML blocks stay literal.

  **A message that starts with `!` runs as a bash command in Pi** (its bash mode),
  so an Issue Reference written with `!` at the very start never reaches the model
  as a reference: start with other text (`Review !3`).

### Issue Repository

Read fresh from
`git config --get-regexp '^remote\..*\.(url|gh-resolved|glab-resolved-base|glab-resolved)$'`
in the session directory on each submission that holds a candidate, choosing as `gh`
and `glab` do:

1. the remote `gh` resolved (`gh repo set-default`);
2. else the remote `glab` resolved: `remote.<name>.glab-resolved-base` is `base`
   (that remote) or `base:<path>` (that path on the remote's host). The legacy
   `glab-resolved` is read only for a remote without `glab-resolved-base`, and
   `head` values mark nothing;
3. else `upstream`, `github`, `origin`, `gitlab`;
4. else the first remote that counts.

A remote counts when its URL parses (`https://`, `git@host:`, `ssh://`) and the path
is one an Issue Host accepts: on a built-in host, that host's own grammar (so
`https://github.com/a/b/c`, a local path, or a `file://` URL is skipped, as it always
was); on any other host, either service's grammar. Two cases follow from that, both
on a host that is not built in (a GitHub Enterprise Server host, say) and both for a
path only GitLab's grammar accepts (such as `a/b/c`, `acme--x/widgets`, `_x/y`): a
remote URL with such a path counts, is selected, and then leaves the Issue
Repository unresolved; a `gh-resolved` value of that kind is used as the path, and
the result is unresolved too, where a value no grammar accepts (`base`) means the
remote itself.

If no Issue Host serves the chosen remote's host name, or its Issue Host does not
accept the path, the Issue Repository is unresolved and references stay literal;
another remote is never chosen in its place. `insteadOf` rewrites are not resolved.

`glab` itself ranks `gitlab` above `origin`; this order puts `origin` first, so a
GitLab-only checkout with both remotes, no `upstream`, and no `glab` marker
selects `origin` here where `glab` selects `gitlab`. A `glab-resolved-base` marker
(which `glab` writes once it has resolved the repository) decides either way.

### Issue Hosts

An _Issue Host_ is the hosting service serving a remote's host name: GitHub or
GitLab. It serves a host name that is:

- **Built in:** `github.com`, `ssh.github.com` (linked on `github.com`),
  GitHub Enterprise Cloud `*.ghe.com`, and `gitlab.com`. No configuration is read
  for these.
- **GitHub Enterprise Server:** any host that `gh` is signed in to, or that
  `GH_HOST` names. Sign in with `gh auth login --hostname <host>`. The host is
  recognised from the top-level keys of `gh`'s `hosts.yml` (a host stays listed
  there even when its token lives in the OS keyring), read afresh on each
  resolution, so signing in takes effect on the next message. Only key names are
  read, never tokens, and a missing or malformed file recognises nothing, without
  an error or notice. `gh auth status` is not used: it makes network calls.

`gh` finds its configuration directory from, in order: `GH_CONFIG_DIR`,
`$XDG_CONFIG_HOME/gh`, on Windows `%APPDATA%\GitHub CLI`, then `~/.config/gh`
(empty values count as unset). `GH_TOKEN` and `GITHUB_TOKEN` add only
`github.com`, which is built in; `GH_ENTERPRISE_TOKEN` adds no host, so use
`gh auth login --hostname <host>` or set `GH_HOST`. `GH_HOST` only adds a host: a
remote on any other recognised host still wins.

- **Self-managed GitLab:** any host that is a key under `hosts:` in `glab`'s
  `config.yml`; sign in with `glab auth login --hostname <host>`. A remote whose
  host equals a `hosts.<h>.ssh_host` value counts as host `<h>`, and its links use
  the web host `<h>`. Only key names and `ssh_host` strings are read, never the
  plaintext tokens the file may hold; a missing or malformed file recognises
  nothing, silently. Not counted: `glab`'s top-level `host` key, `GITLAB_HOST`,
  `GITLAB_URI`, `GL_HOST`, and the per-repository `<git-dir>/glab-cli/config.yml`.

`glab` finds its configuration directory from, in order: a non-empty
`GLAB_CONFIG_DIR` (and then nowhere else); else the first of these with a
`config.yml`: the legacy `~/.config/glab-cli`, then `<base>/glab-cli` where
`<base>` is a non-empty `$XDG_CONFIG_HOME`, else `~/Library/Application Support`
on macOS, `%LOCALAPPDATA%` on Windows (`~\AppData\Local` when that is unset or
empty), `~/.config` elsewhere.

Limits:

- Links always use `https` and never carry a port: `ssh://git@host:2222/…` and
  `https://host:8443/…` link as `https://host/…`.
- A GitLab instance served under a path prefix (`https://host/gitlab/…`) gets
  correct links but no popup: the project path then includes the prefix, so the
  listing request answers `404` (which may show the sign-in notice).
- An SSH host that differs from the web host stays literal unless `gh` lists it,
  or `glab` lists it as an `ssh_host`.
- SSH host aliases from `~/.ssh/config` stay literal.
- A host that more than one service claims (for example, listed by both `gh` and
  `glab`) is not recognised: no link is better than a wrong one.

Why the CLI's own host list, and not a Pi setting, is recorded in
[ADR 0001](https://github.com/ian-pascoe/pi-extensions/blob/main/packages/pi-issues-selector/docs/adr/0001-recognise-self-hosted-issue-hosts-from-the-cli.md).
Other Issue Hosts (Gitea, Forgejo, Bitbucket) are not supported.

## Completion popup

Interactive terminal sessions only. On the first `#` in a repository, one call to
the host's CLI lists its latest items, cached in memory for about five minutes (a
failed attempt for thirty seconds):

- **GitHub:** `gh api --hostname <host> 'repos/<owner>/<repo>/issues?state=all&sort=updated&per_page=100'`
- **GitLab `#`:** `glab api --hostname <host> 'projects/<url-encoded owner/repo>/issues?state=all&order_by=updated_at&sort=desc&per_page=100'`
- **GitLab `!`:** the same with `merge_requests` in place of `issues`, on the first
  `!`. The two listings are cached separately.

Then:

- `#` lists the 20 most recently updated items. On GitLab it lists issues only,
  and `!` lists merge requests only; on GitHub `!` opens nothing.
- `#12` filters by number prefix, the exact number first.
- `#login` fuzzy-matches titles. Every choice inserts `#<number>` (`!<number>`).

Each item reads `#123` with `issue · open · <title>` or `PR · merged · <title>` (a
pull request is open, draft, merged, or closed; an issue open or closed). On GitLab
a merge request reads `MR · open · <title>`: open (a locked merge request counts as
open), draft, merged, or closed. The popup lists only the latest 100 items; it does
not look up an older number (type it anyway; conversion does not need the list),
search the host, or complete `owner/repo#`. A lone `#` at the start of a line is a
Markdown heading marker, so the popup opens after the next character. `!=` never
opens the popup. When the message starts with `!` (bash mode in Pi), the `!` popup
steps aside for Pi's own completion.

Suggestions need the host's CLI signed in to the repository's host: the
[GitHub CLI](https://cli.github.com) (`gh`) or the
[GitLab CLI](https://gitlab.com/gitlab-org/cli) (`glab`), through
`--hostname <host>`. Once per session and host, when the CLI is missing or signed
out, Pi shows `Issue suggestions need the GitHub CLI (gh) signed in to <host>. Run
/skill:pi-issues-selector to diagnose.` (the GitLab CLI (glab) on GitLab hosts).
Network errors, rate limits, and repositories you cannot read show no suggestions
and no notice. Conversion never needs the CLI.

GitLab differs on one point: `glab api` sends unauthenticated requests when signed
out, so a private project answers `404`, and that is reported as the sign-in
notice. The same `404` can also mean the project disables issues or merge
requests, so the notice may fire for a project you are signed in to.

## Integration

Completion stacks over the current provider, retaining ordinary slash/file
completion, keyboard controls, and custom editors. Conversion applies to terminal,
RPC, and print `prompt` input, including steering and follow-ups, without changing
attachments or message routing. Extension-generated input is unchanged.

## Troubleshooting

- **No popup:** confirm the extension loaded, use an interactive terminal, and type
  `#` after a space. Check the repository has a remote whose host name an Issue Host serves, and `gh auth
  status` (or `glab auth status --hostname <host>`) lists its host. `/skill:pi-issues-selector` walks through it.
- **No link:** check the exact reference against the rules above, the remote's
  host (on GitHub Enterprise Server, `gh auth login --hostname <host>`; on self-managed GitLab, `glab auth login --hostname <host>`), and whether the text is escaped, in code, or already inside a link.
- **Wrong repository:** inspect `git remote -v` and `gh repo set-default --view`
  and the `glab-resolved-base` entries of `git config --list`; the selector picks the
  remote `gh` and `glab` resolved, else the name order `gh` uses (plus `gitlab`
  last).
