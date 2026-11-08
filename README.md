# dsh-subagent-model

A dsh plugin that **runs delegated children on the model you choose** — one
default for everything, or **a different model per Agent Teams teammate**.

```text
default: bifrost/anthropic/claude-haiku-5-5
adversary: bifrost/anthropic/claude-sonnet-5-5

subagent(...)             → haiku
spawn_teammate("scout")   → haiku
spawn_teammate("adversary") → sonnet
workflow agent(...)       → haiku
```

The main agent keeps its own route. Only delegated children are affected.

## Why this exists

dsh gives a child the parent's provider/model unless the delegation names a
route, and the built-in ways to name one are limited:

- the `subagent` tool only exposes `provider`/`model` arguments when the Host's
  `subagent-model-selection` setting is enabled **and** the model decides to use
  them on every call;
- `spawn_teammate` (Agent Teams) has **no model argument at all** — teammates
  always inherit the Lead's route;
- the delegation rows live inside the agent presets, so a profile patch cannot
  reach their config.

This plugin stamps one route onto every delegation that does not already name
one, at the single point every dispatch path shares.

## Install

```sh
dsh plugin --profile dsh-tui add link:/home/fed/Projects/repos/dsh-subagent-model
```

Or from a registry / git checkout:

```sh
dsh plugin --profile dsh-tui add dsh-subagent-model
dsh plugin --profile dsh-tui add git+https://example.com/you/dsh-subagent-model.git
```

The package declares `dsh.bundle.patch`, so `dsh plugin add` also appends it to
`dsh.profile.bundles`. Restart the profile afterwards.

## Configure

The row mounts with an empty config, so **nothing is stamped until you set a
route** — either in the profile's `cordis.patch.yml` (a deployment default) or
once with `/subagent-model` (a user choice that survives restarts).

```yaml
# ~/.dsh/profiles/dsh-tui/cordis.patch.yml
- id: subagent-model
  config:
    provider: bifrost
    model: anthropic/claude-haiku-5-5     # default for unmapped children
    members:                              # one route per teammate, by name
      adversary: bifrost/anthropic/claude-sonnet-5-5
      reviewer: bifrost/anthropic/claude-sonnet-5-5
    # reasoningEffort: low      # optional, adapter-owned
    # providers: [spawn]        # which subagent providers the DEFAULT is stamped on
    # enabled: true             # false = full no-op
```

`members` values take either `"<provider>/<model>"` or
`{ provider, model, reasoningEffort? }`.

| Key | Default | Meaning |
| --- | --- | --- |
| `provider` | — | Child route provider id (a registered `llm` provider, e.g. `bifrost`) |
| `model` | — | Child route model id, exactly as the provider expects it |
| `reasoningEffort` | unset | Adapter-owned effort for the child route |
| `enabled` | `true` | `false` disables stamping entirely |
| `providers` | `['spawn']` | Subagent provider names to stamp. Add `fork` only if you accept losing its inherited-prefix KV cache reuse |
| `members` | `{}` | Teammate name → its own route. Resolved from the team roster by the reserved child id, so it applies to `spawn_teammate` children only |
| `stateFile` | `~/.dsh-tui/subagent-model.json` | Where the `/subagent-model` choice is persisted |

The persisted choice wins over the row config; `reset` drops it and falls back
to the config default.

## Commands

| Command | Effect |
| --- | --- |
| `/subagent-model` | Status: effective route, where it came from, which providers are stamped, how many delegations were remapped this run |
| `/subagent-model set <provider>/<model> [effort]` | Validate the default route against the live adapter, persist it, use it for new delegations |
| `/subagent-model set <member>=<provider>/<model> [effort]` | Give one teammate its own route (e.g. `set adversary=bifrost/anthropic/claude-sonnet-5-5`) |
| `/subagent-model unset <member>` | Drop a teammate route; it falls back to the default |
| `/subagent-model off` | Stop stamping (children inherit the parent route); keeps the route for `on` |
| `/subagent-model on` | Resume with the route saved by the last `set` |
| `/subagent-model reset` | Delete the persisted choice, fall back to the row config |
| `/subagent-model list` | Registered providers |
| `/subagent-model list <provider>` | That provider's advertised models (first 30) |

Model ids may contain slashes (`anthropic/claude-haiku-5-5`); the **first**
slash separates the provider from the model.

## What is and is not overridden

- **Stamp what you configure.** A delegation with no route of its own gets the
  configured one.
- **A teammate mapping wins over the default.** The name comes from the team
  roster (`ctx.agentTeams.listMembers(lead)`), matched by the reserved child id
  the team journals before it spawns. A member mapping is explicit intent, so it
  applies even to a `fork`-context teammate — the `providers` gate only governs
  the default route.
- **An explicit route always wins.** The model's `provider`/`model` arguments (on
  a model-selectable `subagent` tool), a workflow script's `agentOptions`, or a
  configured child default are left byte-for-byte untouched.
- **External backends are never touched.** ACP, Codex and Claude Code reject
  child `agentOptions`; the plugin checks the provider's `agentOptions`
  capability and leaves those dispatches on their native path.
- **`fork` is off by default.** A fork child reuses the parent's request prefix
  for provider-side cache hits; changing its route gives that up. Opt in with
  `providers: ['spawn', 'fork']` when you want it anyway.
- **Running children keep their route.** The choice applies to new delegations;
  a child already running is not switched mid-flight.
- **No `maxTokens` change.** The runtime still merges the parent's output cap. If
  you set an explicit cap on the parent that exceeds the child model's limit,
  lower it — the plugin does not rewrite it.

## How it works

Every delegation — `subagent`, `subagent_fork`, workflow `agent()`, and Agent
Teams `spawn_teammate` — ends in one call:

```js
ctx.subagents.startActivation({ provider, label, request, signal, delivery })
```

and `@deepseek-ai/dsh-subagent` merges `request.agentOptions` over the parent's
route before creating the child. The plugin registers on cordis's documented
service-read waterfall (`internal/get`), wraps the `subagents` **value** on read
(the real service object is never mutated), and stamps `agentOptions` in
`startActivation` before delegating.

For a teammate, `startActivation` carries the reserved `childId` the team
journals (with its name) and flushes **before** spawning. The plugin looks that
id up in the roster, so `members.adversary` resolves without the model having to
pass anything.

Any failure in the wrapper degrades to the native path: a delegation is never
turned into an error by this plugin.

## Tests

```sh
node test.mjs            # hermetic: fake context, config, state, command, edge cases
node test-cordis.mjs     # real cordis: proves the internal/get seam and the wrapper
```

The integration check locates cordis from the `dsh` executable on `PATH` (or
`DSH_CORDIS_PATH`) and skips cleanly when dsh is not installed.

## Limits

- The seam is a service-read wrapper, not a public dsh API. It is the same
  mechanism `dsh-llm-fallbacks` uses in production, but a future dsh release
  could reshape it — the plugin then degrades to "no stamping" rather than
  breaking delegation.
- One route for all delegated children. Per-role or per-tool routes are not
  implemented.
- The choice is per machine, not per session.
