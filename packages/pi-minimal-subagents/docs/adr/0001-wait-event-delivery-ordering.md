# Deliver coordination messages through wait events before Pi queues

`subagent_wait` is the synchronization seam between a parent and an active
direct child. When that child sends a Coordination Message to its direct
parent, an active wait resolves with an intermediate Wait Event whose payload
has `event: "message"`. The message is not also sent through Pi's steer queue.
The parent must call `subagent_wait` again to receive the source turn's
terminal Wait Event with `event: "turn"`. Returning an intermediate message
claims wait delivery for the complete source turn, so later messages cannot
expire into Pi's steer queue while the parent is still following that turn.
Returning the terminal Wait Event also claims terminal delivery and suppresses
the automatic result message.

Messages on turns that have not been claimed by a successful wait use the
recipient queue. Automatic terminal results reserve their queue position before
the delivery grace period, which prevents a later turn's message from
overtaking an earlier result. Fallback delivery pauses while the recipient
conversation is active, keeping that active turn available as a wait-claim
window. Each deferred item retains its original recipient-queue reservation
until the recipient settles or a wait claims it, preserving ordering across
source turns. Held reservations count as coordinator-owned pending work and
drain before reload or fork disposal. Tool results report queue acceptance as
`queued`; only the wait handoff is reported as `delivered-via-wait`.

This keeps the conversation plane ordered while preserving Pi's asynchronous
message API. Delivery evidence remains keyed to terminal source agent and turn
identities, so an intermediate wait message cannot settle a terminal result.
