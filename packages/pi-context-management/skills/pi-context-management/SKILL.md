---
name: pi-context-management
description: Configure or diagnose Pi Context Management when Notes or History are missing, Rollover fails, budget warnings repeat, or a native Context Checkpoint does not resume correctly.
license: MIT
---

# Pi Context Management

1. Read [`../../README.md`](../../README.md), identify the Pi runtime version and any capability-check error, then determine whether `contextManagement` settings come from global or trusted-project scope. Activation depends on runtime capabilities, not an exact version number.
2. Call `context_notes` with `{"action":"list"}` and `context_history` with `{"action":"windows"}`. Finish if both return the intended selected-branch state.
3. For a missing item, use its `context:<source-session>:<entry>` reference with `context_history read`. Classify an unavailable reference as wrong branch, abandoned sibling, unrelated session, or context-only inheritance; the extension opens only entries present on the selected branch.
4. For Rollover trouble, call `/context`, update Notes, then invoke `context_rollover` directly as the only tool call with a non-empty Handoff. A nested or batched call is intentionally rejected. For a native compaction conflict, disable the compaction override from the extension named in the error; passive listeners and inactive Autoresearch are supported.
5. If Context Management reports a checkpoint or journal write failure, fix the storage failure and reopen the persisted session before continuing; `/reload` alone is insufficient. Verify that acknowledged Notes remain present and that the prior Context Window is active.
6. If the first request is too large before any assistant response, shorten it. Pi cannot durably checkpoint that initial unflushed journal state.
7. For early or repeated budget warnings, inspect output reserve, safety margin, static standing context, and effective Tail in `/context`; adjust only the documented settings and reload Pi.
8. Repeat the Notes list, History windows, and `/context` inspection. Finish when the selected branch, budget state, and latest Context Checkpoint agree, or report the exact unsupported reference/runtime/failure.

History reads return only recorded entry JSON. Treat unavailable external spills as unavailable rather than reconstructing them.
