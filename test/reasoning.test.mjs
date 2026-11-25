/**
 * Reasoning-level tests: the deterministic classifier, the effort mapping, the
 * controller's three sources (automatic classification, settings pin, session
 * override, chat-box pick), and the durable reasoning projection.
 *
 * The built ESM modules are imported directly, so the tests exercise the same
 * code the preset mounts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ReasoningController,
  classifyTask,
  higher,
  levelForEffort,
  latestUserTextIn,
  mapEffort,
} from '../lib/reasoning/reasoning.js'
import {
  REASONING_PROJECTION_KEY,
  reasoningProjection,
} from '../lib/projections/reasoning-projection.js'

function user(text) {
  return {
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  }
}

const OPTIONS = {
  defaultMode: 'codex',
  implementWorkerModel: 'deepseek-account/deepseek-flash',
  verifyWorkerModel: 'deepseek-account/deepseek-flash',
  language: 'auto',
  reasoning: 'auto',
  verificationCommands: {},
}

/**
 * Minimal Host stand-in. DSH 0.2.2 exposes the model selection on the Agent
 * (`agent.model`) and the durable reasoning choice through `sessionProjections`.
 */
function makeContext(efforts, reasoningState) {
  const selection = { current: { provider: 'deepseek', model: 'deepseek-chat' } }
  const ctx = {
    get(name) {
      if (name === 'llm') {
        return {
          resolveModelInfo: async () => ({ reasoning: { efforts: efforts.map((id) => ({ id })) } }),
        }
      }
      if (name === 'sessionProjections') {
        return {
          snapshot: (_session, keys) => ({
            asOfSeq: -1,
            values: Object.fromEntries(keys.map((key) => [
              key,
              key === REASONING_PROJECTION_KEY ? reasoningState ?? null : null,
            ])),
          }),
        }
      }
      return undefined
    },
  }
  const model = {
    current: () => ({ ...selection.current }),
    select: (next) => { selection.current = { ...next } },
  }
  return {
    ctx,
    selection,
    controller: (options = OPTIONS) => new ReasoningController(ctx, () => options, {
      turnOf: () => 1,
      planOf: () => [],
    }),
    agentFor: (session) => ({ session, model }),
  }
}

test('the classifier stays low for questions, advice, and single-file scope', () => {
  assert.equal(classifyTask('这个项目支持语言包吗？').level, 'low')
  assert.equal(classifyTask('How should we structure this module?').level, 'low')
  assert.equal(classifyTask('修复 src/a.ts 这个文件里的类型错误').level, 'low')
  assert.equal(classifyTask('').level, 'low')
})

test('the classifier escalates for multi-file, module review, and project scope', () => {
  assert.equal(classifyTask('修改 src/a.ts 和 src/b.ts，共享同一个 mapper').level, 'high')
  assert.equal(classifyTask('review the auth feature module').level, 'high')
  assert.equal(classifyTask('从零搭建一个新项目').level, 'max')
  assert.equal(classifyTask('这个项目一直修不好，找不到原因').level, 'max')
})

test('a large plan escalates to high inside the same turn', () => {
  const plan = Array.from({ length: 6 }, () => ({ status: 'pending' }))
  assert.equal(classifyTask('继续实现', plan).level, 'high')
  assert.equal(higher('low', 'high'), 'high')
  assert.equal(higher('max', 'high'), 'max')
})

test('effort mapping picks the closest supported provider id', () => {
  assert.equal(mapEffort('high', ['low', 'medium', 'high']), 'high')
  assert.equal(mapEffort('low', ['minimal', 'high']), 'minimal')
  assert.equal(mapEffort('max', ['high']), 'high')
  assert.equal(mapEffort('low', []), undefined)
  assert.equal(levelForEffort('xhigh'), 'max')
  assert.equal(levelForEffort('medium'), 'high')
  assert.equal(levelForEffort('minimal'), 'low')
})

test('auto classification writes the level into the model selection', async () => {
  const { controller, agentFor, selection } = makeContext(['low', 'high', 'max'])
  const agent = agentFor({ deriveMessages: () => [user('Fix the failing test')] })
  const choice = await controller().apply(agent)
  assert.equal(choice?.level, 'low')
  assert.equal(selection.current.reasoningEffort, 'low')
})

test('a settings pin fixes every turn and reports itself as manual', async () => {
  const { controller, agentFor, selection } = makeContext(['low', 'high', 'max'])
  const agent = agentFor({ deriveMessages: () => [user('Fix the failing test')] })
  const instance = controller({ ...OPTIONS, reasoning: 'high' })
  const choice = await instance.apply(agent)
  assert.equal(choice?.level, 'high')
  assert.equal(selection.current.reasoningEffort, 'high')
  assert.deepEqual(instance.summary(agent), {
    source: 'manual',
    level: 'high',
    reason: 'pinned by Coding settings',
  })
})

test('a session override wins until it is cleared', async () => {
  const { controller, agentFor } = makeContext(['low', 'high', 'max'])
  const agent = agentFor({ deriveMessages: () => [user('Fix the failing test')] })
  const instance = controller()
  assert.equal(instance.override(agent, 'max').level, 'max')
  await instance.apply(agent)
  assert.equal(instance.summary(agent).reason, 'session override')
  instance.override(agent, 'auto')
  assert.equal(instance.summary(agent).source, 'auto')
})

