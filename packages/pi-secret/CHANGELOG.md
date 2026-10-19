# @ian-pascoe/pi-secret

## 0.1.0

### Minor Changes

- 2bda153: Add Pi Secret: `secret_ask` asks the user for Secrets, such as API keys and passwords, in a masked prompt, and the agent uses them through `$PI_SECRET_NAME` and `{{secret:NAME}}` Secret References. Values never reach the model provider, the session file, or the screen. Tool results and provider requests are redacted, including values printed in common encodings such as base64 in an HTTP Basic `Authorization` header. Secrets expire after a configurable Secret Lifetime, and their per-Secret encryption keys are deleted, so the session's encrypted copies can no longer be read.

### Patch Changes

- Updated dependencies [2bda153]
  - @ian-pascoe/pi-utils@0.8.0
