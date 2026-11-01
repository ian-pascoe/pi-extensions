---
"@ian-pascoe/pi-secret": patch
---

A blocked call's reason now quotes each Secret Reference as the call wrote it, in either form, instead of always naming the `{{secret:NAME}}` form. A shell expansion is quoted with its `$` (`$PI_SECRET_NAME` or `${PI_SECRET_NAME}`), and the escape hint gives one example for each form the call used, so its example for an expansion is the shell's own escape. A Secret Provider read failure names the reference the same way.
