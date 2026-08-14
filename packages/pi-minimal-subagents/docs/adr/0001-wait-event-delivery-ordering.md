# Deliver coordination messages through wait events before Pi queues

`subagent_wait` is the synchronization seam between a parent and an active
direct child. When that child sends a Coordination Message to its direct
parent, an active wait resolves with an intermediate Wait Event whose payload
has `event: "message"`. The message is not also sent through Pi's steer queue.
The parent must call `subagent_wait` again to receive the source turn's
terminal Wait Event with `event: "turn"`.

Messages without a matching wait use the recipient queue. Automatic terminal
results reserve their queue position before the delivery grace period, which
prevents a later turn's message from overtaking an earlier result. Tool results
report queue acceptance as `queued`; only the wait handoff is reported as
`delivered-via-wait`.

This keeps the conversation plane ordered while preserving Pi's asynchronous
message API. Delivery evidence remains keyed to terminal source agent and turn
identities, so an intermediate wait message cannot settle a terminal result.
