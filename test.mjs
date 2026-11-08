import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  apply,
  COMMAND_NAME,
  DEFAULT_PROVIDERS,
  hasExplicitRoute,
  mergeMembers,
  normalizeRoute,
  parseRouteValue,
  readState,
  USAGE,
  writeState,
} from './index.js'

const workdir = mkdtempSync(join(tmpdir(), 'dsh-subagent-model-'))
let caseSeq = 0
const statePathFor = () => join(workdir, `state-${++caseSeq}.json`)
const signal = () => new AbortController().signal

/**
 * Mount the plugin on a fake context and expose the two seams it uses: the
 * `internal/get` waterfall and the command definition.
 */
function mount(config = {}, services = {}) {
  const handlers = new Map()
  const commands = []
  const warnings = []
  const effects = []
  const registry = {
    tuiPluginHost: {
      registerCommand(_ctx, definition) {
        commands.push(definition)
        return () => {}
      },
    },
    ...services,
  }
  const ctx = {
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    effect(fn) {
      effects.push(fn())
    },
    get(serviceName) {
      return registry[serviceName]
    },
    logger: {
      warn(message) {
        warnings.push(message)
      },
      info() {},
    },
  }
  apply(ctx, config)
  /** Read a service the way a caller would: through the waterfall. */
  const read = (serviceName) => {
    const next = () => registry[serviceName]
    const handler = handlers.get('internal/get')
    return handler === undefined ? next() : handler(ctx, serviceName, new Error('read'), next)
  }
  return { ctx, read, commands, warnings, registry }
}

/** A `subagents` stand-in that records every dispatched spec. */
function fakeSubagents({ capabilities = { agentOptions: true }, calls = [] } = {}) {
  return {
    calls,
    getProvider(providerName) {
      return { name: providerName, capabilities }
    },
    startActivation(spec) {
      calls.push(spec)
      return Promise.resolve({ childId: `child-${calls.length}` })
    },
  }
}

const parent = { id: 'parent-agent', session: { id: 'parent-session' } }
const spec = (overrides = {}) => ({
  provider: 'spawn',
  label: 'research',
  delivery: 'parent',
  signal: signal(),
  request: { prompt: [{ type: 'text', text: 'do the thing' }], parent },
  ...overrides,
})

/** A team roster stand-in: `listMembers(lead)` returns `{ id, name, ... }`. */
function fakeTeams(members) {
  return {
    listMembers() {
      return members
    },
  }
}

const lead = { id: 'lead', session: { id: 'lead-session' } }
const teammateSpec = (childId, overrides = {}) =>
  spec({
    childId,
    label: 'red team the change',
    request: { prompt: [{ type: 'text', text: 'break it' }], parent: lead },
    ...overrides,
  })

// --- pure helpers -----------------------------------------------------------

assert.deepEqual(normalizeRoute({ provider: 'bifrost', model: 'a/b' }), { provider: 'bifrost', model: 'a/b' })
assert.deepEqual(normalizeRoute({ provider: ' bifrost ', model: ' a/b ', reasoningEffort: ' low ' }), {
  provider: 'bifrost',
  model: 'a/b',
  reasoningEffort: 'low',
})
assert.equal(normalizeRoute({ provider: 'bifrost' }), undefined)
assert.equal(normalizeRoute({ provider: '', model: 'x' }), undefined)
assert.equal(normalizeRoute(null), undefined)
assert.equal(normalizeRoute('bifrost/x'), undefined)

assert.deepEqual(parseRouteValue('bifrost/anthropic/claude-haiku-5-5'), {
  provider: 'bifrost',
  model: 'anthropic/claude-haiku-5-5',
})
assert.deepEqual(parseRouteValue({ provider: 'b', model: 'm' }), { provider: 'b', model: 'm' })
assert.equal(parseRouteValue('bifrost'), undefined)
assert.equal(parseRouteValue('/x'), undefined)
assert.equal(parseRouteValue('bifrost/'), undefined)
assert.equal(parseRouteValue(''), undefined)

assert.equal(hasExplicitRoute(undefined), false)
assert.equal(hasExplicitRoute({}), false)
assert.equal(hasExplicitRoute({ maxTokens: 100 }), false)
assert.equal(hasExplicitRoute({ provider: 'bifrost' }), true)
assert.equal(hasExplicitRoute({ model: 'x' }), true)

assert.deepEqual(DEFAULT_PROVIDERS, ['spawn'])
assert.equal(COMMAND_NAME, 'subagent-model')
assert.match(USAGE, /set <member>=<provider>\/<model>/)

