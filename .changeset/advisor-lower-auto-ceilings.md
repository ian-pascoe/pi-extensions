---
"@ian-pascoe/pi-advisor": patch
---

Lower the `auto` ceilings to 100k reported tokens for `maxSessionTokens` and 50k for `seedBudgetTokens` (were 200k and 100k), keeping the seed within half the session and the window-relative scaling below them. Every Review re-reads the whole Advisor Session, and those cache reads were the largest Advisor cost; the lower cap trades more frequent compaction and less verbatim recall of older evidence for cheaper Reviews. Only models with windows above 200k are affected; set explicit values to restore the old sizes.
