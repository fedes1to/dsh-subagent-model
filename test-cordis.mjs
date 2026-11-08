/**
 * Integration check against the REAL cordis runtime shipped with dsh.
 *
 * The unit tests use a fake context; this file proves the seam this plugin
 * depends on actually behaves that way in cordis: `internal/get` fires on a
 * service PROPERTY read (`ctx.subagents`), the wrapper it returns is what the
 * caller sees, and the rest of the service still works through the wrapper.
 *
 * cordis is not a dependency of this package, so it is located at run time:
 * `DSH_CORDIS_PATH`, then normal resolution (when it is installed as a peer),
 * then the `dsh` executable on PATH. Skips with exit 0 when none is found.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { apply } from './index.js'

/**
 * Locate the cordis entry point without assuming an install layout.
 * @returns {string | undefined} an absolute path or file URL, or undefined.
 */
function resolveCordis() {
  const override = process.env.DSH_CORDIS_PATH
  if (override !== undefined && override !== '') return override
  try {
    return createRequire(import.meta.url).resolve('@deepseek-ai/cordis')
  } catch {
    // Not installed here: fall through to the dsh executable.
  }
  try {
    const bin =
      process.platform === 'win32'
        ? execFileSync('where', ['dsh'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim()
        : execFileSync('sh', ['-c', 'command -v dsh'], { encoding: 'utf8' }).trim()
    if (bin === '') return undefined
    // Resolve from the launcher's REAL path so a symlinked bin still finds the
    // package's own node_modules.
    return createRequire(realpathSync(bin)).resolve('@deepseek-ai/cordis')
  } catch {
    return undefined
  }
}

const cordisPath = resolveCordis()
if (cordisPath === undefined) {
  console.log('dsh-subagent-model: cordis not found (set DSH_CORDIS_PATH), integration check skipped')
  process.exit(0)
}
const { Context } = await import(pathToFileURL(cordisPath).href)

const calls = []
const fakeSubagents = {
  startActivation(spec) {
    calls.push(spec)
    return Promise.resolve({ childId: `child-${calls.length}` })
  },
  getProvider(providerName) {
    return { name: providerName, capabilities: { agentOptions: true } }
  },
}

const registered = []
const root = new Context()
root.provide('subagents', fakeSubagents)
root.provide('commands', { register: (definition) => (registered.push(definition), () => {}) })

const stateFile = join(mkdtempSync(join(tmpdir(), 'dsh-subagent-model-cordis-')), 'state.json')

await root.plugin({
  name: 'subagent-model',
  apply: (ctx) => apply(ctx, { provider: 'bifrost', model: 'anthropic/claude-haiku-5-5', stateFile }),
})

const parent = { id: 'parent', session: { id: 'parent-session' } }
let seen
await root.plugin({
  name: 'reader',
  inject: ['subagents'],
  apply(ctx) {
    seen = ctx.subagents
  },
})

assert.notEqual(seen, fakeSubagents, 'the property read returns the wrapper')
assert.equal(typeof seen.startActivation, 'function')
assert.equal(seen.getProvider('spawn')?.name, 'spawn', 'the rest of the service still resolves through the wrapper')

await seen.startActivation({
  provider: 'spawn',
  label: 'research',
  delivery: 'parent',
  signal: new AbortController().signal,
  request: { prompt: [{ type: 'text', text: 'go' }], parent },
})
assert.deepEqual(calls[0].request.agentOptions, {
  provider: 'bifrost',
  model: 'anthropic/claude-haiku-5-5',
})

// An explicit route is the caller's authorization.
const explicit = {
  provider: 'spawn',
  label: 'explicit',
  delivery: 'parent',
  signal: new AbortController().signal,
  request: { prompt: [], parent, agentOptions: { provider: 'mistral', model: 'mistral-large-4' } },
}
await seen.startActivation(explicit)
assert.equal(calls[1], explicit)

// fork keeps the parent route by default.
const forked = {
  provider: 'fork',
  label: 'forked',
  delivery: 'parent',
  signal: new AbortController().signal,
  request: { prompt: [], parent },
}
await seen.startActivation(forked)
assert.equal(calls[2], forked)

// The command registered through the plain registry.
assert.equal(registered.length, 1)
assert.equal(registered[0].name, 'subagent-model')
const status = await registered[0].handler({ rawInput: 'status' })
assert.equal(status.kind, 'success')
assert.match(status.text, /bifrost\/anthropic\/claude-haiku-5-5/)

console.log('dsh-subagent-model: cordis integration check passed')
