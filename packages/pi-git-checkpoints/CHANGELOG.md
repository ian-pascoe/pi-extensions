# @ian-pascoe/pi-git-checkpoints

## 0.3.1

### Patch Changes

- Updated dependencies [7ab488c]
- Updated dependencies [eed4468]
- Updated dependencies [58a2ce1]
  - @ian-pascoe/pi-utils@0.6.0

## 0.3.0

### Minor Changes

- 4ef1998: Info notifications no longer carry the `Git Checkpoints:` prefix; warnings and errors keep it. Requires Pi 1.1.0 or newer.

### Patch Changes

- Updated dependencies [4ef1998]
- Updated dependencies [4ef1998]
  - @ian-pascoe/pi-utils@0.5.0

## 0.2.5

### Patch Changes

- 0a92e19: Stop every Model Step from re-listing unchanged git-ignored files (such as `.husky/_/*`) as skipped paths in the session. Each checkpoint now records its ignored set only when it changes, and Restore still leaves those paths untouched, including paths whose ignore rule was later removed. Oversized files, submodules, nested repositories, and special files are still reported as skipped.

  Older package versions ignore steps whose entries carry the new `ignored_paths` field, so downgrading fails closed instead of misreading them.

## 0.2.4

### Patch Changes

- 0ea1e75: Declare Pi `>=0.99.0` as the peer range for `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-agent-core`, and `pi-tui`, replacing `*`. Installing against an older Pi now warns at install time instead of failing when a package uses an API that Pi release lacks. Pi Utils keeps its Pi peer optional.

## 0.2.3

### Patch Changes

- 2daa891: Bundled troubleshooting Skills no longer appear in the model's system prompt. Each now sets `disable-model-invocation: true`, so installing the package adds no per-turn context and you no longer need `skills` package filters to hide them. To open one, use `/skill:<package>` or a `$<package>` Skill Reference. Packages whose failures the model can see append that package's Skill path to configuration and runtime failures, so the model loads the guide only when one occurs.

## 0.2.2

### Patch Changes

- 1a2e2b9: Remove lint workarounds from package code

## 0.2.1

### Patch Changes

- ba39cb0: Persist Restore undo records in versioned, branch-aware Pi session entries instead of store-local JSON.

## 0.2.0

### Minor Changes

- 706d063: Add package skills that guide Pi through extension configuration and diagnosis.
