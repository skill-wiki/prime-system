# Add actions and policies

Declare an Action in the owning Model Package. Do not add an engine command or
MCP tool with a handwritten domain schema.

An Action declaration names its typed inputs and output, capability requirements,
side-effect class, idempotency behavior, approval mode, and provider binding.
The deployment registers the provider separately.

## Preflight first

Preflight validates the Request Context, input schema, principal, capabilities,
preconditions, policy, and provider binding. It returns an Effect Plan and any
required approvals without invoking the provider.

Use dry-run for inspection, not as an idempotency reservation. A dry-run must not
consume a key that a later real execution needs.

## Execute and retain evidence

Execution requires an unambiguous tenant/workspace idempotency key. Retries are
bounded and are allowed only when the declared action and provider behavior make
them safe. Timeouts stop the runtime from accepting a late result; providers
that perform external work should also support cancellation where possible.

Store the run, policy and approval provenance, effect evidence, errors, and final
status in the Event Store. A policy exception or authorization failure must
produce an auditable terminal state rather than a stranded run.
