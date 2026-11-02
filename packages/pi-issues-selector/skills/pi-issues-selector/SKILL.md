---
name: pi-issues-selector
description: Diagnose Pi Issues Selector when `#` suggestions are missing or an Issue Reference converts to a missing or wrong GitHub link.
license: MIT
disable-model-invocation: true
---

# Pi Issues Selector

1. Read [`../../README.md`](../../README.md) for the reference syntax, how the Issue Repository is chosen, and the popup's requirements.
2. For missing suggestions, confirm extension loading and interactive mode, then type `#` after a space in ordinary prose (a lone `#` at the start of a line is a Markdown heading marker; the popup opens after the next character). Check `git config --get-regexp '^remote\..*\.(url|gh-resolved)$'` in the session directory for the Issue Repository, and `gh auth status` for the repository's host. Run `gh api --hostname <host> 'repos/<owner>/<repo>/issues?state=all&sort=updated&per_page=100'` to see the listing the popup reads. Finish when the popup lists the expected items or a named boundary (no GitHub remote, `gh` missing or signed out, private repository, rate limit, network) explains their absence.
3. For a missing or wrong link, compare the typed reference with the submitted user message and the Issue Repository's remote. Check the literal contexts (escaped, in code, inside a link, `issue#123`, `#123abc`) and whether the remote's host is `github.com`, `ssh.github.com`, or `*.ghe.com` (an SSH host alias stays literal). Finish when the link targets that repository or a named boundary explains the mismatch.
4. If the link is correct but the page is not what you expected, report conversion as working: the link always uses `/issues/<number>`, which GitHub redirects to `/pull/<number>` for pull requests. Keep this extension configuration-free.
