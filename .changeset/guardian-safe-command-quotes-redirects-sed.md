---
"@ian-pascoe/pi-guardian": patch
---

Review fewer read-only `bash` commands. The Safe Command parser now reads quotes as bash and `sh` do (only when Pi's `shellPath` is unset, bash, or sh; under any other shell no built-in program is a Safe Command) (single quotes are literal; in double quotes only `$`, backtick, `\`, and `!` are special, so `grep -E "a|b" file` runs unreviewed), accepts the exact stderr redirects `2>/dev/null` and `2>&1`, and treats `sed -n '<address>p' file` as a print-only built-in program.
