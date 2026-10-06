---
"@ian-pascoe/pi-advisor": patch
---

Advisor Reviews and Consultations now receive only what the observed model saw, which makes Advisor prompts much smaller and cheaper. Replay signatures, display-only tool `details`, provider metadata, and native IDs are no longer sent. Each tool call and its result share a short reference, and observed tools are listed by name and one-line summary instead of full descriptions and schemas.
