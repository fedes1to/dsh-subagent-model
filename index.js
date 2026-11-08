/**
 * dsh-subagent-model — run delegated children on a model of your choosing,
 * per teammate when you want it.
 *
 * Every delegation in dsh funnels through one call: `ctx.subagents.startActivation()`.
 * That covers the `subagent` and `subagent_fork` tools, workflow `agent()`
 * children, and Agent Teams `spawn_teammate` teammates. A child inherits the
 * parent's provider/model unless the activation request carries
 * `request.agentOptions` with a route (`@deepseek-ai/dsh-subagent`
 * `resolveChildAgentOptions` merges it over the parent's values).
 *
 * This plugin wraps the `subagents` service on the documented cordis
 * service-read waterfall (`internal/get`) and stamps a route onto every
 * delegation that does not already name one. A route the caller chose — the
 * model's own `provider`/`model` arguments, a workflow script's `agentOptions`,
 * a configured child default — is treated as authorized and never touched.
 *
 * Routes resolve per delegation:
 *
 * 1. `members.<name>` — a teammate's own route. The team journals
 *    `{id: childId, name}` and flushes it BEFORE `startActivation`, so the name
 *    is read from `ctx.agentTeams.listMembers(lead)` by the reserved child id.
 *    A member mapping is explicit intent: it bypasses the `providers` gate.
 * 2. The default route (`provider`/`model` from config or `/subagent-model set`),
 *    applied only to the providers listed in `providers`.
 * 3. Nothing — the child inherits the parent route.
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

/** Providers the DEFAULT route is stamped on (fresh children only). */
export const DEFAULT_PROVIDERS = ['spawn']

/** State file name under `~/.dsh-tui`. */
export const STATE_FILE = 'subagent-model.json'

/** Slash command name, without the leading slash. */
export const COMMAND_NAME = 'subagent-model'

/** What the command accepts, shown in the composer and in every usage error. */
export const USAGE = [
  '/subagent-model [status]',
  '  set <provider>/<model> [effort]        default route for unmapped children',
  '  set <member>=<provider>/<model> [effort]  one teammate (e.g. adversary=...)',
  '  unset <member>                         drop a teammate route',
  '  off | on | reset | list [provider]',
].join('\n')

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
 * Parse a route written either as an object or as `"<provider>/<model>"`.
 * Model ids carry slashes (`anthropic/claude-haiku-5-5`); provider ids never
 * do, so the FIRST slash separates the two halves.
 * @param {unknown} value - config, state, or command value.
 * @returns {{ provider: string, model: string, reasoningEffort?: string } | undefined} the route.
 */
export function parseRouteValue(value) {
  if (typeof value !== 'string') return normalizeRoute(value)
  const text = value.trim()
  if (text === '') return undefined
  const slash = text.indexOf('/')
  if (slash <= 0 || slash === text.length - 1) return undefined
  return { provider: text.slice(0, slash), model: text.slice(slash + 1) }
}

/**
 * Merge a member-route map into `into`. `false`/`null` removes an entry, so a
 * persisted `unset` can override a config mapping.
 * @param {Map<string, object>} into - map to merge into.
 * @param {unknown} value - `{ <member>: route | false }`.
 * @returns {Map<string, object>} `into`.
 */
export function mergeMembers(into, value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return into
  for (const [member, routeValue] of Object.entries(value)) {
    if (routeValue === false || routeValue === null) {
      into.delete(member)
      continue
    }
    const route = parseRouteValue(routeValue)
    if (route !== undefined) into.set(member, route)
  }
  return into
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
 *   members?: Record<string, unknown>,
 *   stateFile?: string,
 * }} [config] - Row config. `provider`/`model` are the default child route;
 *   `members` maps a teammate name to its own route. The persisted
 *   `/subagent-model` choice wins over both.
 */
