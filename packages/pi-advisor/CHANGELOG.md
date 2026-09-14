# @ian-pascoe/pi-advisor

## 0.3.0

### Minor Changes

- e7a6648: Add non-interrupting Nit findings and configurable multi-finding Reviews with severity-aware deduplication.

## 0.2.0

### Minor Changes

- 9f19c43: Add blocking `advisor_ask` consultations through the existing private Advisor Session, with serialized passive review, accurate backlog accounting, cancellation safety, and dynamic main-agent visibility.

  Preserve CodeMode-only tool requests when another extension changes one registered tool's availability.

## 0.1.0

### Minor Changes

- f27ee9e: Add Pi Advisor review sessions, scoped configuration, safe intervention scheduling, and Minimal Subagents integration. Share native AgentSession discovery through `pi-utils`; refactor CodeMode to use the shared capture helper. Resolve discovery against the running host's SDK class, including bundled CLI startup and reload, rather than a compiled dependency's separate SDK instance. Add native Advisor argument autocomplete for commands, settings keys, and scope flags. Recreate Pi 0.85.1's built-in inline llama.cpp extension from its shipped file so actual CLI reviews settle before and after reload, while unsupported inline resources still fail closed. Recognize both verified native auth-storage class names in Pi's bundled CLI and SDK so file-backed OAuth keeps native refresh and locking rather than being misclassified as custom storage.
