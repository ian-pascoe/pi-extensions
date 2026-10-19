---
"@ian-pascoe/pi-guardian": minor
---

Guardian now redacts Secrets held through Pi Secret to their Secret References before reviewing or journaling a call, including in review evidence, and no longer reports their resolution as argument drift, whichever extension loads first. `secret_ask`, `secret_list`, and `secret_forget` are allowed by default.
