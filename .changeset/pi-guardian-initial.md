---
"@ian-pascoe/pi-guardian": minor
---

Add Pi Guardian: gates every tool call, including calls a `codemode` script issues, with a Tool Policy (`allow`, `review`, or `deny`; read-only tools, ordinary workspace edits, and Safe Commands run without review) and sends the rest to a Guardian Review, one stateless call to a reviewer model that scores the call's Risk Level and User Authorization from Trusted Evidence. A fixed Decision Table allows or rejects the call; a Rejection tells the agent not to work around it and to ask the user, Review Failures never allow a call silently, a Rejection Streak ends the turn, and interactive users can allow a call once. Every review is recorded in the session, `/guardian` opens a settings menu and status, and Minimal Subagents Child Agents and Advisors follow the root session's settings.
