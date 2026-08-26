---
name: pi-tps-tracker
description: Diagnose pi-tps-tracker when live throughput or the final token-speed notice is missing or inaccurate.
license: MIT
---

# Pi TPS Tracker

1. Read [`../../README.md`](../../README.md)'s counting and display behavior.
2. Reproduce with a response long enough to observe streaming.
3. Identify the count source used for that run and compare it with the provider usage or streamed content.
4. Separate counting faults from UI faults by checking status-key ownership and notification visibility.
5. Treat the extension as configuration-free and use its documented fallback when `tiktoken` is absent.
6. Finish when the count source is known and either the display reproduces or one named UI or load boundary explains the symptom.
