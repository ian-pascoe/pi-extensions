# Limit the context Pi accounts against; default it to 400,000 tokens

Many current models declare 1,000,000-token context windows. With Notes, History, and Rollover carrying continuity, letting a Context Window grow that large adds cost per request and dilutes the model's attention without adding needed recall. Pi offers no setting to cap a model's window. Its only override is a per-model-ID `modelOverrides` entry in `models.json`, which has to list every model ID on every provider and goes stale when Pi adds models.

Context Management therefore owns a Context Limit: `contextManagement.maxContextTokens` (a positive integer, default 400,000). When the selected model declares a larger window, the checkpoint adapter shows Pi a copy of the model whose `contextWindow` is the limit. It does this through an accessor on the agent's `state.model`, the one property that every selection path writes and that every reader of the window uses. Pi's own accounting then applies unchanged to the smaller window: usage display, the `reserveTokens` compaction threshold, and overflow detection. The adapter's `prepareRequest` wrapper swaps the declared model back into each of the session's own requests. Pi clamps maximum output to the request model's window, so a limited request would cut replies short near the limit, and Pi treats such a cut-short reply as recoverable overflow: an Emergency Rollover from a possibly stale Handoff, though the real model had room. A trusted project overrides global settings; an invalid value is ignored for that file, with one warning per session load.

This amends [ADR-0002](0002-let-pi-own-compaction-policy.md) without reopening it: Pi still owns accounting, timing, and the threshold arithmetic. The extension supplies the window that arithmetic uses. It adds no percentage thresholds, estimates, or fit checks of its own. A response whose input exceeds the limit counts as a native overflow and takes the Emergency Rollover path, as it would on a model whose real window is that size.

Model catalogs (`/model`, `pi --list-models`) still show the declared window, because the limit applies only to the session's selected model. Other extensions that read `ctx.model` see the limited copy and send it with their own requests, such as Advisor's and Guardian's; their evidence is far smaller than the limit, so the narrower output clamp is accepted rather than patched in each extension. A virtual model's routed physical models are not limited. Disposing the adapter restores the plain property.

Considered and rejected:

- Generating `modelOverrides` for every model: verbose, specific to each provider, and stale after each Pi upgrade.
- Re-registering providers with capped model lists through `pi.registerProvider`: this replaces each provider's whole catalog and conflicts with `models.json` and dynamic model refresh.
- Calling `pi.setModel` with a capped copy: this writes a `model_change` journal entry on every selection, and cycling, resume, and registry refresh would bypass it.
- Raising `compaction.reserveTokens` instead: a reserve gives a fixed limit only for one window size, and it leaves usage display at the declared window.
