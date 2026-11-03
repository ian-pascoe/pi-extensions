# @ian-pascoe/pi-issues-selector

## 0.2.1

### Patch Changes

- Updated dependencies [1a9d7cc]
  - @ian-pascoe/pi-utils@0.13.0

## 0.2.0

### Minor Changes

- 0277153: Recognise GitHub Enterprise Server hosts. A remote whose host is a top-level key of `gh`'s `hosts.yml` (found from `GH_CONFIG_DIR`, `XDG_CONFIG_HOME`, Windows `APPDATA`, or `~/.config/gh`, as `gh` finds it) or equals `GH_HOST` now converts `#123` and `owner/repo#123` to `https://<host>/<owner>/<repo>/issues/<n>`, and the `#` popup lists through `gh api --hostname <host>`. Sign in with `gh auth login --hostname <host>`. Only key names are read, and a missing or malformed file recognises nothing. When the selected remote's host is unrecognised, references stay literal and no other remote is chosen. Adds the `yaml` dependency.
- 407316b: Add the GitLab Issue Host. A remote on `gitlab.com`, or on a self-managed host that is a key under `hosts:` in `glab`'s `config.yml` (found from `GLAB_CONFIG_DIR`, the legacy `~/.config/glab-cli`, or `XDG_CONFIG_HOME` and the platform default; a remote on a `hosts.<h>.ssh_host` counts as `<h>`), now converts `#12` to `https://<host>/<group>/<project>/-/issues/12` and `!3` to `/-/merge_requests/3`, and `group/sub/project#12` or `!3` to the named project. `#` lists issues and `!` lists merge requests through `glab api --hostname <host>`; a message that starts with `!` stays Pi's bash mode. Remote selection also honours glab's `glab-resolved-base` marker and tries a `gitlab` remote after `origin`; checkouts without a remote named `gitlab` or glab markers select as before, except on a host that is not built in, where a path only GitLab's grammar accepts now counts. Sign in with `glab auth login --hostname <host>`. A host known to both `gh` and `glab` stays literal. Only key names and `ssh_host` strings are read from `glab`'s config.

## 0.1.0

### Minor Changes

- d3041cf: Add `#123` and `owner/repo#123` Issue References: a native completion popup over the repository's recent GitHub issues and pull requests (through a signed-in `gh`), and conversion to `/issues/<number>` links on submission.

### Patch Changes

- Updated dependencies [d3041cf]
- Updated dependencies [2552e08]
  - @ian-pascoe/pi-utils@0.12.0
