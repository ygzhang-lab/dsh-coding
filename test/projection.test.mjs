/**
 * Stage-projection tests: the fold the conversation card reads must carry the
 * mode, stage, plan, and verification through the Session log, freeze each
 * closed Turn, and refuse a malformed persisted value.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CODING_PROJECTION_KEY,
  applyEvent,
  codingProjection,
  initialView,
  isCodingSession,
  parseView,
} from '../lib/projections/coding-projection.js'

/** One whole-value checkpoint as a Coding tool attaches it to `tool/result.meta`. */
function checkpoint(turn, overrides = {}) {
  return {
    v: 1,
    runId: 's:1',
    turn,
    step: 1,
    mode: 'codex',
    stage: 'implement',
    allowedStages: ['requirements', 'plan', 'implement', 'verify', 'deliver'],
    planItems: 3,
    openPlanItems: 1,
    edits: 2,
    updatedAt: 100 + turn,
    ...overrides,
  }
}

test('a session starts active only for the Coding preset at delegation depth 0', () => {
  assert.equal(isCodingSession({ agentPreset: 'dsh-coding' }), true)
  assert.equal(isCodingSession({ agentPreset: 'dsh-coding', delegationDepth: 1 }), false)
  assert.equal(isCodingSession({ agentPreset: 'ptc' }), false)
  assert.equal(isCodingSession(undefined), false)

  const projection = codingProjection(() => 'review')
  assert.equal(projection.key, 'dshCodingStage')
  const active = projection.init({ agentPreset: 'dsh-coding' })
  assert.equal(active.active, true)
  assert.equal(active.mode, 'review')
  assert.deepEqual(active.allowedStages, ['requirements', 'verify', 'deliver'])
  assert.equal(projection.init({ agentPreset: 'ptc' }).active, false)

  const auto = codingProjection(() => 'auto').init({ agentPreset: 'dsh-coding' })
  assert.equal(auto.mode, 'auto')
  assert.deepEqual(auto.allowedStages, ['requirements'])
})

test('switching a live session to the preset resets it to the configured entry state', () => {
  const off = { ...initialView('codex'), active: false }
  const on = applyEvent(off, { type: 'agent-preset/selected', data: { agentPreset: 'dsh-coding' } }, 'consult')
  assert.equal(on.active, true)
  assert.equal(on.mode, 'consult')
  assert.equal(on.stage, 'requirements')
  const back = applyEvent(on, { type: 'agent-preset/selected', data: { agentPreset: 'ptc' } }, 'consult')
  assert.equal(back.active, false)
  assert.equal(applyEvent(on, { type: 'agent-preset/selected', data: { agentPreset: 'dsh-coding' } }, 'consult'), on,
    'an unchanged activation returns the same reference')
})

test('a tool call is pending until its checkpoint arrives', () => {
  let state = { ...initialView('codex'), active: true }
  state = applyEvent(state, {
    type: 'tool/call',
    time: 5,
    data: { turn: 1, step: 1, name: 'coding_stage', arguments: '{"stage":"plan"}' },
  }, 'codex')
  assert.deepEqual(state.pending, { tool: 'coding_stage', requested: 'plan', callId: null })

  const unrelated = applyEvent(state, {
    type: 'tool/call', data: { name: 'bash', arguments: '{}' },
  }, 'codex')
  assert.equal(unrelated, state, 'a non-Coding tool does not move the card')

  state = applyEvent(state, { type: 'tool/result', data: { meta: checkpoint(1) } }, 'codex')
  assert.equal(state.pending, null)
  assert.equal(state.stage, 'implement')
  assert.equal(state.planItems, 3)
  assert.equal(state.edits, 2)
})

test('a result without a checkpoint clears the pending label without inventing state', () => {
  let state = { ...initialView('codex'), active: true }
  state = applyEvent(state, { type: 'tool/call', data: { name: 'coding_mode', arguments: '{"mode":"review"}' } }, 'codex')
  const cleared = applyEvent(state, { type: 'tool/result', data: {} }, 'codex')
  assert.equal(cleared.pending, null)
  assert.equal(cleared.mode, 'codex', 'a refused call changes nothing')
})

