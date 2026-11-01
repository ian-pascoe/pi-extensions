---
"@ian-pascoe/pi-secret": patch
---

A blocked call's reason now quotes each Secret Reference as the call wrote it, in either form, instead of always naming the `{{secret:NAME}}` form. An environment-variable mention such as `PI_SECRET_NAME` is reported as written, and the reason shows how to escape that exact text, so an agent writing about Secrets can find what triggered the block. A Secret Provider read failure names the reference the same way.
