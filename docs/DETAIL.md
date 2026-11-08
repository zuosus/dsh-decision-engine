A cheap judgement layer for DeepSeek Harness: before the main model acts, a small decision model answers structured questions about the current state, and the call is allowed, escalated, rerouted to a cheaper model, or skipped. All eight decision points are individually switchable; defaults to shadow (record only) and fails open on any error.

Works against any service exposing a decision endpoint: built-in presets (system one / bamboonode / SiliconFlow / Perplexity Decider / OpenRouter) or a custom base URL.

Full documentation: <https://dsh.zuos.us/dsh-decision-engine/>
