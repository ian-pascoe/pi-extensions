# @ian-pascoe/pi-skills-selector

## 0.1.1

### Patch Changes

- 2daa891: Bundled troubleshooting Skills no longer appear in the model's system prompt. Each now sets `disable-model-invocation: true`, so installing the package adds no per-turn context and you no longer need `skills` package filters to hide them. To open one, use `/skill:<package>` or a `$<package>` Skill Reference. Packages whose failures the model can see append that package's Skill path to configuration and runtime failures, so the model loads the guide only when one occurs.

## 0.1.0

### Minor Changes

- d27b761: Add native `$skill-name` autocomplete and source-preserving Skill document links through Pi's user-input hook, including terminal and RPC `prompt` steering/follow-ups. Document the Pi 0.85.1 limitation for direct RPC `steer` and `follow_up` commands.
