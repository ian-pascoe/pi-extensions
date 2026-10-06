---
"@ian-pascoe/pi-advisor": minor
---

Advisor findings are now fresher, grounded, and fewer. A Review's findings are no longer delivered when the observed agent completed more turns before they arrived; the next Review re-validates them against those newer turns and reports only those that still apply, without an extra model call. Every finding must now name a concrete defect in completed work and cite its evidence, a tool call's short `ref` or a verbatim quote: the default Advisor Prompt asks for this, `advisor_report` requires an `evidence` field, and findings that cite nothing or a `ref` the Advisor was never given are dropped. Advice about what to do next is left to `advisor_ask` consultations. The new `maxNitsPerRequest` setting (default 3) limits the Nits delivered per request; Concerns and Blockers are never capped. `/advisor status` shows findings awaiting re-validation and counts findings dropped over the Nit cap or for missing evidence.