{
  const base = mergeMembers(new Map(), { adversary: 'b/a', scout: { provider: 'b', model: 'm' } })
  assert.equal(base.size, 2)
  assert.deepEqual(base.get('adversary'), { provider: 'b', model: 'a' })
  mergeMembers(base, { adversary: false, tester: 'b/t' })
  assert.equal(base.has('adversary'), false, 'false removes a mapping')
  assert.equal(base.get('tester').model, 't')
}

// --- state round-trip -------------------------------------------------------

{
  const path = statePathFor()
  assert.equal(readState(path), undefined)
  writeState(path, { enabled: true, provider: 'bifrost', model: 'anthropic/claude-haiku-5-5' })
  assert.deepEqual(readState(path), { enabled: true, provider: 'bifrost', model: 'anthropic/claude-haiku-5-5' })
  writeFileSync(path, '{not json')
  assert.equal(readState(path), undefined, 'a corrupt file means no choice')
}

// --- default route stamping -------------------------------------------------

{
  const subagents = fakeSubagents()
  const { read } = mount({ provider: 'bifrost', model: 'anthropic/claude-haiku-5-5', stateFile: statePathFor() }, { subagents })
  const service = read('subagents')
  assert.notEqual(service, subagents, 'the read value is a wrapper')
  await service.startActivation(spec())
  assert.deepEqual(subagents.calls[0].request.agentOptions, {
    provider: 'bifrost',
    model: 'anthropic/claude-haiku-5-5',
  })
  assert.equal(subagents.calls[0].request.prompt[0].text, 'do the thing', 'the rest of the request is untouched')
  assert.equal(subagents.calls[0].provider, 'spawn')
  assert.equal(subagents.calls[0].label, 'research')
}

{
  const subagents = fakeSubagents()
  const { read } = mount(
    { provider: 'bifrost', model: 'anthropic/claude-haiku-5-5', reasoningEffort: 'low', stateFile: statePathFor() },
    { subagents },
  )
  await read('subagents').startActivation(spec())
  assert.deepEqual(subagents.calls[0].request.agentOptions, {
    provider: 'bifrost',
    model: 'anthropic/claude-haiku-5-5',
    reasoningEffort: 'low',
  })
}

{
  // An explicit route is the caller's authorization: never overridden.
  const subagents = fakeSubagents()
  const { read } = mount({ provider: 'bifrost', model: 'anthropic/claude-haiku-5-5', stateFile: statePathFor() }, { subagents })
  const explicit = spec({ request: { prompt: [], parent, agentOptions: { provider: 'mistral', model: 'mistral-large-4' } } })
  await read('subagents').startActivation(explicit)
  assert.equal(subagents.calls[0], explicit, "the caller's own spec object is forwarded")
  assert.deepEqual(subagents.calls[0].request.agentOptions, { provider: 'mistral', model: 'mistral-large-4' })
}

{
  // A partial agentOptions (maxTokens only) still gets the route, keeping the rest.
  const subagents = fakeSubagents()
  const { read } = mount({ provider: 'bifrost', model: 'm', stateFile: statePathFor() }, { subagents })
  await read('subagents').startActivation(spec({ request: { prompt: [], parent, agentOptions: { maxTokens: 4096 } } }))
  assert.deepEqual(subagents.calls[0].request.agentOptions, { maxTokens: 4096, provider: 'bifrost', model: 'm' })
}

{
  // fork is not stamped by default (a route change breaks its prefix reuse).
  const subagents = fakeSubagents()
  const { read } = mount({ provider: 'bifrost', model: 'm', stateFile: statePathFor() }, { subagents })
  const forked = spec({ provider: 'fork' })
  await read('subagents').startActivation(forked)
  assert.equal(subagents.calls[0], forked)
}

{
  // ...but it can be opted in.
  const subagents = fakeSubagents()
  const { read } = mount(
    { provider: 'bifrost', model: 'm', providers: ['spawn', 'fork'], stateFile: statePathFor() },
    { subagents },
  )
  await read('subagents').startActivation(spec({ provider: 'fork' }))
  assert.deepEqual(subagents.calls[0].request.agentOptions, { provider: 'bifrost', model: 'm' })
}

{
  // A provider without agentOptions support (an external backend) is left alone.
  const subagents = fakeSubagents({ capabilities: { agentOptions: false } })
  const { read } = mount({ provider: 'bifrost', model: 'm', stateFile: statePathFor() }, { subagents })
  const external = spec()
  await read('subagents').startActivation(external)
  assert.equal(subagents.calls[0], external)
}

