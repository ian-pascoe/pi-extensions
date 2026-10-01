# @ian-pascoe/pi-termctrl

## 0.1.1

### Patch Changes

- 2daa891: Bundled troubleshooting Skills no longer appear in the model's system prompt. Each now sets `disable-model-invocation: true`, so installing the package adds no per-turn context and you no longer need `skills` package filters to hide them. To open one, use `/skill:<package>` or a `$<package>` Skill Reference. Packages whose failures the model can see append that package's Skill path to configuration and runtime failures, so the model loads the guide only when one occurs.

## 0.1.0

### Minor Changes

- cf5ebd5: Add Pi Termctrl: interactive Terminals driven through termctrl (`terminal_start`, `terminal_send`, `terminal_stop`, `terminal_list`), a `bash` replacement whose commands move to the background with `background: true` or Ctrl+B, Exit notifications, and a `/ps` panel with a footer count.
