# Recognise self-hosted Issue Hosts from the CLI's own host list

An **Issue Host** (the hosting service: GitHub or GitLab) serves a remote's host name when it is built in (`github.com`, `ssh.github.com`, `*.ghe.com`, `gitlab.com`), or is a host the service's CLI is signed in to or told to use. For GitHub that is the top-level keys of `gh`'s `hosts.yml`, found from `GH_CONFIG_DIR`, `XDG_CONFIG_HOME`, Windows `APPDATA`, or `~/.config/gh` exactly as `gh` finds it, plus a non-empty `GH_HOST`. For GitLab it is the keys under `hosts:` in `glab`'s `config.yml` (found from `GLAB_CONFIG_DIR`, the legacy `~/.config/glab-cli`, or `XDG_CONFIG_HOME` and the platform default), where a `hosts.<h>.ssh_host` value also maps that SSH host to the web host `<h>`; `glab`'s top-level `host`, `GITLAB_HOST`, `GITLAB_URI`, `GL_HOST`, and the per-repository config are not read as hosts. The file is read for key names only, afresh on each resolution, and never for a built-in host. A missing or malformed file recognises nothing, silently. A host claimed by more than one service (listed by both `gh` and `glab`) is not recognised. The evidence, with `gh` source references, is in [the host CLI research](../../../../docs/research/issue-host-clis.md).

## Why the CLI's list

- **No configuration.** A user who has run `gh auth login --hostname <host>` has already said which hosts they use. Links and the popup work with nothing to set up here, and the package stays free of settings.
- **It matches what `gh --hostname` and `glab api --hostname` can serve.** The popup lists through `gh api --hostname <host>`, which routes an enterprise host to `/api/v3`, or `glab api --hostname <host>`. A host the CLI is not signed in to cannot supply suggestions, so recognising only signed-in hosts keeps links and the popup consistent.
- **Hosts stay listed when tokens live in the OS keyring**, so reading key names is enough, and no secret is read.
- **Offline.** `gh auth status` makes a network request per host and account, so it is not used.

## Considered Options

- **A Pi setting mapping hosts to services.** Rejected for now: it asks every user to configure what `gh` already knows. It can be added later without breaking anything, because the built-in hosts, the CLI's list, and an explicit setting would compose as further claims on a host.
- **Hostname heuristics** (`github.*`, `git.*`, `gitlab.*`). Rejected: a guessed service builds a wrong link, and no link is better than a wrong one. The same reasoning leaves a host claimed by two services unrecognised.
- **Copying `gh`'s rule that `GH_HOST` restricts remotes.** Rejected: `GH_HOST` only adds a host here, so the remote the user is working in is not hidden by an unrelated variable.

## Consequences

- Remote selection is unchanged. When the selected remote's host is unrecognised the Issue Repository is unresolved, and no other remote is chosen in its place. Choosing a remote by whether its host is recognised, and SSH host aliases, are separate decisions.
- Links are always `https` and carry no port. An SSH host that differs from the web host stays literal unless `gh` lists it or `glab` lists it as an `ssh_host`.
- Each adapter lists its own configured hosts through one `IssueHost` method with an injected environment and file reader, so another service's adapter adds its CLI's list without touching the lookup.
