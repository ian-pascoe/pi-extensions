# @ian-pascoe/pi-dap

## 0.4.1

### Patch Changes

- 671d9b3: `dap_set_breakpoints` now keeps the Desired Breakpoints but warns, in the result text and in `structuredContent.warnings`, when the source file does not exist or is not a file.

## 0.4.0

### Minor Changes

- 3e882f3: **Breaking:** the single `dap` tool is replaced by one tool per operation: `dap_launch`, `dap_set_breakpoints`, `dap_continue`, `dap_next`, `dap_step_in`, `dap_step_out`, `dap_pause`, `dap_stack`, `dap_variables`, `dap_evaluate`, `dap_status`, and `dap_stop`. Each takes only its own arguments, without `operation`, and all of them still act on the same single Debug Session. There is no `dap` alias: rename `dap` wherever you name tools, such as `--tools`, `defaultTools`, Minimal Subagents toolsets (`dap_*` matches them all), and permission rules. Past `dap` calls in older sessions render with Pi's default tool rendering. Requires Pi 0.99.0 or later, the minimum Pi version this repository's packages support.

  All twelve tools are declared to the model and grouped in the `dap` namespace. They carry annotations that permission extensions can use: `dap_stack`, `dap_variables`, and `dap_status` are read-only. Everything that runs the Debuggee's code is destructive and open world: `dap_launch`, `dap_continue`, `dap_next`, `dap_step_in`, `dap_step_out`, and `dap_evaluate`, plus `dap_set_breakpoints`, because a breakpoint `condition` runs as Debuggee code. Pi runs a batch that includes a DAP tool sequentially, in the order the model issued it, and Pi 1.0.0 queues calls that a codemode script starts together the same way.

  Codemode scripts now receive structured results with complete data, including all drained Debuggee output and every Stack Frame, variable, Breakpoint, or evaluation value, instead of the text result. A call rejected because of the Debug Session state, such as `dap_stack` after the Debuggee exited, now returns an error result with the current state instead of throwing, so scripts receive that state with an `error` field.

### Patch Changes

- 0ea1e75: Declare Pi `>=0.99.0` as the peer range for `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-agent-core`, and `pi-tui`, replacing `*`. Installing against an older Pi now warns at install time instead of failing when a package uses an API that Pi release lacks. Pi Utils keeps its Pi peer optional.

## 0.3.7

### Patch Changes

- 2daa891: Bundled troubleshooting Skills no longer appear in the model's system prompt. Each now sets `disable-model-invocation: true`, so installing the package adds no per-turn context and you no longer need `skills` package filters to hide them. To open one, use `/skill:<package>` or a `$<package>` Skill Reference. Packages whose failures the model can see append that package's Skill path to configuration and runtime failures, so the model loads the guide only when one occurs.

## 0.3.6

### Patch Changes

- 1a7c706: Stop declaring an output schema that describes only display details. Pi's built-in `codemode` returns structured results for tools with an output schema, which would hide raw results from scripts; scripts now receive the complete text result as declared.

## 0.3.5

### Patch Changes

- 7b5b785: Fix LSP and DAP startup with `pi --no-session` by using a private OS temporary directory when Pi supplies an empty session directory. Result Spills and stderr files retain their existing permissions and normal teardown cleanup.

## 0.3.4

### Patch Changes

- 981f655: Register the `dap` tool with a flat object parameter schema so strict function-calling providers
  accept requests even when DAP is not used. Keep the strict per-operation validator before permission
  hooks and execution, including the exclusive `variables` selectors. Document each operation's
  required and optional fields in the model-visible tool description, and render incomplete calls
  without requiring validation to have finished.

## 0.3.3

### Patch Changes

- b3e76d2: Move development-only TypeScript and Debug Adapter Protocol types out of production dependencies.

## 0.3.2

### Patch Changes

- 1a2e2b9: Remove lint workarounds from package code

## 0.3.1

### Patch Changes

- 8e665f5: Preserve custom fixed-name tool rendering when Pi reloads extensions.

## 0.3.0

### Minor Changes

- 841a7df: Add bounded CodeMode tool discovery and typed tool result schemas across supporting extensions.

## 0.2.0

### Minor Changes

- 706d063: Add package skills that guide Pi through extension configuration and diagnosis.