test('turn/end freezes the turn and bounds the history', () => {
  let state = { ...initialView('codex'), active: true }
  state = applyEvent(state, { type: 'tool/result', data: { meta: checkpoint(2, { stage: 'verify', verification: { passed: true, kind: 'test', scope: 'targeted', source: 'lead', command: 'pnpm test', exitCode: 0, durationMs: 5, failedTests: [], errors: [], ranAt: 9 } }) } }, 'codex')
  state = applyEvent(state, { type: 'turn/end', data: { turn: 2 } }, 'codex')
  assert.equal(state.latest, 2)
  assert.equal(state.turns.length, 1)
  assert.deepEqual(state.turns[0], {
    turn: 2,
    mode: 'codex',
    stage: 'verify',
    planItems: 3,
    openPlanItems: 1,
    edits: 2,
    // Reduced to what the card renders; exit code and duration are not shown.
    verification: { passed: true, kind: 'test', scope: 'targeted', command: 'pnpm test', failedTests: [], ranAt: 9 },
  })
  assert.equal(parseView(state).turns.length, 1, 'the value round-trips through the validator')

  for (let turn = 3; turn < 80; turn += 1) {
    state = applyEvent(state, { type: 'turn/end', data: { turn } }, 'codex')
  }
  assert.equal(state.turns.length, 60, 'the frozen history is bounded')
  assert.equal(state.latest, 79)
})

test('each closed turn freezes its own plan progress and edit total', () => {
  let state = { ...initialView('codex'), active: true }
  state = applyEvent(state, { type: 'tool/result', data: { meta: checkpoint(1) } }, 'codex')
  state = applyEvent(state, { type: 'turn/end', data: { turn: 1 } }, 'codex')

  // The next turn closes two more plan items and lands more edits.
  state = applyEvent(state, {
    type: 'todo/write',
    time: 12,
    data: {
      todos: [
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'completed' },
        { content: 'c', status: 'in_progress' },
        { content: 'd', status: 'pending' },
        { content: 'e', status: 'pending' },
      ],
    },
  }, 'codex')
  state = applyEvent(state, { type: 'tool/result', data: { meta: checkpoint(2, { planItems: 5, openPlanItems: 2, edits: 9 }) } }, 'codex')
  state = applyEvent(state, { type: 'turn/end', data: { turn: 2 } }, 'codex')

  const [first, second] = state.turns
  assert.deepEqual(
    { planItems: first.planItems, openPlanItems: first.openPlanItems, edits: first.edits },
    { planItems: 3, openPlanItems: 1, edits: 2 },
    'a later turn never rewrites an earlier card',
  )
  assert.deepEqual(
    { planItems: second.planItems, openPlanItems: second.openPlanItems, edits: second.edits },
    { planItems: 5, openPlanItems: 2, edits: 9 },
  )
  assert.deepEqual(parseView(state).turns.map(item => item.edits), [2, 9], 'the frozen numbers survive the validator')
})

test('the validator refuses a frozen turn without its numbers', () => {
  const base = { ...initialView('codex'), active: true, latest: 1 }
  const turn = { turn: 1, mode: 'codex', stage: 'requirements', verification: null, planItems: 1, openPlanItems: 0, edits: 1 }
  assert.deepEqual(parseView({ ...base, turns: [turn] }).turns, [turn])

  const withoutEdits = { ...turn }
  delete withoutEdits.edits
  assert.throws(() => parseView({ ...base, turns: [withoutEdits] }), /turns\.edits/u)
  const withoutPlan = { ...turn }
  delete withoutPlan.planItems
  assert.throws(() => parseView({ ...base, turns: [withoutPlan] }), /turns\.planItems/u)
})

test('the projection carries the checkpoint and the task list for a resume', () => {
  let state = { ...initialView('codex'), active: true }
  state = applyEvent(state, {
    type: 'todo/write',
    time: 7,
    data: {
      todos: [
        { content: 'fix the bug', status: 'in_progress' },
        { content: 'verify it', status: 'pending' },
      ],
    },
  }, 'codex')
  assert.deepEqual(state.plan, [
    { content: 'fix the bug', status: 'in_progress' },
    { content: 'verify it', status: 'pending' },
  ])
  assert.equal(state.planItems, 2)
  assert.equal(state.openPlanItems, 2)

  const cp = checkpoint(1, { stage: 'verify' })
  state = applyEvent(state, { type: 'tool/result', time: 8, data: { meta: cp } }, 'codex')
  assert.deepEqual(state.checkpoint, cp)

  const parsed = parseView(JSON.parse(JSON.stringify(state)))
  assert.deepEqual(parsed.checkpoint, cp, 'the whole checkpoint survives the validator')
  assert.deepEqual(parsed.plan, state.plan)
  assert.equal(codingProjection(() => 'codex').stateVersion, 4)
  assert.throws(
    () => parseView({ ...initialView('codex'), plan: [{ content: 'x', status: 'later' }] }),
    /projection value/u,
  )
  assert.deepEqual(parseView({ ...initialView('codex'), plan: undefined, checkpoint: undefined }).plan, [],
    'a value written before the fields existed defaults to an empty plan')
})

