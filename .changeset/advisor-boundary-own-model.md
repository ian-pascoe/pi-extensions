---
"@ian-pascoe/pi-advisor": patch
---

An Advisor with its own `model` no longer discards its Advisor Session, or an in-flight Review, when the observed agent changes model. The observed model is tracked only when the Advisor inherits it.
