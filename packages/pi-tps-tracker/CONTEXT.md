# TPS Tracker context

## Glossary

- **Official Output Count**: output-token usage supplied by the model provider on an assistant message. It is the preferred final count.
- **Tokenized Output Count**: a count produced from streamed assistant text by the optional `tiktoken` encoder.
- **Estimated Output Count**: the fallback count derived by dividing streamed character count by four.

The extension reports the selected output count per aggregate streaming time. Its count precedence is Official Output Count, then Tokenized Output Count, then Estimated Output Count.
