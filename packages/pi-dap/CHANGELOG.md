# @ian-pascoe/pi-dap

## 0.9.0

### Minor Changes

- b0913f0: `dap_stack` text now collapses each run of two or more Stack Frames that the adapter hints as noise (frame `presentationHint` `subtle` or `label`, or source `presentationHint` `deemphasize`) into one line such as `… 13 deemphasized frames (ids 34–46)`. The ids still work with `dap_variables` and `dap_evaluate`, and `stack_frames` and `total_frames` in `structuredContent` are unchanged.
- 7dbdb70: Debug vscode-js-debug child sessions (worker threads and child processes, such as vitest's `forks` and `threads` pool workers) inside the one Debug Session instead of refusing them. Breakpoints now bind in children. A stop in a child names it in `child_session`, and only one stop is reported at a time: inspection and stepping act on the target that stopped, and a stop that was waiting is reported as soon as that target resumes. `dap_pause` pauses every target. Thread ids are assigned by Pi DAP for vscode-js-debug. `debugger;` statements and exceptions in children now stop instead of being continued automatically. `rejected_child_sessions` now lists only child sessions Pi DAP could not debug.

## 0.8.0

### Minor Changes

- ca658d3: Stop a `vscode-js-debug` Debuggee that starts a worker thread or child process (such as a test runner's forks) from hanging `dap_launch` until the execution timeout. Pi DAP still refuses the child session, but now lets the child run without a debugger and names it in the next `dap_launch`, `dap_continue`, stepping, `dap_pause`, or `dap_status` result (`rejected_child_sessions`), saying that child debugging is unsupported and breakpoints in it will not bind. `dap_launch` also takes `launch_arguments`, adapter launch arguments merged over the Launch Profile's for one launch, for example `autoAttachChildProcesses: false`.

### Patch Changes

- 58a2ce1: Accept `null` for an optional tool parameter as if it were omitted, through the shared `pi-utils` helper; tool schemas the model sees are unchanged.
- f9b48f2: Report the Debuggee `exit_code` for a Node Debug Session through `vscode-js-debug` (which sends no `exited` event): from its root-channel exit report for the default console, or from the process Pi runs for a terminal `console`, and leave it unknown when the adapter does not report one. Also drop a file from `desired_breakpoints` when its breakpoints are set to `[]`.
- Updated dependencies [7ab488c]
- Updated dependencies [eed4468]
- Updated dependencies [58a2ce1]
  - @ian-pascoe/pi-utils@0.6.0

## 0.7.0

### Minor Changes

- 4ef1998: DAP tool rows and the `pi-dap` widget now follow Pi's built-in rendering: `dap_<operation>` headers, ls-length previews for stack and variables, the Expand Hint, an `Elapsed`/`Took` footer, a Status Mark widget row, and `DAP:` notices. Requires Pi `>=1.1.0`.

### Patch Changes

- Updated dependencies [4ef1998]
- Updated dependencies [4ef1998]
  - @ian-pascoe/pi-utils@0.5.0

## 0.6.0

### Minor Changes

- e338194: **Breaking:** Desired Breakpoints now appear only in `dap_set_breakpoints`, `dap_launch`, and `dap_status` results, in their text, structured results, and output schemas. Other DAP tools no longer return `desired_breakpoints`; read it from `dap_status` instead. Descriptions of tools that can fail on the Debug Session state now name the `error` message.

## 0.5.0

### Minor Changes

- 6f0db92: DAP tool results are now compact multi-line text instead of a raw JSON dump, and a stop result names the top Stack Frame's file, line, and function plus the stop description and hit Breakpoint ids, so no separate `dap_stack` call is needed. Desired Breakpoints appear in text only after `dap_set_breakpoints`; `structuredContent` keeps its fields and gains `stop_description`, `hit_breakpoint_ids`, and `top_frame`.

### Patch Changes

- e486153: Debuggee output no longer includes adapter `telemetry` output events such as vscode-js-debug's `js-debug/dap/operation` lines.
- 38200f4: Failed DAP requests such as `dap_evaluate` now report the adapter's error message instead of only pointing at an empty stderr log.
- 697c5d9: Document that `stopOnEntry` with vscode-js-debug re-stops inside a program's first function with reason `entry`, and how `hit breakpoint ids` tell that stop from your breakpoint, in the README and the troubleshooting skill; the README's example profile no longer sets `stopOnEntry`.
- 1236064: `dap_variables` with `frame_id` now lists expensive scopes such as js-debug's Global without expanding them, so locals stay visible without reading a Result Spill, and over-limit text is always cut at line boundaries so the visible part is never empty.

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
