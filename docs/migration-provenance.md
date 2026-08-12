# Migration provenance

This document records the fixed inputs for the source-TypeScript migration into
`ian-pascoe/pi-extensions`. The first commit in this repository that contains a
copied file is that file's monorepo provenance point. Inputs and Pi settings
are read-only during migration.

## Copy boundary

| Target package                  | Input boundary                                                                                                                                                              |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/pi-adaptive-thinking` | Production `src/{index,config,config-loader,thinking-levels}.ts`, source tests, `README.md`, and `CHANGELOG.md` from the fixed commit.                                      |
| `packages/pi-byterover`         | Production `src/{index,config,config-loader,gitignore,lru-cache,messages,recall,tools}.ts`, source tests, `README.md`, `CHANGELOG.md`, and `LICENSE` from the fixed commit. |
| `packages/pi-minimal-subagents` | The 16 TypeScript files and `README.md` in loose `minimal-subagents/`; the former top-level `minimal-subagents.ts` is not an input.                                         |
| `packages/pi-bible-verses`      | Only the four TypeScript files in loose `bible-verses/`.                                                                                                                    |
| `packages/pi-tps-tracker`       | Loose `tps-tracker.ts`.                                                                                                                                                     |
| `packages/pi-git-status-widget` | Loose `git-status-widget.ts`.                                                                                                                                               |

Standalone VCS/CI/tooling, lockfiles, generated output, and local state are
excluded. The untracked ByteRover fact below is source state, not package input.
Copied Adaptive Thinking and ByteRover changelogs retain their historical links.

## Standalone repositories

| Package                | Source URL                                           | Fixed revision                             | Observed source status                                                        |
| ---------------------- | ---------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------- |
| `pi-adaptive-thinking` | <https://github.com/ian-pascoe/pi-adaptive-thinking> | `4bc5dbe6dfe3d9108049d0002dc3dcfe51725764` | Clean.                                                                        |
| `pi-byterover`         | <https://github.com/ian-pascoe/pi-byterover>         | `fe841f6990522148bc6898b3f7fd7a11fdad5074` | `?? .brv/context-tree/facts/project/context_injection_and_curate_workflow.md` |

### Standalone baseline tests

On 2026-08-12, each fixed commit was exported with `git archive` to a temporary
directory. `HUSKY=0 pnpm install --frozen-lockfile` and then `pnpm test` ran
only in the export:

| Package                      | Result                         |
| ---------------------------- | ------------------------------ |
| `pi-adaptive-thinking@0.1.1` | 4 test files, 22 tests passed. |
| `pi-byterover@0.2.4`         | 7 test files, 45 tests passed. |

No migrated assertion is weakened for an upstream baseline failure.

## Loose-extension checksums

All values are SHA-256 checksums recorded on 2026-08-12.

### Minimal Subagents

```bash
cd ~/.pi/agent/extensions
find minimal-subagents -type f \( -name '*.ts' -o -name README.md \) -print0 \
  | sort -z \
  | xargs -0 sha256sum \
  | sha256sum
