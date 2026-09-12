---
"@ian-pascoe/pi-dap": patch
---

Register the `dap` tool with a flat object parameter schema so strict function-calling providers
accept requests even when DAP is not used. Keep the strict per-operation validator before permission
hooks and execution, including the exclusive `variables` selectors. Document each operation's
required and optional fields in the model-visible tool description, and render incomplete calls
without requiring validation to have finished.
