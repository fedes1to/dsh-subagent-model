import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  apply,
  COMMAND_NAME,
  DEFAULT_PROVIDERS,
  hasExplicitRoute,
  normalizeRoute,
  readState,
  USAGE,
  writeState,
} from './index.js'

const workdir = mkdtempSync(join(tmpdir(), 'dsh-subagent-model-'))
let caseSeq = 0
const statePathFor = () => join(workdir, `state-${++caseSeq}.json`)

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
  signal: new AbortController().signal,
  request: { prompt: [{ type: 'text', text: 'do the thing' }], parent },
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

assert.equal(hasExplicitRoute(undefined), false)
assert.equal(hasExplicitRoute({}), false)
assert.equal(hasExplicitRoute({ maxTokens: 100 }), false)
assert.equal(hasExplicitRoute({ provider: 'bifrost' }), true)
assert.equal(hasExplicitRoute({ model: 'x' }), true)

assert.deepEqual(DEFAULT_PROVIDERS, ['spawn'])
assert.equal(COMMAND_NAME, 'subagent-model')
assert.match(USAGE, /set <provider>\/<model>/)

// --- state round-trip -------------------------------------------------------

{
  const path = statePathFor()
  assert.equal(readState(path), undefined)
  writeState(path, { enabled: true, provider: 'bifrost', model: 'anthropic/claude-haiku-5-5' })
  assert.deepEqual(readState(path), { enabled: true, provider: 'bifrost', model: 'anthropic/claude-haiku-5-5' })
  writeFileSync(path, '{not json')
  assert.equal(readState(path), undefined, 'a corrupt file means no choice')
}

// --- stamping ---------------------------------------------------------------

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
  assert.equal(subagents.calls[0].signal, subagents.calls[0].signal, 'the signal travels with the spec')
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
  assert.equal(subagents.calls[0], explicit, 'the caller\'s own spec object is forwarded')
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
  const external = spec({ provider: 'spawn' })
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

// --- Agent Teams and workflow shapes ---------------------------------------

{
  // A teammate: the Lead reserves the child id and passes no route. Stamped.
  const subagents = fakeSubagents()
  const { read } = mount(
    { provider: 'bifrost', model: 'anthropic/claude-haiku-5-5', stateFile: statePathFor() },
    { subagents },
  )
  const teammate = spec({ childId: 'reserved-child', label: 'reviewer' })
  await read('subagents').startActivation(teammate)
  const dispatched = subagents.calls[0]
  assert.equal(dispatched.childId, 'reserved-child', 'the reserved child id survives')
  assert.equal(dispatched.delivery, 'parent')
  assert.deepEqual(dispatched.request.agentOptions, {
    provider: 'bifrost',
    model: 'anthropic/claude-haiku-5-5',
  })
}

{
  // A workflow child: caller delivery, no route. Stamped.
  const subagents = fakeSubagents()
  const { read } = mount({ provider: 'bifrost', model: 'm', stateFile: statePathFor() }, { subagents })
  await read('subagents').startActivation(spec({ delivery: 'caller' }))
  assert.equal(subagents.calls[0].delivery, 'caller')
  assert.deepEqual(subagents.calls[0].request.agentOptions, { provider: 'bifrost', model: 'm' })
}

{
  // A fork-context teammate keeps the Lead's route by default.
  const subagents = fakeSubagents()
  const { read } = mount({ provider: 'bifrost', model: 'm', stateFile: statePathFor() }, { subagents })
  const forkedTeammate = spec({ provider: 'fork', childId: 'reserved-fork' })
  await read('subagents').startActivation(forkedTeammate)
  assert.equal(subagents.calls[0], forkedTeammate)
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
  const { read, commands } = mount({ provider: 'bifrost', model: 'default/model', stateFile }, { subagents, llm })
  assert.equal(commands.length, 1)
  const command = commands[0]
  assert.equal(command.name, 'subagent-model')
  assert.match(command.description, /subagent/i)

  // status (bare and explicit)
  const bare = await command.handler({ rawInput: '' })
  assert.equal(bare.kind, 'success')
  assert.match(bare.text, /bifrost\/default\/model/)
  assert.match(bare.text, /plugin config/)
  assert.match(bare.text, /Usage: \/subagent-model/)

  // set validates and persists
  const set = await command.handler({ rawInput: 'set bifrost/anthropic/claude-haiku-5-5 low' })
  assert.equal(set.kind, 'success', set.text)
  assert.match(set.text, /Route checked/)
  assert.deepEqual(readState(stateFile), {
    enabled: true,
    provider: 'bifrost',
    model: 'anthropic/claude-haiku-5-5',
    reasoningEffort: 'low',
  })
  await read('subagents').startActivation(spec())
  assert.deepEqual(subagents.calls.at(-1).request.agentOptions, {
    provider: 'bifrost',
    model: 'anthropic/claude-haiku-5-5',
    reasoningEffort: 'low',
  })

  // status now reports the persisted choice
  const afterSet = await command.handler({ rawInput: 'status' })
  assert.match(afterSet.text, /anthropic\/claude-haiku-5-5/)
  assert.match(afterSet.text, /effort low/)
  assert.match(afterSet.text, new RegExp(stateFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

  // a rejected route is reported and nothing is written
  const before = readFileSync(stateFile, 'utf8')
  const rejected = await command.handler({ rawInput: 'set bifrost/bad' })
  assert.equal(rejected.kind, 'error')
  assert.match(rejected.text, /Cannot use bifrost\/bad/)
  assert.equal(readFileSync(stateFile, 'utf8'), before)

  // malformed spec
  assert.equal((await command.handler({ rawInput: 'set bifrost' })).kind, 'error')
  assert.equal((await command.handler({ rawInput: 'set /x' })).kind, 'error')
  assert.equal((await command.handler({ rawInput: 'set bifrost/' })).kind, 'error')

  // off stops stamping, and keeps the route for `on`
  const off = await command.handler({ rawInput: 'off' })
  assert.equal(off.kind, 'success')
  assert.deepEqual(readState(stateFile), {
    provider: 'bifrost',
    model: 'anthropic/claude-haiku-5-5',
    reasoningEffort: 'low',
    enabled: false,
  })
  const untouched = spec()
  await read('subagents').startActivation(untouched)
  assert.equal(subagents.calls.at(-1), untouched)

  // on re-enables the persisted route
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
  assert.match(set.text, /Route not checked/)
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