{
  // No configured route: nothing is stamped.
  const subagents = fakeSubagents()
  const { read } = mount({ stateFile: statePathFor() }, { subagents })
  const untouched = spec()
  await read('subagents').startActivation(untouched)
  assert.equal(subagents.calls[0], untouched)
}

{
  // enabled: false in config is a full no-op.
  const subagents = fakeSubagents()
  const { read } = mount({ enabled: false, provider: 'bifrost', model: 'm', stateFile: statePathFor() }, { subagents })
  const untouched = spec()
  await read('subagents').startActivation(untouched)
  assert.equal(subagents.calls[0], untouched)
}

{
  // A throwing getProvider degrades to the native path instead of failing the dispatch.
  const subagents = fakeSubagents()
  subagents.getProvider = () => {
    throw new Error('reshaped runtime')
  }
  const { read } = mount({ provider: 'bifrost', model: 'm', stateFile: statePathFor() }, { subagents })
  const untouched = spec()
  await read('subagents').startActivation(untouched)
  assert.equal(subagents.calls[0], untouched)
}

{
  // An unregistered provider is not stamped, and the warning is emitted once.
  const subagents = fakeSubagents()
  const llm = { listProviders: () => [{ id: 'mistral', name: 'Mistral' }] }
  const { read, warnings } = mount({ provider: 'nope', model: 'm', stateFile: statePathFor() }, { subagents, llm })
  await read('subagents').startActivation(spec())
  await read('subagents').startActivation(spec())
  assert.equal(subagents.calls[0].request.agentOptions, undefined)
  assert.equal(warnings.filter((line) => line.includes('not registered')).length, 1)
}

{
  // Reads of other services and non-service values pass straight through.
  const subagents = fakeSubagents()
  const { read } = mount({ provider: 'bifrost', model: 'm', stateFile: statePathFor() }, { subagents, other: { a: 1 } })
  assert.deepEqual(read('other'), { a: 1 })
  assert.equal(read('missing'), undefined)
}

// --- per-member routes ------------------------------------------------------

{
  // A teammate's own route wins over the default.
  const subagents = fakeSubagents()
  const agentTeams = fakeTeams([
    { id: 'lead', name: 'lead', role: 'lead', status: 'running' },
    { id: 'teammate-adversary', name: 'adversary', role: 'teammate', status: 'provisioning' },
  ])
  const { read } = mount(
    {
      provider: 'bifrost',
      model: 'anthropic/claude-haiku-5-5',
      members: { adversary: 'bifrost/anthropic/claude-sonnet-5-5' },
      stateFile: statePathFor(),
    },
    { subagents, agentTeams },
  )
  await read('subagents').startActivation(teammateSpec('teammate-adversary'))
  assert.deepEqual(subagents.calls[0].request.agentOptions, {
    provider: 'bifrost',
    model: 'anthropic/claude-sonnet-5-5',
  })
  assert.equal(subagents.calls[0].childId, 'teammate-adversary', 'the reserved child id survives')
}

{
  // An unmapped teammate gets the default route.
  const subagents = fakeSubagents()
  const agentTeams = fakeTeams([{ id: 'teammate-scout', name: 'scout', role: 'teammate', status: 'provisioning' }])
  const { read } = mount(
    {
      provider: 'bifrost',
      model: 'anthropic/claude-haiku-5-5',
      members: { adversary: 'bifrost/anthropic/claude-sonnet-5-5' },
      stateFile: statePathFor(),
    },
    { subagents, agentTeams },
  )
  await read('subagents').startActivation(teammateSpec('teammate-scout'))
  assert.deepEqual(subagents.calls[0].request.agentOptions, {
    provider: 'bifrost',
    model: 'anthropic/claude-haiku-5-5',
  })
}

{
  // A member mapping is explicit intent: it bypasses the fork gate.
  const subagents = fakeSubagents()
  const agentTeams = fakeTeams([{ id: 'teammate-reviewer', name: 'reviewer', role: 'teammate', status: 'provisioning' }])
  const { read } = mount(
    {
      provider: 'bifrost',
      model: 'anthropic/claude-haiku-5-5',
      members: { reviewer: 'bifrost/anthropic/claude-sonnet-5-5' },
      stateFile: statePathFor(),
    },
    { subagents, agentTeams },
  )
  await read('subagents').startActivation(teammateSpec('teammate-reviewer', { provider: 'fork' }))
  assert.deepEqual(subagents.calls[0].request.agentOptions, {
    provider: 'bifrost',
    model: 'anthropic/claude-sonnet-5-5',
  })
}

