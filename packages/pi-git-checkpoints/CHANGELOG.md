# @ian-pascoe/pi-git-checkpoints

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
