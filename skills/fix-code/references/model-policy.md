# Role models and prompt overrides

## Resolve at invocation time

Use the active runtime's actual model/tool schema or supported-model listing. Choose models within the user's provider/account; do not change providers, credentials, billing plans, or global defaults. The caller's model need not be the architect: a bounded architectural consultation can use a different model.

1. Parse explicit human overrides first. Then use any project-scoped fix-code role preferences. Otherwise choose the defaults below.
2. Architect/reviewer: highest reasoning capability appropriate to the task while considering standard-speed latency and price. Prefer an efficient frontier coding/reasoning model; reserve an exceptionally expensive tier for work that demonstrably needs it. Start with moderate reasoning and raise effort for difficult architecture or diagnosis.
3. Implementer: the lowest verified effective token price among available models capable of the required coding and tools. Use current published prices or runtime-provided cost tiers where available; include cache behavior when known. If prices are unavailable, use the runtime's documented low-cost coding tier and disclose that the absolute cheapest rate was not established. Never fabricate a model identifier or price.
4. Report the actual models and efforts once before work; note substitutions. Check provider-specific effort compatibility.

As of the initial skill creation, official Codex documentation suggests GPT-6.1 Sol for demanding reasoning and GPT-6 Luna for narrow high-volume work. These are useful starting candidates, not pinned requirements or guarantees of account availability. Claude Code must use its supported Claude model aliases/IDs instead; do not pass GPT IDs to its Agent tool. Select the strongest efficient supported Claude model for architecture and its least expensive capable model for implementation.

## Overrides

Accepted prompt examples (values are explanatory, not executable shell variables):

```text
Use fix-code. architect_model=<available-strong-id>
implementer_model=<available-cheap-id> reviewer_model=<available-review-id>.
Fix the checkout retry bug and create a PR.
```

```text
Use fix-code with model=<available-id> for every role.
```

```text
Use the strongest available model for architecture, but use <available-id>
for implementation. architect_effort=high implementer_effort=medium.
```

Explicit per-role overrides beat an all-role override; an all-role override beats defaults. An explicit human override can deliberately choose a more expensive implementer or the same model for every role. A new override affects future calls, not completed work; do not restart completed units unnecessarily.

Validate every explicit model before its first use. If rejected/unavailable, report that specific incompatibility and ask for a supported replacement while continuing independent read-only preparation. Do not silently substitute an expensive model or pretend the override was honored. Never let a custom-agent file silently override a user's selected model: use a compatible agent or a supported explicit spawn without the conflicting fixed model.

## Runtime execution

- Codex: use the exposed delegation interface with supported explicit model and effort fields. If model overrides require a fresh agent context, give that agent a self-contained brief with relevant file paths and constraints. Do not fork a huge transcript merely to share a few files.
- Claude Code: map roles to supported Agent model/effort parameters or validated custom agents. Do not assume that Codex controls exist. A fixed subagent configuration must not defeat prompt overrides.
- Other hosts: use their documented equivalent. A skill cannot switch models in a runtime that does not expose model choice.

When independent model selection is unavailable, disclose this before bulk implementation. Complete safe inspection/design, then request the specific model/runner change needed. Do not quietly do an entire project on an expensive caller model or claim cheapest-model execution without evidence. If only one supported model is available, say so and obtain a human choice before abandoning an explicit role split.

## Keep the split economical

Most exploration, implementation, checks, and first-pass repairs belong to the implementer. Keep strong-model consultations bounded by a question, diff, and evidence. Do not request a strong-model rewrite of every worker report. Fresh strong review is justified for significant behavior, architecture, security, or concurrency; a tiny obvious fix does not need a panel.

After two evidence-driven repair attempts fail for the same unresolved cause, consult the architect with actual failing commands/output and attempts. Missing credentials, offline tools, or a broken environment are not automatically reasoning failures. Do not pay for a stronger model to repeat those failures.

Prefer standard speed. There is no enforced 20/80 quota: prioritize verified outcomes. Record actual usage if supplied by the runtime; count cached input and reasoning as subsets when the provider schema does. Never estimate hidden reasoning as if measured.

Sources checked during creation:
- https://learn.chatgpt.com/docs/agent-configuration/subagents
- https://learn.chatgpt.com/docs/models
- https://code.claude.com/docs/en/sub-agents
