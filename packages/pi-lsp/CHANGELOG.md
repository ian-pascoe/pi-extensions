# @ian-pascoe/pi-lsp

## 0.4.2

### Patch Changes

- 981f655: Register the `lsp` tool with an object-shaped parameter schema so providers that validate tool schemas strictly accept requests.

  The tool's parameters were a `Type.Union([...])` of 35 per-operation branches. A top-level union
  serialises to `anyOf` with no `type`, and DeepSeek rejects every request while such a tool is
  registered:

  ```
  400 invalid_request_error: Invalid schema for function 'lsp':
  schema must be a JSON Schema of 'type: "object"', got 'type: null'.
  ```

  Because the tool is registered in every request this failed turns that never used the tool at all,
  so the package made Pi unusable on that provider.

  Wrapping the union (for example `{ type: "object", anyOf: [...] }`) is not an option: Pi's
  constrained-sampling helper rejects object and array unions and requires a root schema of
  `type: "object"`, so the registered schema has to be a plain object.

  `LspToolParametersSchema` is unchanged and still the strict per-operation validator applied at the
  tool ingress, so an incomplete or contradictory argument set is still rejected with the existing
  `Pi LSP: invalid tool arguments` failure. A new `LspToolProviderParametersSchema` — a flat object
  whose fields reuse the same per-field schemas — is what Pi now registers and what the model sees. A
  contract test asserts the registered schema is an object and pins it to the validation branches:
  every operation the branches use must be accepted, the two field sets must be equal, and each field
  must reuse the branch schema verbatim, so the two cannot drift.

  The tool description lists the required fields for every operation, derived from the strict
  branches, so models retain argument guidance without reintroducing a top-level union.

## 0.4.1

### Patch Changes

- 1a2e2b9: Remove lint workarounds from package code

## 0.4.0

### Minor Changes

- cbe44d2: Add `/lsp` status and action pickers with stop, enable, and disable shortcuts. Preserve branch-local session enablement across reloads and resumes, support project/global overrides, and safely retire stopped or disabled server processes before lazy startup.

## 0.3.2

### Patch Changes

- 8e665f5: Preserve custom fixed-name tool rendering when Pi reloads extensions.

## 0.3.1

### Patch Changes

- 5cdd3b5: Update dependencies

## 0.3.0

### Minor Changes

- 841a7df: Add bounded CodeMode tool discovery and typed tool result schemas across supporting extensions.

## 0.2.1

### Patch Changes

- 4e356a8: Bump dependencies

## 0.2.0

### Minor Changes

- 706d063: Add package skills that guide Pi through extension configuration and diagnosis.

## 0.1.1

### Patch Changes

- 36785a2: Quarantine invalid server definitions and timeout fields without disabling unrelated valid LSP settings. Exclude formatting-only servers from Post-edit Diagnostics.