```

Aggregate: `d7ed73edf599873d09c92c347bdfba3b0df3e4a456ae46e174cf9d2cbfe822e6`

```text
767cd1cb943ec3a74c6136822f1dd47db43f418ff1f8fd7efe709d9daadf7294  minimal-subagents/README.md
803c89a15e707e198bd11801af819b7c5c15f4a4fbc5289a433b969250dfe626  minimal-subagents/index.ts
008929253ba3d8e1d8d4bbeedd030be6adce3050ddd00b4664a2d3cde0acbc19  minimal-subagents/minimal-subagents-capabilities.ts
53c64f9113ec52331548d27df71750a3997845c608044f7ac24480d2fc436e58  minimal-subagents/minimal-subagents-config.ts
a305d9ac3e5d862cb68df3de307384cf8b4422c660685d484fc9c7d28a07c4d6  minimal-subagents/minimal-subagents-context.ts
2d92d6264bd1b80fba028bf1dcfc1133a8a67cb4b69f86f9df973385b88096c6  minimal-subagents/minimal-subagents-coordinator.ts
5c35a5c2f3c545646e2db3f8c0c90e3936cea9ebef6370e4903cec4987d10ad4  minimal-subagents/minimal-subagents-extension.ts
e979ab6c56caffb762c7c1f191d0e81f141aa50a832c22ed8341876230078160  minimal-subagents/minimal-subagents-fork-lifecycle.ts
2ab977150b99b3185b9c7a9b52fab71862da1fe86e207ca5001f10ff5777f597  minimal-subagents/minimal-subagents-registry.ts
5e499c6c89139fb1cbce4959907006a17400cae66445e914d8f181bb0f8789b6  minimal-subagents/minimal-subagents-rendering.ts
0c70add89aba2e5c62f6ceaf5a2d76e49cead3fc933bff0ecc708a8ba43c69a3  minimal-subagents/minimal-subagents-sessions.ts
dc35c1460ec47bf8666e1ccb2e1d7692ba68c76baaec1d128e6651cdebcf36d8  minimal-subagents/minimal-subagents-shutdown.ts
c33c800d1b904c0a2a7a50ee393e818cc0263ca5e67b5aa583b3a64bff9788b4  minimal-subagents/minimal-subagents-tool-schemas.ts
247dcb2b52146597616a53eb0129b97ecee8b653a5a59edcec07f5f7fda47ec6  minimal-subagents/minimal-subagents-tools.ts
66f13aa4b1812da57e8bd86875721bf3b076f64d65b8c521ba55ccc5e170f8d8  minimal-subagents/minimal-subagents-types.ts
4d704b47f9689d3f9cb07782f6813d53acaed5f494db8b45cd1efb487de1e8f8  minimal-subagents/minimal-subagents-ui.ts
1ef12ebde970398d108beb02f6fe5327fde94d91637d739bdf7cb0ac093f0ea9  minimal-subagents/minimal-subagents-usage.ts
```

### Bible Verses

```bash
cd ~/.pi/agent/extensions
find bible-verses -type f -name '*.ts' -print0 | sort -z | xargs -0 sha256sum | sha256sum
```

Aggregate: `4d239c6c3a1db8996870922674f1709c2f4bd4688c8f6df238eb0ed6e67baa3a`

```text
bd80ae2fad36b1b9ca3c36fd34d7706cd705aa1e1b08c665fbe42a14cccf57a2  bible-verses/bible-translations.ts
98a9512cc91072369e2501711af3685dd1bca594bb44ea365346b5a5e49c4bfc  bible-verses/bible-verse-picker.ts
78ca5d2802d08d5acf596591fb68e4fb7028960d021e726d362b2f533d27b0ac  bible-verses/bible-verses.ts
0a8fa7bbb6b8ffb2075875d4ae1f11c2a1527d24976ce1e2ebb2d487f4c0b61c  bible-verses/index.ts
```

### Single-file extensions

```text
4f21b5ea72f8afb98a83062f37891a8c7cb2122322f6510926442021df840f9c  ~/.pi/agent/extensions/tps-tracker.ts
8f2e2e718643aaa8ba8c3635f83751bbf1f847ffc98a3d29be63309b15daa611  ~/.pi/agent/extensions/git-status-widget.ts
```

## Bible translation rights boundary

Package code is MIT-licensed. The embedded verse text is not relicensed by that
MIT grant: WEB, BSB, ASV, DARBY, YLT, and DRA passages are public domain; OEB
passages are CC0. The package README and `bibleTranslationMetadata` retain the
exact edition, license, `staticEmbeddingAllowed`, source URL, rights URL,
source-archive SHA-256, and provenance notice for each translation. Those
records are authoritative for embedded text.

## Pi settings before-state

Settings contents are not copied. This migration records existence and hash only:

```text
a28f590f6076fa02e72a15ac642b68ae758477e3ed09675ea926f4d0985a9b9e  ~/.pi/agent/settings.json
absent  .pi/settings.json
```

Final validation recomputes these values and confirms that no source repository,
loose extension, or Pi settings file was modified.
