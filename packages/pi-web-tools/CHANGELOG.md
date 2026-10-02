# @ian-pascoe/pi-web-tools

## 0.2.0

### Minor Changes

- 98b14ae: `web_search` and `web_fetch` now declare an `outputSchema` and return `structuredContent`, so a Pi `codemode` script receives an object instead of text. `web_search` returns `{ provider, content, full_output_path? }`. `web_fetch` returns `{ url, content_type, format, content, truncated, full_output_path? }`. Field names are snake_case, like Pi's `bash` and `pi-termctrl`; persisted `details` keep their existing shape. Scripts cannot read the private spill file, so `content` holds more than the model sees: the Search Provider's complete answer (at most 256 KiB), or the converted page up to 1 MiB, cut on a character boundary with `truncated` set for longer pages. The text the model reads and error behavior are unchanged.

  `web_search` no longer puts the current calendar year in its tool description, so the definition does not change when Pi starts in a new year. Pi appends a one-line result summary to both tool descriptions once.

- bf36a67: `web_search` and `web_fetch` now declare MCP-style tool `annotations`: read-only, non-destructive, idempotent, and open-world. Pi reports them through `pi.getAllTools()`, so permission extensions no longer fall back to the pessimistic defaults for a tool that is not read-only, may be destructive, and may reach an open world. Annotations are not sent to model providers, so tool declarations, the system prompt, and the prompt cache prefix are unchanged.

### Patch Changes

- 0ea1e75: Declare Pi `>=0.99.0` as the peer range for `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-agent-core`, and `pi-tui`, replacing `*`. Installing against an older Pi now warns at install time instead of failing when a package uses an API that Pi release lacks. Pi Utils keeps its Pi peer optional.
- Updated dependencies [0ea1e75]
  - @ian-pascoe/pi-utils@0.3.1

## 0.1.5

### Patch Changes

- 2daa891: Bundled troubleshooting Skills no longer appear in the model's system prompt. Each now sets `disable-model-invocation: true`, so installing the package adds no per-turn context and you no longer need `skills` package filters to hide them. To open one, use `/skill:<package>` or a `$<package>` Skill Reference. Packages whose failures the model can see append that package's Skill path to configuration and runtime failures, so the model loads the guide only when one occurs.

## 0.1.4

### Patch Changes

- be50c8c: Add `stripControlCharacters` to `@ian-pascoe/pi-utils` and use it for transcript text sanitization in Context Management and Web Tools.
- Updated dependencies [be50c8c]
- Updated dependencies [be50c8c]
  - @ian-pascoe/pi-utils@0.3.0

## 0.1.3

### Patch Changes

- b3e76d2: Simplify internal failure handling while preserving credential-safe tool errors, bounded response reads, cancellation, retries, and private output spills.

## 0.1.2

### Patch Changes

- 1a2e2b9: Remove lint workarounds from package code

## 0.1.1

### Patch Changes

- 9b5c7c2: Update dependencies

## 0.1.0

### Minor Changes

- abe75a6: Add bounded Web Search and Web Fetch tools for Pi.
