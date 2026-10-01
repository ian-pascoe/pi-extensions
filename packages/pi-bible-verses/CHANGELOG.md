# @ian-pascoe/pi-bible-verses

## 0.4.1

### Patch Changes

- 2daa891: Bundled troubleshooting Skills no longer appear in the model's system prompt. Each now sets `disable-model-invocation: true`, so installing the package adds no per-turn context and you no longer need `skills` package filters to hide them. To open one, use `/skill:<package>` or a `$<package>` Skill Reference. Packages whose failures the model can see append that package's Skill path to configuration and runtime failures, so the model loads the guide only when one occurs.

## 0.4.0

### Minor Changes

- 706d063: Add package skills that guide Pi through extension configuration and diagnosis.

## 0.3.0

### Minor Changes

- 3ac2e1b: Remove the undocumented `staticEmbeddingAllowed` field from bible translation records. Translation identity, license attribution, passage text, and picker behavior are unchanged.

## 0.2.0

### Minor Changes

- 00e8819: Remove the undocumented `id`, `book`, and `verseCount` fields from Offline Verse Pool source records. Working Message behavior is unchanged.

### Patch Changes

- 00e8819: Refactor AI overengineering
