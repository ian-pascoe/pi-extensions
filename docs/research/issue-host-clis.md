# Host CLIs and GitLab API for GitLab and GHES issue references

Question: for issue #509 (GitLab and GitHub Enterprise Server support in `packages/pi-issues-selector`),
how do `gh` and `glab` locate their config, enumerate configured hosts, pick a host, mark remote
resolution, and what do the GitLab REST API and web URLs look like?

Sources and pins (primary only):

- `gh`: `github.com/cli/cli` at `7e97c4c4f5124f5e74611c099a610989315f128b` (shallow clone). Config
  and host logic come from `github.com/cli/go-gh/v2` `v2.17.0`, pinned by cli's `go.mod`.
- `glab`: `gitlab.com/gitlab-org/cli` at `9377b78998060f3d59b74b95cf7f624c55eccd1d` (shallow clone).
  Platform config paths come from `github.com/adrg/xdg` `v0.5.3` (pinned by glab's `go.mod`).
- GitLab REST docs (`docs.gitlab.com/api/...`) and GitLab Rails source (`gitlab-org/gitlab`, master,
  fetched raw on the day of research).
- Local `gh` is 2.103.3. I did not confirm that it was built from the cloned commit. `glab` is not
  installed, so every `glab` claim is from source.
- Verification labels: **Verified** means checked in source or live. **Inferred** means reasoned from
  source without running it.

## Findings

### 1. gh config location and `hosts.yml`

- Config dir precedence, verified: `GH_CONFIG_DIR`, then `$XDG_CONFIG_HOME/gh`, then
  `$AppData/GitHub CLI` (Windows only), then `$HOME/.config/gh`. Empty values count as unset.
  `go-gh/pkg/config/config.go:273-285` (`ConfigDir`, permalink
  `https://github.com/cli/go-gh/blob/v2.17.0/pkg/config/config.go#L273-L285`). The same order is
  documented in `gh help environment` and in `pkg/cmd/root/help_topic.go:105-109`.
  - On macOS, the default is `~/.config/gh`. The Application Support default used by glab does not
    apply here. Verified in source.
- Files: `config.yml` and `hosts.yml` live in that dir. `load()` reads both and, if `hosts.yml` is
  non-empty, inserts it under a `hosts` key (`go-gh/pkg/config/config.go:216-249`, `255-257`).
  **Verified:** the top-level keys of `hosts.yml` are hostnames, and the `hosts` map sits under them.
- Env hosts without `hosts.yml`, verified in `go-gh/pkg/auth/auth.go`:
  - `GH_HOST` is always added to the known-host list (`auth.go:120-124`, `knownHosts`), and it wins
    as the default host (`auth.go:146-149`, `defaultHost`).
  - `GH_TOKEN` or `GITHUB_TOKEN` adds `github.com` when set (`auth.go:125-127`).
  - `GH_ENTERPRISE_TOKEN` or `GITHUB_ENTERPRISE_TOKEN` does **not** add its host to the list. It
    only supplies a token for that host (`auth.go:77-78`). Enterprise hosts reached this way are
    listed only if `GH_HOST` names them, or if they appear in `hosts.yml`. The CLI then errors
    asking for `GH_HOST` (`pkg/cmd/factory/remote_resolver.go:86-88`).
- Keyring: when a token is stored in the OS keyring, `hosts.yml` still lists the host. `login`
  stores the token under service `gh:<host>` and account = username (`internal/config/config.go:725-727`,
  `386-397`). It removes any file-stored `oauth_token` (`config.go:500-504`), then writes
  `hosts.<host>.users.<user>` and `hosts.<host>.user` (`completeLogin` at `config.go:527-544`,
  `activateUser` at `config.go:621-632`). So the host key stays in `hosts.yml` with no token.
  **Verified** in source; **inferred** from it, not run.

### 2. `gh auth status` offline?

- **No.** `statusRun` (`pkg/cmd/auth/status/status.go:268-300`) builds an entry per host and per
  account through `buildEntry` (`status.go:455-525`).
  - For env-sourced tokens, `buildEntry` calls `api.CurrentLoginName` (`status.go:487-498`).
  - For every token, it calls `shared.GetScopes`, an authenticated HTTP request to the API root
    (`status.go:501`; `pkg/cmd/auth/shared/oauth_scopes.go:35-41`).
  - So each configured host and account gets a network request.
- `--json hosts` (`authStatusFields = "hosts"`, `status.go:64-66`, flag at `status.go:263`) uses the
  same path, so it is **not offline either**. Token values are dropped from machine output
  (`status.go:363-375`, `host[i].Token = ""`), but the requests still happen.
- Offline host listing, verified in source: `ghauth.KnownHosts()` (`go-gh/pkg/auth/auth.go:115-135`)
  reads only the env (`GH_HOST`, `GH_TOKEN`/`GITHUB_TOKEN` for `github.com`) and the `hosts` keys. It
  does no network I/O.
  - The CLI's `Hosts()` delegates to it (`internal/config/config.go:406-411`).
  - No public `gh` subcommand exposes this offline. The workable offline route is to read the
    top-level keys of `hosts.yml` (plus `GH_HOST`). Key names only, never values.
- Local check, key names only (values not printed): the local `hosts.yml` has one top-level key,
  `github.com:`. Verified.

### 3. `glab` config location and file structure

- Config dir precedence, verified in `internal/config/config_file.go`:
  1. `GLAB_CONFIG_DIR`, if set (`config_file.go:35-54`, `ConfigDir`). It bypasses XDG entirely
     (`SearchConfigFile`, `config_file.go:63-100`).
  2. Legacy `~/.config/glab-cli`, but only if `~/.config/glab-cli/config.yml` already exists
     (`config_file.go:23-32`, `38-47`).
  3. `xdg.ConfigHome/glab-cli`. `ConfigHome` is `$XDG_CONFIG_HOME` if set, otherwise the platform
     default from `adrg/xdg` `v0.5.3`:
     - macOS: `~/Library/Application Support` (`paths_darwin.go:16-25`). This is **not** `~/.config`.
     - Windows: `%LOCALAPPDATA%` (`paths_windows.go:21`).
     - Other Unix: `~/.config` (`paths_unix.go:23`).
  - Read search, `xdg.SearchConfigFile`, covers `configHome` then `configDirs` (`base_dirs.go:68-69`).
  - glab warns when several locations hold a `config.yml` and uses the first (`config_file.go:104-150`).
- File name and shape, verified: `config.yml`, with a top-level `hosts:` map keyed by hostname
  (`config.go:860-889`, `hostEntries`/`Hosts`; `config.go:919-946`, `parseHosts`). Per-host keys
  include `token`, `api_host`, `use_keyring`, and similar (`config.go:264-356`). Top-level `host`
  sets the default host (`internal/config/schema.go:170-171`, env `GITLAB_HOST`/`GITLAB_URI`/`GL_HOST`).
- **gitlab.com is not always present.** `Hosts()` returns only keys in the `hosts` map
  (`config.go:875-889`). The remote resolver adds `gitlab.com` as a known host regardless
  (`internal/cmdutils/remote_resolver.go:58-59`, `knownHosts[glinstance.DefaultHostname]`).
- Keyring: when `use_keyring: true`, tokens are read from the keyring under key `glab:<host>:<key>`
  (`config.go:490-492`, `buildKeyringKey`). The file keeps the host entry.
- Per-repo config, verified: `<git-dir>/glab-cli/config.yml`, from `git rev-parse --git-dir`
  (`internal/config/local_config.go:22-35` `GitDir`; `68-77` `LocalConfigDir`/`LocalConfigFile`;
  `config_file.go:234`). Local values override global values for non-token keys
  (`config.go:264-356`, `Local()` is read first). Token keys come from the global `hosts` entry.
  Local-config precedence was verified in source only.

### 4. `glab api`

- `--hostname` exists, verified: `internal/commands/api/api.go:327` (flag help), `353-355`
  (validated with `glinstance.HostnameValidator`).
- Host selection, verified:
  1. `--hostname` if given (`api.go:492-493`).
  2. Otherwise the base repo's host, if the cwd is a git repo that resolves (`api.go:494-500`,
     `o.baseRepo()`).
  3. Otherwise the factory default (`internal/cmdutils/factory.go:66-89`). That is `GITLAB_HOST` /
     `GITLAB_URI` / `GL_HOST`, else the `host` config key, else `gitlab.com`. Inside a repo, the
     base repo's host overrides it (`factory.go:86-89`).
  - Help text confirms the rule: "the authenticated host in the current Git directory. Otherwise,
    gitlab.com is used" (`api.go:121-123`).
  - `ApiClient("")` maps to the factory default (`factory.go:113-116`).
  - The base URL is `https://<host>/api/v4/` for self-hosted, and `https://gitlab.com/api/v4/` for
    gitlab.com (`internal/glinstance/host.go:93-105`).
