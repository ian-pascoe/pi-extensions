---
"pi-adaptive-thinking": patch
---

Replace the `proper-lockfile` dependency with Node's native exclusive-create file lock (`fs.open` `"wx"` plus an asynchronous fixed-delay retry loop preserving the previous 99-retry/20 ms bound and 10-second stale-lock recovery). Settings lock behavior, retries, and notifications are unchanged; the lock file now uses a `.adaptive-thinking.lock` suffix so marker files left by earlier releases cannot block acquisition.
