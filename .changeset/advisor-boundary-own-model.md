---
"@ian-pascoe/pi-advisor": patch
---

An Advisor with its own `model` or `thinkingLevel` no longer discards its Advisor Session, or an in-flight Review, when the observed agent changes that field. The observed model and thinking level are tracked independently, and only when the Advisor inherits them.
