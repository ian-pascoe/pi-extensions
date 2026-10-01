---
"@ian-pascoe/pi-advisor": patch
---

Drop the Pi version gate. Advisor now checks the Pi SDK exports and methods it uses, and verifies after binding that its tool ceiling admits no ungranted tools. An unmet requirement warns the user, hides `advisor_ask`, and leaves the Advisor unavailable or paused with the missing requirements in `/advisor status`, without disrupting the observed session. Advisor pauses also raise a warning notification.
