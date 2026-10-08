---
"@ian-pascoe/pi-guardian": patch
---

Review fewer `cd` commands. A literal `cd` that Guardian cannot prove stays in the workspace (outside it, into a nested repository, or to a missing directory) no longer sends the whole command to a Guardian Review unless its target is a Sensitive Path. It leaves the directory unknown, as an `allow` Command Rule's `cd` already did: `git`, the only built-in program that loads configuration from the working directory, is then reviewed, as is any segment only an `allow` Command Rule permits, while the other built-in programs run. A `cd` to the home directory or an ancestor of it, and a later relative operand that may name a Sensitive Path from there (also after symlinks and `..`), are reviewed too. A relative `RIPGREP_CONFIG_PATH` makes `rg` reviewed. Non-literal `cd` targets (`$X`, `$(…)`, `-`, `~user`) are still reviewed.
