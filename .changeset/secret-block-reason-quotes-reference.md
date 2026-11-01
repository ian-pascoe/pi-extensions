---
"@ian-pascoe/pi-secret": patch
---

A blocked call's reason now quotes each Secret Reference as the call wrote it, in either form, instead of always naming the `{{secret:NAME}}` form. A shell expansion is quoted with the `$` or `${` that opens it (`$PI_SECRET_NAME`, `${PI_SECRET_NAME}`). The escape hint gives one example for each form the call used and says what removes the backslash: Pi Secret, or for an expansion the shell, whose own escape Pi Secret leaves as written. A Secret Provider read failure names the reference the same way.
