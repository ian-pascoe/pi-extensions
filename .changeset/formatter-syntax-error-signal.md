---
"@ian-pascoe/pi-formatter": minor
---

A File Formatter can now declare how it reports a syntax error with the optional `syntaxErrorPattern` setting, a regular expression tested against its stderr. When set, it replaces the built-in wording heuristic for that formatter: a non-zero exit whose stderr matches drops the troubleshooting Skill pointer, and any other non-zero exit keeps it, while timeouts and spawn errors always keep it. Without the setting, behavior is unchanged. An invalid regular expression, or a pattern on a Workspace Formatter (no `$FILE` in `args`), quarantines the definition with a startup warning. The README gives oxfmt and ruff examples.
