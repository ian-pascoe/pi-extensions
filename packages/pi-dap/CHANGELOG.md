# @ian-pascoe/pi-dap

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
