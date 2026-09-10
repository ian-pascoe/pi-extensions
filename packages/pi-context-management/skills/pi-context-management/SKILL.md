---
name: pi-context-management
description: Configure or diagnose Pi Context Management when Notes or History are missing, Rollover preparation fails, obsolete settings warn, or a native Context Checkpoint does not resume correctly.
license: MIT
---

# Pi Context Management

1. Read [`../../README.md`](../../README.md). Identify the Pi runtime version, capability errors, and global or trusted-project `compaction` settings. Pi owns accounting, automatic triggers, and Tail retention. An obsolete `contextManagement` block is ignored with one warning per session load; it requires no repair before continuing.
2. For missing Notes or History, call `context_notes` with `{"action":"list"}` and `context_history` with `{"action":"windows"}`. Use an item's `context:<source-session>:<entry>` reference with `context_history read`. Classify unavailable references as wrong branch, abandoned sibling, unrelated session, or context-only inheritance; finish when the intended selected-branch state is found or its unavailability is explained.
3. For Rollover trouble, inspect `/context` and the preparation outcome. Normal native automatic/manual compaction requests fresh Notes and Handoff. SDK `compact()` reports native cancellation while asynchronous preparation proceeds; only a committed Context Checkpoint proves completion. Failed, cancelled, or unfinished preparation leaves the conversation intact without repeated nudges. To retry explicitly, use `/rollover`, or update Notes and call `context_rollover` directly as the only tool call with a non-empty Handoff. Nested or batched calls are rejected.
4. For Emergency Rollover, recover recent History and check saved Notes: actual native overflow uses the last saved Handoff, which may be stale or absent. For initial oversized input before any assistant response, shorten the request; Pi cannot durably checkpoint that initial unflushed journal state. Adjust Pi's native settings for timing or retention, rather than restoring removed percentage thresholds or safety margins.
5. For a native compaction conflict, disable the compaction override named in the error; passive listeners and inactive Autoresearch are supported. For checkpoint or journal write failure, fix storage and reopen the persisted session; `/reload` alone is insufficient. Verify acknowledged Notes and the selected checkpoint: a failed append leaves the prior Context Window selected, while a post-append refresh failure preserves the committed checkpoint.
6. Repeat Notes list, History windows, and `/context` inspection. Finish when the selected branch, native usage/settings, and latest Context Checkpoint agree, or report the exact unsupported reference/runtime/failure.

History reads return only recorded entry JSON. Treat unavailable external spills as unavailable rather than reconstructing them.
