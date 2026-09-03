# Pi TPS Tracker

`@ian-pascoe/pi-tps-tracker` reports assistant-output token speed after each Pi agent run.

Requires Node `>=22.19.0` and Pi `>=0.84.1`.

## Install

```bash
pi install npm:@ian-pascoe/pi-tps-tracker
# or from this checkout
pi -e ./src/index.ts
```

The extension measures streamed assistant text, thinking, and tool-call deltas. It shows a waiting `tps` status when an agent starts, replaces it with live rounded throughput while output streams, clears it when the agent ends, and sends an informational final notification. It prefers the provider's **Official Output Count**, falls back to an optional `tiktoken` **Tokenized Output Count**, and finally uses an **Estimated Output Count** of four characters per token.

`tiktoken` is optional. Without it, Pi continues to work and uses provider usage or the estimate. The tokenizer encoder is cached by model for the process lifetime.

There are no user settings.

This is privileged extension code: review it before installing it into an agent that can access local files, tools, or credentials.
