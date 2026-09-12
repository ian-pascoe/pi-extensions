---
"@ian-pascoe/pi-lsp": patch
---

Register the `lsp` tool with an object-shaped parameter schema so providers that validate tool schemas strictly accept requests.

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
