# Terminals live in the Pi process

Pi Termctrl drives Terminals through one in-process `@kitlangton/terminal-control` SDK driver. It keeps Terminals and Background jobs in a registry held in process memory and writes nothing outside the session transcript. The registry is stored under a versioned `globalThis` key so that running Terminals and Background jobs survive `/reload`. If a reload finds a registry version it does not recognize, it stops everything in that registry and does not try to migrate it. Every other `session_shutdown` reason (quit, new, resume, fork) stops everything, because Exit notifications belong to the conversation that started the work.

The registry is shared by every Pi session in the process, including in-process Minimal Subagents child agents. Each Terminal and Background job therefore belongs to the Pi session that started it. Shutdown, Exit notifications and agent-facing tools act only on that session's entries. The human-facing `/ps` panel shows and stops entries from every session in the process, and the cap on live entries applies to the whole process.

termctrl's CLI named sessions (`termctrl start`) would let Terminals outlive Pi entirely. We rejected them because they need external runtime state under `/tmp/termctrl-<uid>`, orphan cleanup, and a CLI wrapper the SDK does not provide.