{
  // off is the master switch: member mappings stop too.
  const subagents = fakeSubagents()
  const agentTeams = fakeTeams([{ id: 'teammate-adversary', name: 'adversary', role: 'teammate', status: 'provisioning' }])
  const stateFile = statePathFor()
  writeState(stateFile, { enabled: false })
  const { read } = mount(
    { provider: 'bifrost', model: 'm', members: { adversary: 'bifrost/strong' }, stateFile },
    { subagents, agentTeams },
  )
  const untouched = teammateSpec('teammate-adversary')
  await read('subagents').startActivation(untouched)
  assert.equal(subagents.calls[0], untouched)
}

{
  // No team service: a teammate-shaped spec still gets the default route.
  const subagents = fakeSubagents()
  const { read } = mount({ provider: 'bifrost', model: 'm', stateFile: statePathFor() }, { subagents })
  await read('subagents').startActivation(teammateSpec('teammate-x'))
  assert.deepEqual(subagents.calls[0].request.agentOptions, { provider: 'bifrost', model: 'm' })
}

{
  // A roster that throws does not break the dispatch.
  const subagents = fakeSubagents()
  const agentTeams = {
    listMembers() {
      throw new Error('roster unavailable')
    },
  }
  const { read } = mount({ provider: 'bifrost', model: 'm', stateFile: statePathFor() }, { subagents, agentTeams })
  await read('subagents').startActivation(teammateSpec('teammate-x'))
  assert.deepEqual(subagents.calls[0].request.agentOptions, { provider: 'bifrost', model: 'm' })
}

{
  // A persisted member route overrides the config mapping.
  const subagents = fakeSubagents()
  const agentTeams = fakeTeams([{ id: 'teammate-adversary', name: 'adversary', role: 'teammate', status: 'provisioning' }])
  const stateFile = statePathFor()
  writeState(stateFile, { enabled: true, members: { adversary: 'bifrost/persisted' } })
  const { read } = mount(
    { provider: 'bifrost', model: 'm', members: { adversary: 'bifrost/from-config' }, stateFile },
    { subagents, agentTeams },
  )
  await read('subagents').startActivation(teammateSpec('teammate-adversary'))
  assert.equal(subagents.calls[0].request.agentOptions.model, 'persisted')
}

// --- command ----------------------------------------------------------------