- Not authenticated, verified in source:
  - A host with no token and no OAuth2 config makes an **unauthenticated** request
    (`internal/api/client.go:493-502`). It is not rejected up front.
  - An OAuth2-configured host with no token, or a keyring-backed token that is missing, fails early
    with an error telling the user to run `glab auth login --hostname <host>`
    (`client.go:466-469`, `493-497`).
  - Non-2xx responses print `glab: <server message>` to stderr, or `glab: HTTP <code>` if the body
    has no message (`api.go:586-600`). That output path exits with `SilentError`.
  - `SilentError` produces no output of its own (`internal/cmdutils/errors.go:46-48`). `main`
    exits 1 for anything that is not an `ExitError` (`cmd/glab/main.go:186-193`).
  - **Exit code and stderr for a non-authenticated request: exit 1.** Stderr is
    `glab: <message>` from GitLab. Live check, no token, no glab installed:
    `GET https://gitlab.com/api/v4/projects/gitlab-org%2Fnope-xyz-404/issues` returned
    `{"message":"404 Project Not Found"}`, so glab would print `glab: 404 Project Not Found`.
    The exit code and stderr wording are **inferred** from source, not run.

### 5. `glab` remote resolution marker and remote order

- Marker, verified: glab writes **`remote.<name>.glab-resolved-base`** and
  **`remote.<name>.glab-resolved-head`** (`internal/git/git.go:566-576`, `SetRemoteResolution`).
  The legacy key `glab-resolved` is still read (`git.go:462-492`), but it is not written for
  new resolutions. Values are `base`, `base:<group/project>`, `head`, or `head:<...>`.
  - Compare gh's `remote.<name>.gh-resolved` (`git/client.go:169`, `203`) and its values
    (`base`, `context/context.go:72`).
