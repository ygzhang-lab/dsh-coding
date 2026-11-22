/**
 * Conversation projection tests: the Definition must be able to build a
 * complete capsule from a `tool/result` checkpoint alone, because a paged
 * history window may not contain the matching `tool/call`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { capsuleDefinition, CAPSULE_KIND } from '../lib/client/definition.js'

/** One valid whole-value checkpoint. */
function checkpoint(turn, overrides = {}) {
  return {
    v: 1,
    runId: 'session-1:abc',
    turn,
    step: 1,
    mode: 'codex',
    stage: 'verify',
    allowedStages: ['requirements', 'plan', 'implement', 'verify', 'deliver'],
    planItems: 2,
    openPlanItems: 1,
    edits: 2,
    verification: {
      passed: false,
      kind: 'test',
      scope: 'package',
      source: 'lead',
      command: 'pnpm test',
      exitCode: 1,
      durationMs: 42,
      failedTests: ['adds numbers'],
      errors: ['expected 3'],
      ranAt: 1,
    },
    updatedAt: 1,
    ...overrides,
  }
}

function resultEvent(seq, turn, meta) {
  return {
    type: 'tool/result',
    seq,
    time: 1,
    data: { turn, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [] }, meta },
  }
}

function callEvent(seq, turn, name, args) {
  return { type: 'tool/call', seq, time: 1, data: { turn, step: 1, callId: 'c1', name, arguments: JSON.stringify(args) } }
}

function contextFor(match) {
  return { key: 'k', kind: CAPSULE_KIND, id: 'coding-turn-1', matches: [], start: match, state: undefined, current: new Map() }
}

const LOCATION = { kind: 'session' }
const readerNone = { previous: () => undefined }

test('a tool/result checkpoint alone starts a complete capsule', () => {
  const event = resultEvent(10, 3, checkpoint(3))
  const matched = capsuleDefinition.match(event)
  assert.deepEqual(matched, { id: 'coding-turn-3', role: 'start' })

  const match = { event, role: 'start', location: LOCATION }
  const data = capsuleDefinition.start(contextFor(match), match, readerNone)
  assert.equal(data.partial, false)
  assert.equal(data.stage, 'verify')
  assert.equal(data.checkpoint.verification.passed, false)
  assert.equal(data.pending, undefined)
})

test('a tool/call starts a pending capsule that inherits the previous stage', () => {
  const event = callEvent(4, 2, 'coding_stage', { stage: 'verify' })
  const matched = capsuleDefinition.match(event)
  assert.deepEqual(matched, { id: 'coding-turn-2', role: 'start' })

  const match = { event, role: 'start', location: LOCATION }
  const previous = { state: { ...capsuleDefinition.start({ ...contextFor(match), id: 'coding-turn-1' }, match, readerNone), checkpoint: checkpoint(1) } }
  const reader = { previous: () => previous }
  const data = capsuleDefinition.start(contextFor(match), match, reader)
  assert.equal(data.partial, true)
  assert.equal(data.pending.tool, 'coding_stage')
  assert.equal(data.pending.requested, 'verify')
  assert.equal(data.stage, 'verify', 'the stage is inherited from the previous turn')
  assert.equal(data.checkpoint, undefined)
})

test('the matching tool/result replaces the pending state', () => {
  const call = callEvent(4, 2, 'coding_stage', { stage: 'verify' })
  const match = { event: call, role: 'start', location: LOCATION }
  const start = capsuleDefinition.start(contextFor(match), match, readerNone)
  const context = { ...contextFor(match), state: start }
  const next = capsuleDefinition.update(context, { event: resultEvent(11, 2, checkpoint(2)), role: 'start', location: LOCATION })
  assert.equal(next.partial, false)
  assert.equal(next.pending, undefined)
  assert.equal(next.checkpoint.turn, 2)
})

test('turn/end closes a turn and drops a result-less pending call', () => {
  const call = callEvent(4, 2, 'delegate_implement', {})
  const match = { event: call, role: 'start', location: LOCATION }
  const start = capsuleDefinition.start(contextFor(match), match, readerNone)
  const context = { ...contextFor(match), state: start }
  const endEvent = { type: 'turn/end', seq: 12, time: 1, data: { turn: 2, reason: { kind: 'completed' } } }
  assert.deepEqual(capsuleDefinition.match(endEvent), { id: 'coding-turn-2', role: 'start' })
  const next = capsuleDefinition.update(context, { event: endEvent, role: 'start', location: LOCATION })
  assert.equal(next.pending, undefined)
  assert.equal(next.partial, true)
})

test('buildViewNode materializes a visible Chat node with the Definition identity', () => {
  const event = resultEvent(10, 3, checkpoint(3))
  const match = { event, role: 'start', location: { kind: 'turn', turn: { turn: 3 } } }
  const context = { ...contextFor(match), state: capsuleDefinition.start(contextFor(match), match, readerNone) }
  const node = capsuleDefinition.buildViewNode(context)
  assert.equal(node.kind, 'coding-stage')
  assert.equal(node.target, 'chat')
  assert.equal(node.key, 'k')
  assert.equal(node.anchorSeq, 10)
  assert.equal(node.visibility, 'visible')
  assert.equal(node.data.stage, 'verify')
})

test('a checkpoint from another turn is ignored', () => {
  const event = resultEvent(10, 3, checkpoint(4))
  assert.equal(capsuleDefinition.match(event), null)
})

test('unrelated events never match', () => {
  assert.equal(capsuleDefinition.match({ type: 'assistant/message', seq: 1, time: 1, data: {} }), null)
  assert.equal(capsuleDefinition.match({ type: 'tool/result', seq: 2, time: 1, data: { turn: 1, step: 1, message: {}, meta: { v: 1 } } }), null)
  assert.equal(capsuleDefinition.match(callEvent(3, 1, 'bash', { command: 'ls' })), null)
})