test('a /coding command moves the card before any tool result arrives', () => {
  let state = { ...initialView('codex'), active: true }
  state = applyEvent(state, { type: 'command/run', data: { name: 'coding', args: 'review' } }, 'codex')
  assert.equal(state.mode, 'review')
  assert.deepEqual(state.allowedStages, ['requirements', 'verify', 'deliver'])
  assert.equal(state.stage, 'requirements', 'the entry stage of the narrower mode')

  state = applyEvent(state, { type: 'command/run', data: { name: 'coding', args: 'stage deliver' } }, 'codex')
  assert.equal(state.stage, 'deliver')
  assert.equal(applyEvent(state, { type: 'command/run', data: { name: 'compact', args: '' } }, 'codex'), state)

  // The silent pre-Turn picker path moves the same card state.
  let silent = applyEvent({ ...initialView('codex'), active: true }, {
    type: 'tool/result',
    data: { meta: checkpoint(1, { stage: 'verify' }) },
  }, 'codex')
  silent = applyEvent(silent, { type: 'command/run', data: { name: 'coding', args: 'set consult' } }, 'codex')
  assert.equal(silent.mode, 'consult')
  assert.equal(silent.stage, 'requirements', 'consult does not open verify')
  assert.deepEqual(silent.allowedStages, ['requirements', 'plan', 'deliver'])
})

test('auto mode resolves through a coding command and resets back on auto', () => {
  const start = { ...initialView('auto'), active: true }
  assert.deepEqual(start.allowedStages, ['requirements'])

  const chosen = applyEvent(start, {
    type: 'command/run',
    data: { name: 'coding', args: 'consult' },
  }, 'auto')
  assert.equal(chosen.mode, 'consult')
  assert.equal(chosen.stage, 'requirements')
  assert.deepEqual(chosen.allowedStages, ['requirements', 'plan', 'deliver'])

  const back = applyEvent({ ...chosen, stage: 'deliver' }, {
    type: 'command/run',
    data: { name: 'coding', args: 'set auto' },
  }, 'auto')
  assert.equal(back.mode, 'auto')
  assert.equal(back.stage, 'requirements')
  assert.deepEqual(back.allowedStages, ['requirements'])
  assert.equal(parseView({ ...start, mode: 'auto' }).mode, 'auto')
})

test('the validator refuses a malformed persisted value', () => {
  assert.throws(() => parseView({ active: true }), /projection value/u)
  assert.throws(() => parseView('nope'), /projection value/u)
  const good = {
    ...initialView('codex'),
    active: true,
    latest: 1,
    turns: [{ turn: 1, mode: 'codex', stage: 'requirements', verification: null, planItems: 1, openPlanItems: 0, edits: 1 }],
  }
  assert.deepEqual(parseView(good), good)
  assert.equal(CODING_PROJECTION_KEY, 'dshCodingStage')
})

test('a stage the current mode does not open is not folded', () => {
  const before = { ...initialView('consult'), active: true, stage: 'requirements' }
  const after = applyEvent(before, {
    type: 'command/run',
    data: { name: 'coding', args: 'stage verify' },
  }, 'consult')
  assert.equal(after, before, 'the projection keeps the live stage')
  assert.equal(after.stage, 'requirements')
})

test('a persisted recon value is read back as requirements', () => {
  const state = parseView({
    ...initialView('codex'),
    active: true,
    stage: 'recon',
    allowedStages: ['recon', 'plan', 'implement', 'verify', 'deliver'],
    latest: 1,
    turns: [{ turn: 1, mode: 'codex', stage: 'recon', verification: null, planItems: 1, openPlanItems: 0, edits: 1 }],
  })
  assert.equal(state.stage, 'requirements')
  assert.deepEqual(state.allowedStages, ['requirements', 'plan', 'implement', 'verify', 'deliver'])
  assert.equal(state.turns[0].stage, 'requirements')
})
