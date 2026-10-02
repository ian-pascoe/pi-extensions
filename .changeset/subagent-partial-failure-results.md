---
"@ian-pascoe/pi-minimal-subagents": minor
---

A partially failed `subagent_delete` and a failed `agent_message` delivery now return an error result that keeps the tool's declared structured output, instead of throwing (`subagent_delete`) or reporting success (`agent_message`). The model still sees an error, and the troubleshooting Skill pointer stays in the error text. Codemode scripts now receive the `deleted_agent_ids`, `trashed_session_files`, and `failures` of a partial deletion, or the `disposition` and `error` of a failed delivery, where a thrown error used to reject the call with no data. The transcript renderer shows the partial deletion's details, including its failures, rather than falling back to plain error text.