- Remote order, verified:
  - Remotes are sorted by name score: `upstream` = 3, `gitlab` = 2, `origin` = 1, others = 0. Higher
    first (`internal/glrepo/remote.go:53-71`).
  - The resolver calls `sort.Sort` (not `sort.Stable`) on that list (`internal/cmdutils/remote_resolver.go:105`).
    **Ties are not guaranteed to keep `git remote -v` order.**
  - Before sorting, remotes are filtered to a single known host (`remote_resolver.go:56-167`). Known
    hosts are `gitlab.com`, configured `hosts` keys, and `ssh_host` aliases. The first remote's host
    wins, and remotes on other hosts are dropped. A `GITLAB_HOST`-style override is preferred when it
    matches at least one remote (`remote_resolver.go:107-135`).
- Base-repo selection, verified (`internal/glrepo/resolver.go`):
  - An existing `glab-resolved-base` (or legacy value) wins (`resolver.go:71-106`).
  - Without a cached value, and without an interactive prompt, the first remote after the sort is
    used (`resolver.go:108-111`).
  - With prompting, up to 5 remotes are looked up on the API. The selected project's remote is
    chosen, and the result is cached (`resolver.go:113-179`).
  - The factory only runs this when `resolveRepos` is set. Otherwise it returns `remotes[0]`
    (`internal/cmdutils/factory.go:190-198`).

### 6. GitLab REST API

Sources: `docs.gitlab.com/api/issues/`, `docs.gitlab.com/api/merge_requests/`,
`docs.gitlab.com/api/rest/` (section "Namespaced paths"), and the Rails source for the same endpoints.