test('a chat-box pick is honoured instead of the classifier', async () => {
  const { controller, agentFor, selection } = makeContext(
    ['low', 'medium', 'high'],
    { override: null, userEffort: 'medium', running: false },
  )
  const agent = agentFor({
    deriveMessages: () => [user('修改 src/a.ts 和 src/b.ts，共享同一个 mapper')],
  })
  const instance = controller()
  instance.syncProjection(agent)
  const choice = await instance.apply(agent)
  // The classifier would have said high for a two-file request; the explicit
  // chat-box pick keeps its own provider effort.
  assert.equal(choice?.level, 'high')
  assert.equal(choice?.effort, 'medium')
  assert.equal(choice?.reason, 'picked medium in the chat box')
  assert.equal(selection.current.reasoningEffort, 'medium')
})

test('a projection override survives without the in-memory maps', async () => {
  const { controller, agentFor, selection } = makeContext(
    ['low', 'high', 'max'],
    { override: 'max', userEffort: null, running: false },
  )
  const agent = agentFor({ deriveMessages: () => [] })
  const instance = controller()
  instance.syncProjection(agent)
  const choice = await instance.apply(agent)
  assert.equal(choice?.level, 'max')
  assert.equal(selection.current.reasoningEffort, 'max')
})

test('an agent without a model selection still classifies and never throws', async () => {
  const { ctx } = makeContext(['low', 'high', 'max'])
  const instance = new ReasoningController(ctx, () => OPTIONS, { turnOf: () => 0, planOf: () => [] })
  const agent = { session: { deriveMessages: () => [user('Fix the failing test')] } }
  const choice = await instance.apply(agent)
  assert.equal(choice?.level, 'low')
  assert.equal(instance.describe(agent).effort, undefined)
})

test('drop injected context when reading the admitted batch', () => {
  assert.equal(latestUserTextIn([
    user('first'),
    { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'context' }] },
    user('second'),
  ]), 'second')
  assert.equal(latestUserTextIn(null), '')
})

test('the reasoning projection freezes the effort each turn ran under', () => {
  const initial = reasoningProjection.init()
  assert.deepEqual(initial, {
    override: null,
    userEffort: null,
    effort: null,
    running: false,
    latest: 0,
    turns: [],
  })
  const run = (state, event) => reasoningProjection.apply(state, event)

  // Turn 1 runs at low, then closes.
  let state = run(initial, { type: 'turn/start', data: { turn: 1 } })
  state = run(state, { type: 'request/header', data: { header: { config: { reasoningEffort: 'low' } } } })
  assert.equal(state.effort, 'low')
  // The plugin's own automatic write is not a chat-box pick.
  const automatic = run(state, { type: 'model/selection', data: { provider: 'p', model: 'm', reasoningEffort: 'low' } })
  assert.equal(automatic, state)
  state = run(state, { type: 'turn/end', data: { turn: 1 } })
  assert.equal(state.running, false)
  assert.equal(state.latest, 1)
  assert.deepEqual(state.turns, [{ turn: 1, override: null, userEffort: null, effort: 'low' }])

  // Turn 2 runs at high; the two snapshots stay distinct.
  state = run(state, { type: 'turn/start', data: { turn: 2 } })
  state = run(state, { type: 'request/header', data: { header: { config: { reasoningEffort: 'high' } } } })
  state = run(state, { type: 'turn/end', data: { turn: 2 } })
  assert.deepEqual(state.turns, [
    { turn: 1, override: null, userEffort: null, effort: 'low' },
    { turn: 2, override: null, userEffort: null, effort: 'high' },
  ])
  assert.equal(state.latest, 2)
})

test('the reasoning projection records overrides and chat-box picks', () => {
  const initial = reasoningProjection.init()
  const run = (state, event) => reasoningProjection.apply(state, event)

  const pinned = run(initial, { type: 'tool/call', data: { name: 'coding_reasoning', arguments: '{"effort":"max"}' } })
  assert.equal(pinned.override, 'max')
  assert.equal(pinned.userEffort, null)
  assert.equal(run(pinned, { type: 'tool/call', data: { name: 'coding_reasoning', arguments: '{}' } }), pinned)
  assert.equal(run(pinned, { type: 'tool/call', data: { name: 'coding_reasoning', arguments: '{"effort":"auto"}' } }).override, null)

  // A pick made while the session is idle is the user's own choice.
  const picked = run(initial, { type: 'model/selection', data: { provider: 'p', model: 'm', reasoningEffort: 'medium' } })
  assert.equal(picked.userEffort, 'medium')
  assert.equal(picked.override, null)
  // An effort-less selection hands the level back to automatic.
  assert.equal(run(picked, { type: 'model/selection', data: { provider: 'p', model: 'm' } }).userEffort, null)

  // The turn/end snapshot keeps the override that turn ran under.
  const frozen = run(pinned, { type: 'turn/end', data: { turn: 3 } })
  assert.deepEqual(frozen.turns, [{ turn: 3, override: 'max', userEffort: null, effort: null }])
})

test('the reasoning projection validates its persisted value', () => {
  const view = reasoningProjection.wire.view({
    override: 'high',
    userEffort: 'medium',
    effort: 'medium',
    running: false,
    latest: 2,
    turns: [{ turn: 1, override: 'high', userEffort: null, effort: 'high' }],
  })
  assert.deepEqual(reasoningProjection.stateSchema.parse(view), view)
  assert.equal(reasoningProjection.stateVersion, 2)
  assert.throws(() => reasoningProjection.stateSchema.parse({ ...view, override: 'ultra' }))
  assert.throws(() => reasoningProjection.stateSchema.parse({ ...view, running: 'yes' }))
  assert.throws(() => reasoningProjection.stateSchema.parse({ ...view, turns: [{ turn: 1 }] }))
})
