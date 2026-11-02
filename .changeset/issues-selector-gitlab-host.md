---
"@ian-pascoe/pi-issues-selector": minor
---

Add the GitLab Issue Host. A remote on `gitlab.com`, or on a self-managed host that is a key under `hosts:` in `glab`'s `config.yml` (found from `GLAB_CONFIG_DIR`, the legacy `~/.config/glab-cli`, or `XDG_CONFIG_HOME` and the platform default; a remote on a `hosts.<h>.ssh_host` counts as `<h>`), now converts `#12` to `https://<host>/<group>/<project>/-/issues/12` and `!3` to `/-/merge_requests/3`, and `group/sub/project#12` or `!3` to the named project. `#` lists issues and `!` lists merge requests through `glab api --hostname <host>`; a message that starts with `!` stays Pi's bash mode. Remote selection also honours glab's `glab-resolved-base` marker and tries a `gitlab` remote after `origin`; checkouts without GitLab remotes or markers select as before. Sign in with `glab auth login --hostname <host>`. A host known to both `gh` and `glab` stays literal. Only key names and `ssh_host` strings are read from `glab`'s config.
