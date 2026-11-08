/**
 * dsh-subagent-model — run delegated children on a model of your choosing.
 *
 * Every delegation in dsh funnels through one call: `ctx.subagents.startActivation()`.
 * That covers the `subagent` and `subagent_fork` tools, workflow `agent()`
 * children, and Agent Teams `spawn_teammate` teammates. A child inherits the
 * parent's provider/model unless the activation request carries
 * `request.agentOptions` with a route (`@deepseek-ai/dsh-subagent`
 * `resolveChildAgentOptions` merges it over the parent's values).
 *
 * This plugin wraps the `subagents` service on the documented cordis
 * service-read waterfall (`internal/get`) and stamps that route onto every
 * delegation that does not already name one. A route the caller chose — the
 * model's own `provider`/`model` arguments, a workflow script's `agentOptions`,
 * a configured child default — is treated as authorized and never touched.
 *
 * Why a wrapper and not a config key: the delegation rows live inside the agent
 * presets, so a profile patch cannot reach them, and `spawn_teammate` takes no
 * model argument at all. The service read is the one seam every dispatch path
 * shares.
 *
 * The choice is changeable at runtime with `/subagent-model` and survives a
 * restart (`~/.dsh-tui/subagent-model.json`, the same directory `/model` uses).
 *
 * @module dsh-subagent-model
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Cordis row name. */
export const name = 'subagent-model'

/** The cordis service-read waterfall this plugin registers on. */
export const SEAM_EVENT = 'internal/get'

/** The service the wrapper wraps. */
export const SEAM_SERVICE = 'subagents'

/** Providers stamped by default: fresh children only (fork keeps its prefix). */
export const DEFAULT_PROVIDERS = ['spawn']

/** State file name under `~/.dsh-tui`. */
export const STATE_FILE = 'subagent-model.json'

/** Slash command name, without the leading slash. */
export const COMMAND_NAME = 'subagent-model'

/** What the command accepts, shown in the composer and in every usage error. */
export const USAGE =
  '/subagent-model [status] | set <provider>/<model> [effort] | off | on | reset | list [provider]'

/**
 * Coerce one config or state value into an exact child route.
 * @param {unknown} value - candidate (`{ provider, model, reasoningEffort? }`).
 * @returns {{ provider: string, model: string, reasoningEffort?: string } | undefined} the route.
 */