{
  const stateFile = statePathFor()
  const llm = {
    listProviders: () => [
      { id: 'bifrost', name: 'Bifrost' },
      { id: 'mistral', name: 'Mistral' },
    ],
    listModels: async (provider) => [
      { id: `${provider}/model-a`, name: 'Model A' },
      { id: `${provider}/model-b`, name: 'Model B' },
    ],
    resolveCallConfig: async (route) => {
      if (route.model === 'bad') throw new Error('model "bad" is not registered')
      return route
    },
  }
  const subagents = fakeSubagents()
  const { read, commands } = mount(
    { provider: 'bifrost', model: 'default/model', members: { scout: 'bifrost/cheap' }, stateFile },
    { subagents, llm },
  )
  assert.equal(commands.length, 1)
  const command = commands[0]
  assert.equal(command.name, 'subagent-model')
  assert.match(command.description, /per teammate/)

  // status
  const bare = await command.handler({ rawInput: '' })
  assert.equal(bare.kind, 'success')
  assert.match(bare.text, /Default: bifrost\/default\/model/)
  assert.match(bare.text, /plugin config/)
  assert.match(bare.text, /scout → bifrost\/cheap/)
  assert.match(bare.text, /Default stamped on: spawn/)

  // set the default: validates and persists
  const set = await command.handler({ rawInput: 'set bifrost/anthropic/claude-haiku-5-5 low' })
  assert.equal(set.kind, 'success', set.text)
  assert.match(set.text, /Default subagent model: bifrost\/anthropic\/claude-haiku-5-5/)
  assert.deepEqual(readState(stateFile), {
    enabled: true,
    provider: 'bifrost',
    model: 'anthropic/claude-haiku-5-5',
    reasoningEffort: 'low',
  })

  // set a member route
  const setMember = await command.handler({ rawInput: 'set adversary=bifrost/anthropic/claude-sonnet-5-5' })
  assert.equal(setMember.kind, 'success', setMember.text)
  assert.match(setMember.text, /Teammate "adversary"/)
  assert.deepEqual(readState(stateFile).members, {
    adversary: { provider: 'bifrost', model: 'anthropic/claude-sonnet-5-5' },
  })
  assert.match((await command.handler({ rawInput: 'status' })).text, /adversary → bifrost\/anthropic\/claude-sonnet-5-5/)

  // the default survived the member write
  assert.equal(readState(stateFile).model, 'anthropic/claude-haiku-5-5')

  // unset drops it
  const unset = await command.handler({ rawInput: 'unset adversary' })
  assert.equal(unset.kind, 'success')
  assert.equal(readState(stateFile).members.adversary, false)
  const afterUnset = await command.handler({ rawInput: 'status' })
  assert.doesNotMatch(afterUnset.text, /adversary →/)
  assert.match(afterUnset.text, /scout → bifrost\/cheap/, 'the config mapping is still listed')

  // a rejected route is reported and nothing is written
  const before = readFileSync(stateFile, 'utf8')
  const rejected = await command.handler({ rawInput: 'set bifrost/bad' })
  assert.equal(rejected.kind, 'error')
  assert.match(rejected.text, /Cannot use bifrost\/bad/)
  assert.equal(readFileSync(stateFile, 'utf8'), before)

  // malformed specs
  assert.equal((await command.handler({ rawInput: 'set bifrost' })).kind, 'error')
  assert.equal((await command.handler({ rawInput: 'set /x' })).kind, 'error')
  assert.equal((await command.handler({ rawInput: 'set bifrost/' })).kind, 'error')
  assert.equal((await command.handler({ rawInput: 'set =bifrost/x' })).kind, 'error')
  assert.equal((await command.handler({ rawInput: 'unset' })).kind, 'error')

  // off stops stamping, keeps the routes
  const off = await command.handler({ rawInput: 'off' })
  assert.equal(off.kind, 'success')
  assert.equal(readState(stateFile).enabled, false)
  const untouched = spec()
  await read('subagents').startActivation(untouched)
  assert.equal(subagents.calls.at(-1), untouched)

  // on resumes
  const on = await command.handler({ rawInput: 'on' })
  assert.equal(on.kind, 'success')
  assert.equal(readState(stateFile).enabled, true)
  await read('subagents').startActivation(spec())
  assert.equal(subagents.calls.at(-1).request.agentOptions.model, 'anthropic/claude-haiku-5-5')

  // reset drops the file and falls back to the config default
  const reset = await command.handler({ rawInput: 'reset' })
  assert.equal(reset.kind, 'success')
  assert.equal(readState(stateFile), undefined)
  assert.match(reset.text, /bifrost\/default\/model/)

  // list
  const providers = await command.handler({ rawInput: 'list' })
  assert.match(providers.text, /bifrost — Bifrost/)
  const models = await command.handler({ rawInput: 'list bifrost' })
  assert.match(models.text, /bifrost\/model-a — Model A/)

  // unknown verb
  const unknown = await command.handler({ rawInput: 'wat' })
  assert.equal(unknown.kind, 'error')
  assert.match(unknown.text, /Unknown subcommand "wat"/)
}

{
  // No llm service: set still persists, without claiming a check.
  const stateFile = statePathFor()
  const { commands } = mount({ stateFile }, { subagents: fakeSubagents() })
  const set = await commands[0].handler({ rawInput: 'set bifrost/x' })
  assert.equal(set.kind, 'success')
  assert.equal(readState(stateFile).model, 'x')
  const list = await commands[0].handler({ rawInput: 'list' })
  assert.equal(list.kind, 'error')
}

{
  // No command surface at all: the plugin still stamps, and warns once.
  const { warnings, read } = mount(
    { provider: 'bifrost', model: 'm', stateFile: statePathFor() },
    { tuiPluginHost: null },
  )
  assert.ok(warnings.some((line) => line.includes('/subagent-model is unavailable')))
  assert.equal(read('subagents'), undefined)
}

{
  // A plain `commands` registry is used when the mediated host is absent.
  const registered = []
  const commands = { register: (definition) => (registered.push(definition), () => {}) }
  mount({ provider: 'bifrost', model: 'm', stateFile: statePathFor() }, { tuiPluginHost: null, commands })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'subagent-model')
}

{
  // A throwing mediated registration falls back to the plain registry.
  const registered = []
  const registry = {
    tuiPluginHost: {
      registerCommand() {
        throw new Error('not bound to a declared contribution id')
      },
    },
    commands: { register: (definition) => (registered.push(definition), () => {}) },
  }
  const { warnings } = mount({ provider: 'bifrost', model: 'm', stateFile: statePathFor() }, registry)
  assert.equal(registered.length, 1)
  assert.ok(warnings.some((line) => line.includes('falling back')))
}

console.log('dsh-subagent-model: all checks passed')