export function apply(ctx, config = {}) {
  const configRoute = normalizeRoute(config)
  const configEnabled = config.enabled !== false
  const configMembers = mergeMembers(new Map(), config.members)
  const providers = new Set(asStringList(config.providers, DEFAULT_PROVIDERS))
  const statePath =
    typeof config.stateFile === 'string' && config.stateFile !== ''
      ? config.stateFile
      : join(homedir(), '.dsh-tui', STATE_FILE)

  /** Per-run counters for `/subagent-model status`. */
  const stats = { applied: 0, last: undefined }
  let warnedUnknownProvider = false

  /**
   * The teammate name behind one activation, read from the team roster by the
   * reserved child id. The team journals the member and flushes it BEFORE
   * calling `startActivation`, so the row is already there.
   * @param {object} spec - the activation spec.
   * @returns {string | undefined} the teammate name, or undefined for a non-teammate.
   */
  const memberNameOf = (spec) => {
    const childId = spec?.childId
    const parent = spec?.request?.parent
    if (typeof childId !== 'string' || childId === '' || parent === undefined) return undefined
    const teams = ctx.get('agentTeams', false)
    if (teams === null || teams === undefined || typeof teams.listMembers !== 'function') return undefined
    try {
      const member = teams.listMembers(parent).find((candidate) => candidate?.id === childId)
      return typeof member?.name === 'string' && member.name !== '' ? member.name : undefined
    } catch {
      // A roster read that fails is not a routing decision: fall through.
      return undefined
    }
  }

  /**
   * The route in force for one delegation, and where it came from.
   * @param {object} spec - the activation spec.
   * @returns {{ route: { provider: string, model: string, reasoningEffort?: string }, source: string, member: boolean } | undefined} the choice.
   */
  const choiceFor = (spec) => {
    const state = readState(statePath)
    if (state?.enabled === false) return undefined
    const members = mergeMembers(new Map(configMembers), state?.members)
    const memberName = memberNameOf(spec)
    if (memberName !== undefined) {
      const mapped = members.get(memberName)
      if (mapped !== undefined) return { route: mapped, source: `member:${memberName}`, member: true }
    }
    const fromState = normalizeRoute(state)
    if (fromState !== undefined) return { route: fromState, source: 'state', member: false }
    if (configEnabled && configRoute !== undefined) return { route: configRoute, source: 'config', member: false }
    return undefined
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
   * Stamp a route onto one activation spec, or return it untouched.
   * @param {object} service - the live `subagents` service value.
   * @param {object} spec - the caller's activation spec.
   * @returns {object} the spec to dispatch.
   */
  const stamp = (service, spec) => {
    const choice = choiceFor(spec)
    if (choice === undefined) return spec
    const request = spec?.request
    if (request === null || typeof request !== 'object') return spec
    if (hasExplicitRoute(request.agentOptions)) return spec
    // A member mapping is explicit intent; the default route respects the gate.
    if (!choice.member && !providers.has(spec.provider)) return spec
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
      source: choice.source,
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

  /**
   * The effective member map: config first, persisted choices over it.
   * @returns {Map<string, object>} member name → route.
   */
  const effectiveMembers = () => mergeMembers(new Map(configMembers), readState(statePath)?.members)

  /**
   * The effective default route and where it came from.
   * @returns {{ route?: object, source: 'state' | 'config' | 'none' }} the default.
   */
  const effectiveDefault = () => {
    const state = readState(statePath)
    const fromState = normalizeRoute(state)
    if (fromState !== undefined) return { route: fromState, source: 'state' }
    if (configEnabled && configRoute !== undefined) return { route: configRoute, source: 'config' }
    return { source: 'none' }
  }

  /** @returns {string} the status block. */
  const statusText = () => {
    const state = readState(statePath)
    const lines = []
    if (state?.enabled === false) {
      lines.push('Subagent model: off — children inherit the parent route.')
      if (statePath !== '') lines.push(`Turned off in ${statePath}.`)
    } else {
      const fallback = effectiveDefault()
      if (fallback.route === undefined) {
        lines.push('Subagent model: no default — unmapped children inherit the parent route.')
      } else {
        const route = fallback.route
        const effort = route.reasoningEffort === undefined ? '' : ` · effort ${route.reasoningEffort}`
        const origin = fallback.source === 'state' ? statePath : 'plugin config'
        lines.push(`Default: ${route.provider}/${route.model}${effort} (from ${origin})`)
      }
      const members = effectiveMembers()
      if (members.size === 0) {
        lines.push('Members: none — every teammate uses the default.')
      } else {
        lines.push('Members:')
        for (const [member, route] of members) {
          const effort = route.reasoningEffort === undefined ? '' : ` · effort ${route.reasoningEffort}`
          lines.push(`  ${member} → ${route.provider}/${route.model}${effort}`)
        }
      }
      lines.push(`Default stamped on: ${[...providers].join(', ')}`)
    }
    lines.push(`${stats.applied} delegation(s) remapped this run`)
    if (stats.last !== undefined) {
      const label = stats.last.label === undefined ? '' : ` · ${stats.last.label}`
      lines.push(`Last: ${stats.last.provider}/${stats.last.model} (${stats.last.source})${label}`)
    }
    lines.push(`Usage:\n${USAGE}`)
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
   * Validate one route against the live adapter when possible.
   * @param {{ provider: string, model: string, reasoningEffort?: string }} route - candidate.
   * @returns {Promise<string | undefined>} an error message, or undefined when usable.
   */
  const validateRoute = async (route) => {
    const llm = ctx.get('llm', false)
    if (llm === null || llm === undefined || typeof llm.resolveCallConfig !== 'function') return undefined
    try {
      await llm.resolveCallConfig(route)
      return undefined
    } catch (error) {
      return messageOf(error)
    }
  }

  /**
   * `/subagent-model set [<member>=]<provider>/<model> [effort]`.
   * @param {string[]} words - the words after `set`.
   * @returns {Promise<{ kind: 'success' | 'error', text: string }>} the result.
   */
  const setText = async (words) => {
    const target = words[0]
    if (target === undefined) return failure(`Expected <provider>/<model> or <member>=<provider>/<model>.\n${USAGE}`)
    const equals = target.indexOf('=')
    const member = equals > 0 ? target.slice(0, equals) : undefined
    const routeSpec = equals > 0 ? target.slice(equals + 1) : target
    const slash = routeSpec.indexOf('/')
    if (slash <= 0 || slash === routeSpec.length - 1) {
      return failure(`Expected <provider>/<model>, got "${routeSpec}".\n${USAGE}`)
    }
    const provider = routeSpec.slice(0, slash)
    const model = routeSpec.slice(slash + 1)
    const effort = words[1]
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(provider)) {
      return failure(`"${provider}" is not a provider id (letters, digits, dot, dash).\n${USAGE}`)
    }
    if (member !== undefined && !/^[a-z][a-z0-9-]*$/u.test(member)) {
      return failure(`"${member}" is not a teammate name (lower-kebab-case, e.g. adversary).\n${USAGE}`)
    }
    const route = { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }

    const invalid = await validateRoute(route)
    if (invalid !== undefined) return failure(`Cannot use ${provider}/${model}: ${invalid}`)

    const state = readState(statePath) ?? {}
    if (member === undefined) {
      writeState(statePath, { ...state, enabled: true, provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) })
    } else {
      const members = state.members !== null && typeof state.members === 'object' && !Array.isArray(state.members) ? state.members : {}
      writeState(statePath, { ...state, enabled: true, members: { ...members, [member]: route } })
    }
    const effortNote = effort === undefined ? '' : ` · effort ${effort}`
    const scope = member === undefined ? 'Default subagent model' : `Teammate "${member}"`
    return success(
      `${scope}: ${provider}/${model}${effortNote}\nSaved to ${statePath}.\nNew delegations use it; children already running keep their route.`,
    )
  }

  /**
   * `/subagent-model unset <member>`.
   * @param {string | undefined} member - teammate name.
   * @returns {{ kind: 'success' | 'error', text: string }} the result.
   */
  const unsetText = (member) => {
    if (member === undefined) return failure(`Expected a member name.\n${USAGE}`)
    const state = readState(statePath) ?? {}
    const members = state.members !== null && typeof state.members === 'object' && !Array.isArray(state.members) ? state.members : {}
    writeState(statePath, { ...state, members: { ...members, [member]: false } })
    return success(`Teammate "${member}" no longer has its own route; it uses the default.`)
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
        // Keep the routes so `on` returns to them instead of falling back to config.
        const state = readState(statePath) ?? {}
        writeState(statePath, { ...state, enabled: false })
        return success('Subagent model: off — children inherit the parent route.')
      }
      if (verb === 'on') {
        const state = readState(statePath) ?? {}
        writeState(statePath, { ...state, enabled: true })
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
      if (verb === 'unset') return unsetText(rest[0])
      if (verb === 'list') return await listText(rest[0])
      if (verb === 'set') return await setText(rest)
      return failure(`Unknown subcommand "${verb}".\n${USAGE}`)
    } catch (error) {
      return failure(`subagent-model: ${messageOf(error)}`)
    }
  }

  const definition = {
    name: COMMAND_NAME,
    description: 'Choose the model delegated subagents and teammates run on, per teammate if you want',
    input: { hint: 'status | set [<member>=]<provider>/<model> [effort] | unset <member> | off | on | reset | list [provider]' },
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
