---
"@ian-pascoe/pi-advisor": patch
---

Run the Advisor under Pi's standalone binary. That binary bundles the built-in `llama.cpp` extension and ships no file for it, which paused the Advisor with "Pi's built-in llama.cpp file is unavailable". The Advisor now registers a read-only view of the observed `llama.cpp` provider instead: it reads the observed model catalog without refreshing it, and omits `/llama`. Installs from npm still recreate the extension from Pi's shipped file.
