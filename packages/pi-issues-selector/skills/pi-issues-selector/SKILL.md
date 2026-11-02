---
name: pi-issues-selector
description: Diagnose Pi Issues Selector when `#` suggestions are missing or an Issue Reference converts to a missing or wrong GitHub link.
license: MIT
disable-model-invocation: true
---

# Pi Issues Selector

1. Read [`../../README.md`](../../README.md) for the reference syntax, how the Issue Repository is chosen, and the popup's requirements.
2. For missing suggestions, confirm extension loading and interactive mode, then type `#` after a space in ordinary prose (a lone `#` at the start of a line is a Markdown heading marker; the popup opens after the next character). Check `git config --get-regexp '^remote\..*\.(url|gh-resolved)$'` in the session directory for the Issue Repository, and `gh auth status` for the repository's host. Run `gh api --hostname <host> 'repos/<owner>/<repo>/issues?state=all&sort=updated&per_page=100'` to see the listing the popup reads. Finish when the popup lists the expected items or a named boundary (no GitHub remote, `gh` missing or signed out, private repository, rate limit, network) explains their absence.
3. For a missing or wrong link, compare the typed reference with the submitted user message and the Issue Repository's remote. Check the literal contexts (escaped, in code, inside a link, `issue#123`, `#123abc`) and whether the selected remote's host is an Issue Host: `github.com`, `ssh.github.com`, `*.ghe.com`, or a host `gh` lists (an SSH host alias stays literal). Finish when the link targets that repository or a named boundary explains the mismatch.
4. For "my GitHub Enterprise Server host isn't recognised": confirm the selected remote's host with the `git config` command above (selection never falls through to another remote), then check that its lower-cased name is a top-level key of `gh`'s `hosts.yml` (key names only; never print or paste values, the file may hold tokens) or equals a non-empty `GH_HOST`. The file is `$GH_CONFIG_DIR/hosts.yml`, else `$XDG_CONFIG_HOME/gh/hosts.yml`, else on Windows `%APPDATA%\GitHub CLI\hosts.yml`, else `~/.config/gh/hosts.yml`; empty variables count as unset, and a missing or malformed file recognises nothing without an error. Fix with `gh auth login --hostname <host>`; it takes effect on the next message. Also check for an SSH host that differs from the web host or an SSH alias (both stay literal unless `gh` lists that name), and for a host also configured for another service (unrecognised). Finish when the host is recognised or one of these boundaries explains why not.
5. If the link is correct but the page is not what you expected, report conversion as working: the link always uses `/issues/<number>`, which GitHub redirects to `/pull/<number>` for pull requests. Keep this extension configuration-free.
