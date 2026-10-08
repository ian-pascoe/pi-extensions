# @ian-pascoe/pi-bible-verses

## 0.6.0

### Minor Changes

- 4ef1998: Raise the Pi peer range to `>=1.1.0`; no UI change.

## 0.5.0

### Minor Changes

- 0ea1e75: These packages now require Pi `>=0.99.0`, raised from an undeclared (`*`) peer range and a documented floor of `0.84.1` or `0.85.1`. Pi 0.99.0 is the first release that provides the tool exposure, output schema, and built-in extension APIs the repository uses, so the packages no longer carry fallbacks for older hosts.

  Advisor no longer probes the Pi SDK for missing exports and methods at load. It no longer pauses with "this Pi runtime lacks ..." diagnostics, because the peer range guarantees those members. Minimal Subagents always gives Child Agents Pi's built-in `codemode`, `tool-search`, and `mcp` extensions instead of skipping any the host lacked. Termctrl's `bash` replacement now requires Pi's `bash` to declare an object `outputSchema`, which Pi provides from 0.99.0, instead of silently falling back to an empty schema.

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
