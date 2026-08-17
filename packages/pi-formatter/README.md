# @ian-pascoe/pi-formatter

Configured automatic post-edit formatting for
[Pi](https://github.com/earendil-works/pi).

## Install

```bash
pi install npm:@ian-pascoe/pi-formatter
# or
pi install git:github.com/ian-pascoe/pi-extensions
```

For a local checkout, run `pi -e ./packages/pi-formatter/src/index.ts`.
Install formatter executables separately.

## Settings

Pi Formatter reads the `formatter` key from Pi's global `~/.pi/agent/settings.json` and trusted
project `.pi/settings.json`:

```json
{
  "formatter": {
    "timeoutMs": 30000,
    "formatters": {
      "markdownlint-cli2": {
        "command": "markdownlint-cli2",
        "args": ["--fix", "$FILE"],
        "files": {
          "extensions": [".md", ".mdx"],
          "fileNames": ["README"]
        },
        "requireRootMarker": true,
        "rootMarkers": ["package.json", ".git"],
        "environment": {}
      }
    }
  }
}
```

Each formatter requires a non-empty `command` and at least one file extension or exact basename.
Extensions include the leading period. Matching is case-sensitive. Arguments are passed directly
to the executable without a shell. Every `$FILE` substring in an argument is replaced with the
absolute changed-file path.

A formatter using `$FILE` runs once per matching changed file. A formatter without `$FILE` runs
once per matching workspace root, allowing full-project formatting. `rootMarkers` are basename glob
patterns; the nearest matching ancestor becomes the command working directory and Pi's working
directory is the fallback. Set `requireRootMarker` to `true` to skip the formatter unless any root
marker exists above the changed file; it defaults to `false`. A required empty `rootMarkers` list is
invalid. Formatters run sequentially in configuration order. Successful output is silent. A
timeout, spawn error, or non-zero exit appends a warning to the original tool result without
changing that result's success state; later formatters still run.

Global and project `timeoutMs` values override by scope. A project formatter replaces the complete
global definition with the same ID; set it to `null` to disable it. Invalid definitions and fields
are quarantined individually and reported at session startup. An invalid project replacement still
shadows the global formatter. Untrusted project settings are ignored.

## Supported mutations

Formatting runs after successful native `edit` and `write` operations, Codex-style `apply_patch`
results, and applied Pi LSP Workspace Edit Previews. Changed and created files plus rename
destinations are formatted; deleted or vanished files are skipped.

When the Git collection is installed, Pi Formatter loads before Pi LSP so Post-edit Diagnostics
observe formatted content. Separately installed extensions depend on Pi's configured extension
order.

## Security

Trusted formatter settings execute arbitrary local programs with the Pi process's environment and
permissions. Review project settings and formatter binaries before trusting a project.
