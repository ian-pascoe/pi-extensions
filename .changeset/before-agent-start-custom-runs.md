---
"@ian-pascoe/pi-guardian": patch
"@ian-pascoe/pi-advisor": patch
---

Ignore `before_agent_start` for runs started by a custom message, which Pi 1.2 now reports with `messageType: "custom"`. On Pi 1.2, any Coordination Message, including a sibling's, ended Guardian's Rejection Streak, and every Advisor corrective continuation reset the correction count, so `maxCorrectiveTurns` was never reached.
