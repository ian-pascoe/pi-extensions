---
name: pi-advisor
description: Diagnose Pi Advisor when reviews are missing, the Advisor is paused, settings are ineffective, backlog waits do not release, or corrective advice is not delivered safely.
license: MIT
---

# Pi Advisor

Use this sequence for a live Advisor problem:

1. Run `/advisor status`. Record the effective settings, each setting's source, review state, backlog, usage/cost, and last error. Treat unknown cost as unknown, not zero.
2. If the state is disabled, check the selected session override, trusted-project settings, and global settings in that order. Advisor defaults to disabled. Use `/advisor on`, `/advisor off`, `/advisor inherit`, or `/advisor set <key> <JSON>` at the intended scope; use `/advisor prompt` for the native prompt editor. Confirm the selected branch after resume, fork, or tree navigation.
3. If the state is paused, read the reported capability or review error. Correct the setting or unavailable runtime capability, then explicitly re-enable or reload as the diagnostic instructs. A pause leaves the observed agent running.
4. For missing reviews, inspect backlog and catch-up configuration. Backlog counts completed model responses with their tool batches, including work under review. `off` never waits; a positive threshold waits only while backlog is at least that threshold, and each wait is capped at 30 seconds. A review has its own deadline and investigative-call limit.
5. If Context Management is loaded, verify that all three private tools—`context_notes`, `context_history`, and `context_rollover`—are explicitly granted. Any missing grant pauses Advisor before review. These tools operate on the Advisor Session's private Notes, History, and Checkpoints; they never grant access to the observed session. Confirm native settlement and checkpoint completion rather than treating an early response or `agent_end` report as completion.
6. For tool or CodeMode failures, compare the effective `allowedTools` list with the loaded registry. Missing names are reported and ignored. CodeMode-only exposure needs an explicitly compatible transport grant; Advisor does not add aliases, autogrant tools, or change exposure mode. A Tool Grant covers the tool's full native interface and is not a filesystem or operation sandbox.
7. For stale, duplicated, or unsafe advice, check branch/session identity and configuration-generation changes. Advisor Sessions are separate persisted native sessions with fresh extension resources. Unsupported opaque inline/custom resources pause rather than being reused. Running work is steered through Pi's native boundary; blockers after normal interactive completion use only tracked, budgeted Corrective Turns. Deliberately interrupted, aborted, uncertain, and headless-completed work is preserved without restart. Child correction must finish inside Minimal's owned operation.
8. On shutdown, allow only the bounded headless final drain. Verify that no hidden corrective turn starts after root completion and that native Advisor resources are aborted before disposal.

Finish when `/advisor status` shows the intended settings and a Review has settled without error: either an attributed finding is visible or Advisor remains silent with zero backlog. If a capability remains unsupported, report the exact diagnostic instead of bypassing native lifecycle or permission policy.