- `GET /projects/:id/issues`:
  - `state` default is **`all`**. Source: `lib/api/issues.rb:104`
    (`values: %w[opened closed all], default: 'all'`). The project route is at `lib/api/issues.rb:282`.
    Live: with no `state`, the first 50 results contained 34 `opened` and 16 `closed`. Verified.
  - `state` values: `opened`, `closed`, `all` (`issues.rb:104`).
  - `order_by` default `created_at`, and `updated_at` is a valid value (`issues.rb:107`;
    doc lines 295-296). `sort` default `desc` (`issues.rb:109`). So `order_by=updated_at&sort=desc`
    is valid and needs no extra parameters.
  - Fields: `iid`, `title`, `state` (`opened` or `closed`). The doc response examples show
    `"state": "opened"` and `"state": "closed"`.
  - Note: the top-level `GET /issues` endpoint (`lib/api/issues.rb:167-175`) is a different route. Its doc says `scope` defaults to `created_by_me`. It is not the project route used here.
- `GET /projects/:id/merge_requests`:
  - `state` default **`all`**. Doc: "Defaults to all" (`merge_requests` doc, `state` row).
    Source: `lib/api/helpers/merge_requests_helpers.rb:50-52` (`values: %w[opened closed locked merged all], default: 'all'`).
    Live: 50 MRs with no `state` returned a mix of `opened`, `merged`, and `closed`. Verified.
  - `state` values: `opened`, `closed`, `locked`, `merged`, plus `all` (`merge_requests_helpers.rb:50`;
    doc: "Searching by locked generally returns no results as that state is short-lived").
  - `draft`: boolean. Doc: "If true, the merge request is marked in a draft state." Source:
    `lib/api/entities/merge_request_basic.rb:57` (`expose :draft?, as: :draft`).
  - `draft` is the filter parameter (`merge_requests_helpers.rb:102-104`, mutually exclusive with `wip`).
  - `work_in_progress` (and the `wip` filter) is **deprecated in GitLab 19.0**, to be replaced by
    `draft`. Doc: "Deprecated. Use draft instead." (`work_in_progress` in the MR doc;
    `merge_request_basic.rb:61-63`). The `wip` filter is deprecated in the same way.
- Namespaced `:id`, verified:
  - The REST doc says to URL-encode `NAMESPACE/PROJECT_PATH`, with `/` as `%2F`
    (`docs.gitlab.com/api/rest/`, "Namespaced paths", lines 118-121). Example:
    `GET /api/v4/projects/diaspora%2Fdiaspora`.
  - Nested groups work with the same rule, because the `:id` is the full path.
    Live: `GET /projects/gitlab-org%2F5-minute-production-app%2Fhipio` returned 200, and so did
    `/projects/<encoded>/issues?per_page=1`.
  - The unencoded form `/projects/gitlab-org/cli` returned 404, while the encoded form returned 200.
    Live, verified.

### 7. GitLab web URLs

- Web URL shapes, verified in routes and live:
  - `scope '-'` wraps the project routes (`config/routes/project.rb:30`), and `draw_all :issues`
    and `draw_all :merge_requests` sit inside it (`project.rb:422-423`).
  - Issues: `resources :issues, ..., constraints: { id: /\d+/ }` (`config/routes/issues.rb`), giving
    `https://<host>/<namespace path>/-/issues/<iid>`.
  - MRs: `resources :merge_requests, ..., constraints: { id: /\d+/ }` (`config/routes/merge_requests.rb`),
    giving `https://<host>/<namespace path>/-/merge_requests/<iid>`.
  - Live: `https://gitlab.com/gitlab-org/cli/-/issues/1` returned 200. A nested-group issue
    `https://gitlab.com/gitlab-org/5-minute-production-app/hipio/-/issues/1` returned 200.
