# Pi Issues Selector

Reference GitHub issues and pull requests with `#123` or `owner/repo#123` anywhere
in a user message. Type `#` to open Pi's native completion popup, then pick from
the repository's recent items, filter by number, or fuzzy-match a title. Selecting
one leaves `#123` in the editor.

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
reads private items). The link always ends in `/issues/<number>`: an issue and a
pull request of one repository share a number sequence, and GitHub redirects
`/issues/<number>` to `/pull/<number>` for a pull request, so conversion needs no
network lookup. The submitted transcript stores the links rather than a separate
raw message.

- **`#123`** resolves against the _Issue Repository_ (below). Outside a Git
  repository, or beside a remote on an unsupported host, it stays literal.
- **`owner/repo#123`** names its repository and uses the Issue Repository's host,
  or `github.com` outside a Git repository. Beside an unsupported remote it stays
  literal. Owners are letters, digits, and single hyphens; repositories add `.` and
  `_`; there are exactly two segments. A file path such as `docs/guide.md#12`
  looks the same, so put paths in code.
- Numbers are 1 to 10 digits with no leading zero, and are not followed by a word
  character, `#`, or a `.` and a word character: `#123.`, `#123)`, `#123,`, `(#123)`,
  and a heading's `## Fix #123` convert (as on GitHub, so does `my #1 priority`);
  `\#123`, `&#123;`, `#1st`, `#123abc`, `#123.5`, `issue#123`, `PR#1`, `##123`,
  `#0`, `#0123`, code, link text, and existing Markdown links stay literal.

### Issue Repository

Read fresh from `git config --get-regexp '^remote\..*\.(url|gh-resolved)$'` in the
session directory on each submission that holds a candidate, choosing as `gh`
does: the remote `gh` resolved (`gh repo set-default`); else `upstream`, `github`,
`origin`; else the first remote whose URL parses (`https://`, `git@host:`,
`ssh://`). Supported hosts are `github.com`, `ssh.github.com` (linked on
`github.com`), and GitHub Enterprise Cloud `*.ghe.com`. SSH host aliases from
`~/.ssh/config` and `insteadOf` rewrites are not resolved, so such remotes stay
literal. Other providers are not supported yet
([#509](https://github.com/ian-pascoe/pi-extensions/issues/509)).

## Completion popup

Interactive terminal sessions only. On the first `#` in a repository, one
`gh api --hostname <host> 'repos/<owner>/<repo>/issues?state=all&sort=updated&per_page=100'`
lists its latest items, cached in memory for about five minutes (a failed attempt
for thirty seconds). Then:

- `#` lists the 20 most recently updated items.
- `#12` filters by number prefix, the exact number first.
- `#login` fuzzy-matches titles. Every choice inserts `#<number>`.

Each item reads `#123` with `issue · open · <title>` or `PR · merged · <title>` (a
pull request is open, draft, merged, or closed; an issue open or closed). The
popup lists only the latest 100 items; it does not look up an older number (type
it anyway; conversion does not need the list), search GitHub, or complete
`owner/repo#`. A lone `#` at the start of a line is a Markdown heading marker, so
the popup opens after the next character.

Suggestions need the [GitHub CLI](https://cli.github.com) signed in to the
repository's host. Once per session and host, when `gh` is missing or signed out,
Pi shows `Issue suggestions need the GitHub CLI (gh) signed in to <host>.` Network
errors, rate limits, and repositories you cannot read show no suggestions and no
notice. Conversion never needs `gh`.

## Integration

Completion stacks over the current provider, retaining ordinary slash/file
completion, keyboard controls, and custom editors. Conversion applies to terminal,
RPC, and print `prompt` input, including steering and follow-ups, without changing
attachments or message routing. Extension-generated input is unchanged.

## Troubleshooting

- **No popup:** confirm the extension loaded, use an interactive terminal, and type
  `#` after a space. Check the repository has a GitHub remote and `gh auth status`
  lists its host. `/skill:pi-issues-selector` walks through it.
- **No link:** check the exact reference against the rules above, the remote's
  host, and whether the text is escaped, in code, or already inside a link.
- **Wrong repository:** inspect `git remote -v` and `gh repo set-default --view`;
  the selector picks the same remote `gh` does.
