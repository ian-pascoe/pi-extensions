# GitHub issue URLs for pull request numbers

Question: can an Issue Reference always link to `https://<host>/<owner>/<repo>/issues/<n>`, even
when `<n>` is a pull request?

## Findings

- GitHub issues and pull requests in one repository share one number sequence.
- Requesting `/issues/<n>` for a pull request number answers `302` with
  `location: https://github.com/<owner>/<repo>/pull/<n>`. Verified 2026-11 against
  `https://github.com/cli/cli/issues/14879` (a merged PR), unauthenticated:
  `HTTP/2 302`, `location: https://github.com/cli/cli/pull/14879`.
- Requesting `/issues/<n>` for an issue answers `200` directly (`cli/cli` issue 10000).
- Private repositories answer `404` to unauthenticated requests whichever path is used, so the
  single `/issues/<n>` form loses nothing there; agents read private items through `gh`.
- `gh auth status --json hosts` is available in `gh` 2.103.3 (local check) and reports each
  signed-in host. The release that introduced `--json` was not established.

## Consequence

A single `/issues/<n>` link works whether the number is an issue or a pull request, so conversion
needs no network lookup to choose between them.
