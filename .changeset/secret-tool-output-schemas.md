---
"@ian-pascoe/pi-secret": minor
---

**Behavior change for codemode scripts:** `secret_ask`, `secret_ask_grant`, `secret_list`, `secret_save`, and `secret_forget` now declare an `outputSchema`, so a codemode script that calls one receives an object (`{ secrets, available?, notes? }`, the result's details) instead of the model-facing text. Each outcome holds the Secret Name, its status, and how to reference it, never a value. Direct calls are unchanged.