export function normalizeRoute(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  if (provider === '' || model === '') return undefined
  const effort =
    typeof value.reasoningEffort === 'string' && value.reasoningEffort.trim() !== ''
      ? value.reasoningEffort.trim()
      : undefined
  return { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
}

/**
 * Read a non-empty string list from config, falling back to `fallback`.
 * @param {unknown} value - raw config value.
 * @param {string[]} fallback - value used when the input is unusable.
 * @returns {string[]} the list.
 */
function asStringList(value, fallback) {
  if (!Array.isArray(value)) return [...fallback]
  const list = value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
  return list.length === 0 ? [...fallback] : list
}

/**
 * Render a thrown value as one line.
 * @param {unknown} error - the thrown value.
 * @returns {string} its message.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read the persisted choice. A missing or corrupt file means "no choice".
 * @param {string} path - state file path.
 * @returns {Record<string, unknown> | undefined} the parsed object.
 */
export function readState(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/**
 * Persist the choice atomically (temp file + rename), owner-readable only.
 * @param {string} path - state file path.
 * @param {Record<string, unknown>} value - state to write.
 */
export function writeState(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

/**
 * Whether the activation request already names a route of its own.
 * A partial `agentOptions` (only `maxTokens`, say) does not count.
 * @param {unknown} agentOptions - the request's `agentOptions`.
 * @returns {boolean} true when the caller chose a provider or model.
 */
export function hasExplicitRoute(agentOptions) {
  if (agentOptions === null || typeof agentOptions !== 'object') return false
  return typeof agentOptions.provider === 'string' || typeof agentOptions.model === 'string'
}

/**
 * Wire the plugin.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis context.
 * @param {{
 *   provider?: string,
 *   model?: string,
 *   reasoningEffort?: string,
 *   enabled?: boolean,
 *   providers?: string[],
 *   stateFile?: string,
 * }} [config] - Row config. `provider`/`model` are the deployment default;
 *   the persisted `/subagent-model` choice wins over them.
 */
export function apply(ctx, config = {}) {
  const configRoute = normalizeRoute(config)
  const configEnabled = config.enabled !== false
  const providers = new Set(asStringList(config.providers, DEFAULT_PROVIDERS))
  const statePath =
    typeof config.stateFile === 'string' && config.stateFile !== ''
      ? config.stateFile
      : join(homedir(), '.dsh-tui', STATE_FILE)

  /** Per-run counters for `/subagent-model status`. */
  const stats = { applied: 0, last: undefined }
  let warnedUnknownProvider = false

  /**
   * The route in force right now: persisted choice, else the row config.
   * @returns {{ enabled: boolean, route?: { provider: string, model: string, reasoningEffort?: string }, source: 'state' | 'config' | 'none' }} the effective choice.
   */
  const effective = () => {
    const state = readState(statePath)
    if (state?.enabled === false) return { enabled: false, source: 'state' }
    const fromState = normalizeRoute(state)
    if (fromState !== undefined) return { enabled: true, route: fromState, source: 'state' }
    if (configEnabled && configRoute !== undefined) {
      return { enabled: true, route: configRoute, source: 'config' }
    }
    return { enabled: false, source: 'none' }
  }

  /**
   * Whether one registered provider accepts child `agentOptions`.
   * External backends (ACP, Codex, Claude Code) reject them, so they are left
   * on their native path rather than handed a route they cannot honour.
   * @param {object} service - the live `subagents` service value.
   * @param {string} providerName - provider route name.
   * @returns {boolean} true when a route may be stamped.
   */
  const supportsAgentOptions = (service, providerName) => {
    try {
      if (typeof service.getProvider !== 'function') return false
      const provider = service.getProvider(providerName)
      if (provider === null || provider === undefined) return false
      return provider.capabilities?.agentOptions === true
    } catch {
      return false
    }
  }

  /**
   * Whether the configured provider is registered. Synchronous on purpose: a
   * delegation must not wait on model metadata to start.
   * @param {string} providerId - provider route id.
   * @returns {boolean} true when it is known (or cannot be checked).
   */
  const providerIsRegistered = (providerId) => {
    const llm = ctx.get('llm', false)
    if (llm === null || llm === undefined || typeof llm.listProviders !== 'function') return true
    try {
      return llm.listProviders().some((provider) => provider?.id === providerId)
    } catch {
      return true
    }
  }

  /**
   * Stamp the configured route onto one activation spec, or return it untouched.
   * @param {object} service - the live `subagents` service value.
   * @param {object} spec - the caller's activation spec.
   * @returns {object} the spec to dispatch.
   */
  const stamp = (service, spec) => {
    const choice = effective()
    if (!choice.enabled || choice.route === undefined) return spec
    const request = spec?.request
    if (request === null || typeof request !== 'object') return spec
    if (hasExplicitRoute(request.agentOptions)) return spec
    if (!providers.has(spec.provider)) return spec
    if (!supportsAgentOptions(service, spec.provider)) return spec
    if (!providerIsRegistered(choice.route.provider)) {
      if (!warnedUnknownProvider) {
        warnedUnknownProvider = true
        ctx.logger?.warn?.(
          `subagent-model: provider "${choice.route.provider}" is not registered; delegations keep the parent route`,
        )
      }
      return spec
    }
    const inherited =
      request.agentOptions !== null && typeof request.agentOptions === 'object' ? request.agentOptions : {}
    const agentOptions = {
      ...inherited,
      provider: choice.route.provider,
      model: choice.route.model,
      ...(choice.route.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: choice.route.reasoningEffort }),
    }
    stats.applied += 1
    stats.last = {
      provider: choice.route.provider,
      model: choice.route.model,
      at: Date.now(),
      ...(typeof spec.label === 'string' && spec.label !== '' ? { label: spec.label } : {}),
    }
    return { ...spec, request: { ...request, agentOptions } }
  }

  /**
   * Wrap one `subagents` read value. Anything that is not an activation-capable
   * runtime passes through untouched.
   * @param {unknown} value - the service value the waterfall produced.
   * @returns {unknown} the value the reader receives.
   */
  const wrap = (value) => {
    if (value === null || typeof value !== 'object') return value
    if (typeof value.startActivation !== 'function') return value
    const wrapper = Object.create(value)
    wrapper.startActivation = function startActivation(spec) {
      let effectiveSpec = spec
      try {
        effectiveSpec = stamp(value, spec)
      } catch (error) {
        // The seam is bookkeeping, never part of the dispatch: a failure here
        // must not turn a delegation the runtime would accept into an error.
        ctx.logger?.warn?.(`subagent-model: left a delegation unchanged (${messageOf(error)})`)
      }
      return value.startActivation(effectiveSpec)
    }
    return wrapper
  }

  ctx.on(SEAM_EVENT, (_readCtx, serviceName, _error, next) => {
    const value = next()
    if (serviceName !== SEAM_SERVICE) return value
    try {
      return wrap(value)
    } catch (error) {
      ctx.logger?.warn?.(`subagent-model: service wrapper skipped (${messageOf(error)})`)
      return value
    }
  })

  /** @param {string} text - result body. */
  const success = (text) => ({ kind: 'success', text })
  /** @param {string} text - result body. */
  const failure = (text) => ({ kind: 'error', text })

  /** @returns {string} the status block. */
  const statusText = () => {
    const choice = effective()
    const lines = []
    if (!choice.enabled) {
      lines.push('Subagent model: off — children inherit the parent route.')
      if (choice.source === 'state') lines.push(`Turned off in ${statePath}.`)
    } else {
      const route = choice.route
      const effort = route.reasoningEffort === undefined ? '' : ` · effort ${route.reasoningEffort}`
      const origin = choice.source === 'state' ? statePath : 'plugin config'
      lines.push(`Subagent model: ${route.provider}/${route.model}${effort} (from ${origin})`)
    }
    lines.push(`Stamped on: ${[...providers].join(', ')} · ${stats.applied} delegation(s) remapped this run`)
    if (stats.last !== undefined) {
      const label = stats.last.label === undefined ? '' : ` · ${stats.last.label}`
      lines.push(`Last: ${stats.last.provider}/${stats.last.model}${label}`)
    }
    lines.push(`Usage: ${USAGE}`)
    return lines.join('\n')
  }

  /**
   * `/subagent-model list [provider]`.
   * @param {string | undefined} providerId - provider to expand.
   * @returns {Promise<{ kind: 'success' | 'error', text: string }>} the result.
   */
  const listText = async (providerId) => {
    const llm = ctx.get('llm', false)
    if (llm === null || llm === undefined || typeof llm.listProviders !== 'function') {
      return failure('The llm service is not available in this composition.')
    }
    if (providerId === undefined) {
      const known = llm.listProviders()
      if (known.length === 0) return success('No LLM providers registered.')
      return success(
        [
          'Registered providers:',
          ...known.map((provider) => `  ${provider.id} — ${provider.name}`),
          '',
          `Run /${COMMAND_NAME} list <provider> for its models.`,
        ].join('\n'),
      )
    }
    const models = await llm.listModels(providerId)
    const shown = models.slice(0, 30)
    const lines = shown.map((model) => `  ${model.id}${model.name === model.id ? '' : ` — ${model.name}`}`)
    if (models.length > shown.length) lines.push(`  … ${models.length - shown.length} more`)
    return success([`Models for ${providerId}:`, ...lines].join('\n'))
  }

  /**
   * `/subagent-model set <provider>/<model> [effort]`.
   * @param {string[]} words - the words after `set`.
   * @returns {Promise<{ kind: 'success' | 'error', text: string }>} the result.
   */
  const setText = async (words) => {
    const routeSpec = words[0]
    if (routeSpec === undefined) return failure(`Expected <provider>/<model>.\n${USAGE}`)
    // Model ids carry slashes (`anthropic/claude-haiku-5-5`); provider ids never
    // do, so the FIRST slash separates the two halves.
    const slash = routeSpec.indexOf('/')
    if (slash <= 0 || slash === routeSpec.length - 1) {
      return failure(`Expected <provider>/<model>, got "${routeSpec}".\n${USAGE}`)
    }
    const provider = routeSpec.slice(0, slash)
    const model = routeSpec.slice(slash + 1)
    const effort = words[1]
    const route = { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }

    const llm = ctx.get('llm', false)
    let validated = false
    if (llm !== null && llm !== undefined && typeof llm.resolveCallConfig === 'function') {
      try {
        await llm.resolveCallConfig(route)
        validated = true
      } catch (error) {
        return failure(`Cannot use ${provider}/${model}: ${messageOf(error)}`)
      }
    }
    writeState(statePath, { enabled: true, ...route })
    const effortNote = effort === undefined ? '' : ` · effort ${effort}`
    const check = validated ? 'Route checked against the live adapter.' : 'Route not checked (no llm service).'
    return success(
      `Subagent model: ${provider}/${model}${effortNote}\n${check} Saved to ${statePath}.\nNew delegations use it; children already running keep their route.`,
    )
  }

  /**
   * The `/subagent-model` handler.
   * @param {{ rawInput?: string }} [invocation] - the command invocation.
   * @returns {Promise<{ kind: 'success' | 'error', text: string }>} the result.
   */
  const handler = async (invocation) => {
    const raw = typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim() : ''
    const words = raw === '' ? [] : raw.split(/\s+/)
    const verb = (words[0] ?? 'status').toLowerCase()
    const rest = words.slice(1)
    try {
      if (verb === 'status') return success(statusText())
      if (verb === 'off') {
        // Keep the route so `on` returns to it instead of falling back to config.
        const route = normalizeRoute(readState(statePath))
        writeState(statePath, { ...(route ?? {}), enabled: false })
        return success('Subagent model: off — children inherit the parent route.')
      }
      if (verb === 'on') {
        const state = readState(statePath)
        const route = normalizeRoute(state)
        writeState(statePath, { ...(route ?? {}), enabled: true })
        return success(statusText())
      }
      if (verb === 'reset') {
        try {
          unlinkSync(statePath)
        } catch {
          // Nothing persisted: the config default is already in force.
        }
        return success(`Cleared ${statePath}.\n${statusText()}`)
      }
      if (verb === 'list') return await listText(rest[0])
      if (verb === 'set') return await setText(rest)
      return failure(`Unknown subcommand "${verb}".\n${USAGE}`)
    } catch (error) {
      return failure(`subagent-model: ${messageOf(error)}`)
    }
  }

  const definition = {
    name: COMMAND_NAME,
    description: 'Choose the model delegated subagents and teammates run on',
    input: { hint: 'status | set <provider>/<model> [effort] | off | on | reset | list [provider]' },
    handler,
  }

  /**
   * Register through the mediated surface when the TUI offers it (it stamps the
   * command's owner for the invoke checkpoint), else the plain registry.
   * @returns {(() => void) | undefined} the disposer.
   */
  const registerCommand = () => {
    const host = ctx.get('tuiPluginHost', false)
    if (host !== null && host !== undefined && typeof host.registerCommand === 'function') {
      try {
        return host.registerCommand(ctx, definition)
      } catch (error) {
        ctx.logger?.warn?.(`subagent-model: mediated command registration failed, falling back (${messageOf(error)})`)
      }
    }
    const commands = ctx.get('commands', false)
    if (commands !== null && commands !== undefined && typeof commands.register === 'function') {
      return commands.register(definition)
    }
    ctx.logger?.warn?.('subagent-model: no command service mounted; /subagent-model is unavailable')
    return undefined
  }

  const dispose = registerCommand()
  if (typeof dispose === 'function' && typeof ctx.effect === 'function') {
    ctx.effect(() => () => dispose())
  }
}
