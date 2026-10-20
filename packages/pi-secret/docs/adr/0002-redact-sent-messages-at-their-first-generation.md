# Redact each message the provider received at the Redaction Generation it was first sent at

Pi Secret scrubs every provider request in the `context` hook, because values can reach messages without passing through a tool result, such as a value the user pastes into the chat. Redacting the whole history again with every value held so far rewrote earlier messages whenever a new value appeared in them, which changed the prompt prefix and discarded the provider's cache. Secret Grants made this common: a grant often reads a value the model has already seen, such as a username in a 1Password item title that `secret_list` returned. Pi Secret therefore records, for each message, the Redaction Generation it was first sent at, and redacts it at that generation on every later request. Messages sent afterwards are redacted with every value held.

## Considered Options

- **Redact the whole history at the current generation**: rejected because the value had already reached the provider in that message, so rewriting it later hides little, and each rewrite costs a full uncached request.
- **Key messages by object identity or timestamp**: rejected because Pi clones the messages for every request, and timestamps can collide. Messages are keyed by a hash of their content instead.

## Consequences

- A value seen before it was held stays in the messages that already carried it, in every later request in that process.
- A message another extension rewrites gets a new hash, so it is redacted at the current generation, like a new message.
- After a restart the records are empty, so every message is redacted at the generation when it is first sent in the new process. That request starts a fresh cache anyway.