- **No redirect between issue and MR paths.** Live cross-checks on `gitlab-org/cli`:
  - MR iid `4263`: `/-/merge_requests/4263` returned 200. `/-/issues/4263` returned 404 with no
    redirect. The API `GET .../issues/4263` also returned 404.
  - Issue iid `8683`: `/-/issues/8683` returned 200. `/-/merge_requests/8683` returned 404 with no
    redirect.
  - Source: `app/models/issue.rb:83` uses `has_internal_id :iid, scope: :namespace`.
    `app/models/merge_request.rb:48-56` uses `has_internal_id :iid, scope: :target_project` with a
    `maximum(:iid)` on `merge_requests`. So the two are separate per-project sequences.
    The issues controller has no code path that redirects to an MR. The redirect that applies to
    `show` is `redirect_if_work_item` (`app/controllers/projects/issues_controller.rb:478-486`), which
    sends an issue to its work-item page. I checked this by reading code, not exhaustively.
- Project path grammar, verified in `lib/gitlab/path_regex.rb`:
  - `PATH_START_CHAR = [a-zA-Z0-9_.]`, then `[a-zA-Z0-9_.-]` up to `URL_MAX_LENGTH - 1`
    (`path_regex.rb:133-134`). `URL_MAX_LENGTH = 255` (`app/models/namespace.rb:55`).
  - No `.git` or `.atom` suffix (`path_regex.rb:137-139`, `NO_SUFFIX_REGEX`).
  - The validation message: "can contain only letters, digits, '_', '-' and '.'. Cannot start with
    '-', end in '.git' or end in '.atom'" (`path_regex.rb:288-291`).
  - Nesting is capped at 20 ancestors (`app/models/namespace.rb:49`, `NUMBER_OF_ANCESTORS_ALLOWED = 20`).
  - Reserved words exist (`ILLEGAL_PROJECT_PATH_WORDS`, `path_regex.rb:123`), and `-` is a reserved
    group route word (`path_regex.rb:116-121`, `GROUP_ROUTES`). I did not enumerate the full list.

### 8. GHES API via `gh`

- Verified in source: `RESTPrefix(host)` returns `https://<host>/api/v3/` for any enterprise host
  (`internal/ghinstance/host.go:59-65`). Enterprise means not `github.com`, not `*.ghe.com`, and not
  `github.localhost` (`go-gh/pkg/auth/auth.go:161-173`, `IsEnterprise`). `GraphQLEndpoint` likewise
  returns `https://<host>/api/graphql` (`host.go:46-52`).
- `gh api --hostname <host>` sets the host (`pkg/cmd/api/api.go:292`, `api.go:417-423`). That host
  is passed to `APIHostForHost` and then to the REST prefix.
- Not run live: no GHES instance was available. Routing is **verified in source, not live**.

## Consequence

- Host enumeration without the network:
  - For `gh`, read the top-level keys of `$GH_CONFIG_DIR|$XDG_CONFIG_HOME/gh|~/.config/gh/hosts.yml`,
    plus `GH_HOST`. Never parse token values. `gh auth status` makes HTTP calls for each host and
    account, so do not use it to enumerate hosts on a hot path.
  - For `glab`, read the top-level `hosts` map in `config.yml`, honouring `GLAB_CONFIG_DIR`, the
    legacy `~/.config/glab-cli`, and on macOS `~/Library/Application Support/glab-cli`. Add
    `gitlab.com` explicitly, because it is not in the map.
- Remote-to-host mapping should use the remote's URL host and path, not glab's cached
  `glab-resolved-base`. The resolution is user-cached state, and it may be absent.
- Issue vs MR: a reference's kind must be carried through. There is no redirect from `/-/issues/<n>`
  to an MR, and `iid`s are not shared between the two. Convert each kind to its own path.
- GitLab API calls should use the URL-encoded full path as `:id`. Pass `state=opened` explicitly
  where the default `all` is wrong. Use `draft` (not `work_in_progress`) for MR draft status.
- GHES via `gh api --hostname <host>` routes to `https://<host>/api/v3/`. Verified in source only.
  Enterprise-token env vars alone do not list the host, so `GH_HOST` or `hosts.yml` is needed for
  discovery.
- Open risk: `glab api` without `--hostname` and outside a repo falls back to the default host
  (`factory.go:113-116`). For `pi-issues-selector`, always pass the host explicitly.
