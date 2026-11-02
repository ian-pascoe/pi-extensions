---
"@ian-pascoe/pi-issues-selector": minor
---

Recognise GitHub Enterprise Server hosts. A remote whose host is a top-level key of `gh`'s `hosts.yml` (found from `GH_CONFIG_DIR`, `XDG_CONFIG_HOME`, Windows `APPDATA`, or `~/.config/gh`, as `gh` finds it) or equals `GH_HOST` now converts `#123` and `owner/repo#123` to `https://<host>/<owner>/<repo>/issues/<n>`, and the `#` popup lists through `gh api --hostname <host>`. Sign in with `gh auth login --hostname <host>`. Only key names are read, and a missing or malformed file recognises nothing. When the selected remote's host is unrecognised, references stay literal and no other remote is chosen. Adds the `yaml` dependency.
