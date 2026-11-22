/**
 * Stage machine and policy unit tests. These import the built JavaScript the
 * Host actually runs, so a refactor that only compiles is not enough.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  IMPLEMENT_TABLE,
  STAGES_BY_MODE,
  TOOL,
  asCheckpoint,
  asStage,
  entryStage,
  stageAdmits,
  stageInMode,
  toolClass,
} from '../lib/stages.js'
import { makeFailure } from '../lib/failures.js'
import {
  applyMode,
  applyStage,
  checkAdvance,
  checkTool,
  checkpointOf,
  clearRefusal,
  createState,
  recordRefusal,
  recordVerification,
  resetVerification,
  restoreFromView,
  statusLine,
  tableTrim,
} from '../lib/state.js'

/** A fresh session state in one mode. */
function state(mode = 'codex') {
  return createState('session-1', mode)
}

/** A recorded handoff, shaped as `coding_handoff` merges it into the state. */
function handoffOf(goal = 'fix the bug', acceptance = ['the failing test passes']) {
  return {
    version: 1,
    goal,
    constraints: [],
    acceptance,
    findings: [],
    decisions: [],
    open: [],
    tasks: [],
    changes: [],
    updatedAt: Date.now(),
  }
}

/** One verification outcome; a failure unless the overrides say otherwise. */
function outcome(overrides = {}) {
  return {
    passed: false,
    kind: 'test',
    scope: 'package',
    source: 'lead',
    command: 'pnpm test',
    exitCode: 1,
    durationMs: 12,
    failedTests: ['adds numbers'],
    errors: ['expected 3 but got 4'],
    ranAt: Date.now(),
    ...overrides,
  }
}

/** A codex state that already planned, recorded a handoff, and landed an edit. */
function reachedVerify() {
  const current = state()
  current.requirementsObserved = 1
  current.plan = { items: [{ content: 'fix the bug', status: 'in_progress' }], at: Date.now() }
  current.handoff = handoffOf()
  current.edits = 2
  applyStage(current, 'plan', 'test')
  applyStage(current, 'implement', 'test')
  applyStage(current, 'verify', 'test')
  return current
}

test('mode stage sets are fixed', () => {
  assert.deepEqual(STAGES_BY_MODE.auto, ['requirements'])
  assert.deepEqual(STAGES_BY_MODE.consult, ['requirements', 'plan', 'deliver'])
  assert.deepEqual(STAGES_BY_MODE.review, ['requirements', 'verify', 'deliver'])
  assert.deepEqual(STAGES_BY_MODE.codex, ['requirements', 'plan', 'implement', 'verify', 'deliver'])
  assert.equal(entryStage('auto'), 'requirements')
  assert.equal(entryStage('codex'), 'requirements')
})

test('auto mode chooses a workflow from requirements with a non-blocking refusal', () => {
  const current = state('auto')
  const refused = checkAdvance(current, 'plan')
  assert.equal(refused.ok, false)
  assert.equal(refused.soft, true)
  assert.match(refused.reason, /coding_mode/)

  // Choosing a concrete mode keeps requirements and opens that mode's stages.
  assert.equal(applyMode(current, 'consult'), 'requirements')
  assert.equal(checkAdvance(current, 'deliver').ok, true)
})

test('switching back to auto resets a concrete stage to requirements', () => {
  const current = state()
  current.plan = { items: [{ content: 'x', status: 'in_progress' }], at: Date.now() }
  applyStage(current, 'implement', 'test')
  assert.equal(applyMode(current, 'auto'), 'requirements')
})

test('plan stage denies apply_patch with an actionable reason', () => {
  const current = state()
  current.requirementsObserved = 2
  current.handoff = handoffOf()
  const check = checkAdvance(current, 'plan')
  assert.equal(check.ok, true)
  applyStage(current, 'plan', 'test')

  const verdict = checkTool(current, 'apply_patch')
  assert.ok(verdict.deny, 'apply_patch must be denied in plan')
  assert.match(verdict.deny, /not available in the plan stage/)
  assert.match(verdict.deny, /delegate_implement/)
  // The denial is a rule, not a question: no ask branch exists in this API.
  assert.equal('ask' in verdict, false)
})

test('unknown third-party tools are not blocked by the stage gate', () => {
  const current = state()
  applyStage(current, 'plan', 'test')
  assert.equal(checkTool(current, 'some_plugin_tool').deny, undefined)
  assert.equal(toolClass('some_plugin_tool'), undefined)
})

test('implement gate requires a structured task list', () => {
  const current = state()
  current.handoff = handoffOf()
  const refused = checkAdvance(current, 'implement')
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /todo_write/)

  current.plan = { items: [{ content: 'do the thing', status: 'in_progress' }], at: Date.now() }
  assert.equal(checkAdvance(current, 'implement').ok, true)
})

test('verify gate requires a landed worker edit', () => {
  const current = state()
  current.plan = { items: [{ content: 'x', status: 'in_progress' }], at: Date.now() }
  current.handoff = handoffOf()
  applyStage(current, 'plan', 'test')
  applyStage(current, 'implement', 'test')
  const refused = checkAdvance(current, 'verify')
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /delegate_implement/)

  current.edits = 2
  assert.equal(checkAdvance(current, 'verify').ok, true)
})

test('deliver is refused while the last verification failed', () => {
  const current = state()
  current.plan = { items: [{ content: 'x', status: 'in_progress' }], at: Date.now() }
  current.handoff = handoffOf()
  current.edits = 1
  applyStage(current, 'verify', 'test')
  current.verification = {
    passed: false,
    kind: 'test',
    scope: 'package',
    source: 'lead',
    command: 'pnpm test',
    exitCode: 1,
    durationMs: 12,
    failedTests: ['adds numbers'],
    errors: ['expected 3 but got 4'],
    ranAt: Date.now(),
  }
  const refused = checkAdvance(current, 'deliver')
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /verification has not passed/)

  current.verification = { ...current.verification, passed: true, exitCode: 0, failedTests: [], errors: [] }
  assert.equal(checkAdvance(current, 'deliver').ok, true)
})

test('consult mode has no implement or verify stage', () => {
  const current = state('consult')
  assert.equal(checkAdvance(current, 'implement').ok, false)
  assert.equal(checkAdvance(current, 'verify').ok, false)
  assert.equal(stageInMode('consult', 'deliver'), true)
})

test('a refused advance is recorded once and cleared once', () => {
  const current = state()
  recordRefusal(current, 'implement', 'no task list')
  assert.equal(current.refusal.target, 'implement')
  assert.equal(clearRefusal(current), 'no task list')
  assert.equal(clearRefusal(current), undefined)
})

test('switching to a narrower mode resets an unsupported stage', () => {
  const current = state()
  current.plan = { items: [{ content: 'x', status: 'in_progress' }], at: Date.now() }
  applyStage(current, 'implement', 'test')
  assert.equal(current.stage, 'implement')
  const stage = applyMode(current, 'consult')
  assert.equal(stage, 'requirements')
  assert.equal(current.transitions.at(-1).reason, 'mode switched to consult')
})

test('the implement table is exactly the delegation set', () => {
  assert.deepEqual([...tableTrim('implement')].sort(), [...IMPLEMENT_TABLE].sort())
  assert.equal(IMPLEMENT_TABLE.includes(TOOL.implement), true)
  assert.equal(IMPLEMENT_TABLE.includes(TOOL.handoff), true, 'the handoff verb survives the trim')
  assert.equal(IMPLEMENT_TABLE.includes('apply_patch'), false)
  assert.equal(IMPLEMENT_TABLE.includes('edit'), false)
  assert.equal(IMPLEMENT_TABLE.includes('write'), false)
  assert.equal(tableTrim('requirements'), undefined)
})

test('stage admissions stay in sync with the tool classes', () => {
  assert.equal(stageAdmits('implement', 'delegate'), true)
  assert.equal(stageAdmits('implement', 'write'), false)
  assert.equal(toolClass(TOOL.handoff), 'stage')
  assert.equal(stageAdmits('requirements', 'stage'), true, 'the handoff verb is available in every stage')
  assert.equal(stageAdmits('verify', 'verify'), true)
  assert.equal(stageAdmits('verify', 'write'), false)
  assert.equal(stageAdmits('deliver', 'write'), false)
  assert.equal(stageAdmits('verify', 'plan'), true, 'verify can close a finished step')
  assert.equal(stageAdmits('deliver', 'plan'), true, 'deliver can close the last step')
  assert.equal(stageAdmits('requirements', 'plan'), false, 'the plan gate still starts in plan')
})

test('verify and deliver admit todo_write but requirements does not', () => {
  const verify = state()
  verify.stage = 'verify'
  assert.equal(checkTool(verify, 'todo_write').deny, undefined)

  const deliver = state()
  deliver.stage = 'deliver'
  assert.equal(checkTool(deliver, 'todo_write').deny, undefined)

  const requirements = state()
  assert.match(checkTool(requirements, 'todo_write').deny, /not available in the requirements stage/)
})

test('checkpoint carries the whole state and validates strictly', () => {
  const current = state()
  current.requirementsObserved = 1
  current.plan = {
    items: [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
    ],
    at: Date.now(),
  }
  current.files = new Set(['src/b.ts', 'src/a.ts'])
  current.edits = 2
  const checkpoint = checkpointOf(current)
  assert.equal(checkpoint.v, 1)
  assert.equal(checkpoint.planItems, 2)
  assert.equal(checkpoint.openPlanItems, 1)
  assert.equal(checkpoint.verifyAttempts, 0, 'a fresh session has spent none of the retry budget')
  assert.deepEqual(checkpoint.files, ['src/a.ts', 'src/b.ts'], 'the reported paths are distinct and sorted')
  assert.deepEqual(checkpoint.allowedStages, [...STAGES_BY_MODE.codex])
  assert.deepEqual(asCheckpoint(JSON.parse(JSON.stringify(checkpoint))), checkpoint)
  assert.deepEqual(asCheckpoint({ ...checkpoint, files: ['src/a.ts'] }).files, ['src/a.ts'])
  assert.equal(asCheckpoint({ ...checkpoint, files: ['src/a.ts', 2] }), undefined, 'only string paths are files')
  assert.equal(asCheckpoint({ ...checkpoint, files: '' }), undefined)
  // A checkpoint written before `files` existed still parses: the field is optional.
  assert.equal('files' in asCheckpoint({ ...checkpoint, files: undefined }), false)
  assert.equal(asCheckpoint({ ...checkpoint, v: 2 }), undefined)
  assert.equal(asCheckpoint({ ...checkpoint, stage: 'shipping' }), undefined)
  assert.equal(asCheckpoint(null), undefined)
})

test('status line states the facts the model needs', () => {
  const current = state()
  current.edits = 3
  const line = statusLine(current)
  assert.match(line, /stage requirements/)
  assert.match(line, /verification not run/)
  assert.match(line, /files changed 3/)
  assert.match(line, /handoff goal=missing, acceptance=0/)

  current.handoff = handoffOf()
  assert.match(statusLine(current), /handoff goal=set, acceptance=1/)

  // A failed attempt is counted in the line the model reads every step.
  current.verification = outcome()
  current.verificationAttempts = 1
  assert.match(statusLine(current), /FAILED .*attempt 1/)

  // A spent budget is BLOCKED, and a blocked delivery says so on its own line.
  current.stage = 'deliver'
  current.verifyBlocked = { attempts: 2, reason: 'retry budget exhausted', at: 1 }
  current.deliveryBlocked = true
  const blocked = statusLine(current)
  assert.match(blocked, /verification BLOCKED after 2 attempts/)
  assert.match(blocked, /delivery BLOCKED/)
})

test('restoring from the durable projection keeps the recorded evidence', () => {
  const current = state('codex')
  restoreFromView(current, {
    mode: 'codex',
    stage: 'implement',
    updatedAt: 50,
    plan: [{ content: 'fix the bug', status: 'in_progress' }],
    checkpoint: {
      v: 1,
      runId: 's:9',
      turn: 2,
      step: 4,
      mode: 'codex',
      stage: 'implement',
      allowedStages: [...STAGES_BY_MODE.codex],
      planItems: 1,
      openPlanItems: 1,
      edits: 3,
      verification: {
        passed: true,
        kind: 'test',
        scope: 'package',
        source: 'lead',
        command: 'pnpm test',
        exitCode: 0,
        durationMs: 1,
        failedTests: [],
        errors: [],
        ranAt: 40,
      },
      // The handoff a resumed codex run needs to enter verify and deliver.
      handoff: handoffOf('fix the bug', ['the failing test passes']),
      updatedAt: 40,
    },
  })
  assert.equal(current.stage, 'implement')
  assert.equal(current.runId, 's:9')
  assert.equal(current.edits, 3)
  // This checkpoint predates `files`, so its total becomes the inherited floor.
  assert.equal(current.baseEdits, 3)
  assert.equal(current.files.size, 0)
  assert.equal(current.plan.items[0].content, 'fix the bug')
  assert.equal(current.handoff.goal, 'fix the bug')
  assert.equal(checkAdvance(current, 'verify').ok, true, 'the restored edit count satisfies the verify gate')
  assert.equal(checkAdvance(current, 'deliver').ok, true, 'the restored verification satisfies the deliver gate')

  const narrowed = state('consult')
  restoreFromView(narrowed, { mode: 'consult', stage: 'implement', plan: [], checkpoint: null, updatedAt: 1 })
  assert.equal(narrowed.stage, 'requirements', 'a stage the mode does not open resets to its entry stage')
})

test('restoring a checkpoint that carries files resumes the distinct set', () => {
  const current = state('codex')
  restoreFromView(current, {
    mode: 'codex',
    stage: 'implement',
    updatedAt: 60,
    plan: [{ content: 'fix the bug', status: 'in_progress' }],
    checkpoint: {
      v: 1,
      runId: 's:10',
      turn: 3,
      step: 5,
      mode: 'codex',
      stage: 'implement',
      allowedStages: [...STAGES_BY_MODE.codex],
      planItems: 1,
      openPlanItems: 1,
      edits: 2,
      files: ['src/a.ts', 'src/b.ts'],
      updatedAt: 55,
    },
  })
  assert.equal(current.edits, 2)
  assert.equal(current.baseEdits, 0, 'a checkpoint with a files list needs no inherited floor')
  assert.deepEqual([...current.files].sort(), ['src/a.ts', 'src/b.ts'])
  assert.deepEqual(checkpointOf(current).files, ['src/a.ts', 'src/b.ts'], 'the resumed set rides the next checkpoint')
  assert.equal(statusLine(current).includes('files changed 2'), true)
})

test('delegate_plan is a plan-stage delegation verb', () => {
  assert.equal(toolClass('delegate_plan'), 'delegate')
  assert.equal(stageAdmits('plan', 'delegate'), true)
  assert.equal(stageAdmits('requirements', 'delegate'), false)
  assert.equal(stageAdmits('implement', 'delegate'), true)
})

test('legacy recon values parse as the requirements stage', () => {
  assert.equal(asStage('requirements'), 'requirements')
  assert.equal(asStage('recon'), 'requirements')
  assert.equal(asStage('shipping'), undefined)

  const current = state()
  const checkpoint = asCheckpoint({
    ...checkpointOf(current),
    stage: 'recon',
    allowedStages: ['recon', 'plan', 'implement', 'verify', 'deliver'],
  })
  assert.equal(checkpoint.stage, 'requirements')
  assert.deepEqual(checkpoint.allowedStages, ['requirements', 'plan', 'implement', 'verify', 'deliver'])
})

test('a checkpoint accepts a plan worker record', () => {
  const current = state()
  current.worker = { role: 'plan', status: 'completed', startedAt: 1, finishedAt: 2, summary: 'planned' }
  const checkpoint = asCheckpoint(JSON.parse(JSON.stringify(checkpointOf(current))))
  assert.equal(checkpoint.worker.role, 'plan')
})

test('codex plan gate requires a recorded goal', () => {
  const current = state()
  current.requirementsObserved = 2

  // Inspecting the workspace is not enough: the planner only receives the handoff.
  const refused = checkAdvance(current, 'plan')
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /coding_handoff/)

  current.handoff = handoffOf()
  assert.equal(checkAdvance(current, 'plan').ok, true, 'the recorded goal opens plan')
})

test('codex verify gate requires a definition of done', () => {
  const current = state()
  current.plan = { items: [{ content: 'fix the bug', status: 'in_progress' }], at: Date.now() }
  current.handoff = handoffOf('fix the bug', [])
  current.edits = 2

  const refused = checkAdvance(current, 'verify')
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /acceptance|definition of done/)

  current.handoff = handoffOf()
  assert.equal(checkAdvance(current, 'verify').ok, true, 'an acceptance check opens verify')
})

test('deliver requires a complete handoff once the verification passed', () => {
  const current = reachedVerify()
  current.verification = outcome({ passed: true, exitCode: 0, failedTests: [], errors: [] })
  assert.equal(checkAdvance(current, 'deliver').ok, true)

  current.handoff = handoffOf('fix the bug', [])
  const refused = checkAdvance(current, 'deliver')
  assert.equal(refused.ok, false, 'a delivery without a stated definition of done is refused')
  assert.match(refused.reason, /coding_handoff/)
})

test('verification retry budget allows a blocked delivery', () => {
  const current = reachedVerify()
  const budget = { maxAttempts: 2, maxSameFailure: 0 }

  recordVerification(current, outcome({ errors: ['first failure'] }), budget)
  assert.equal(current.verificationAttempts, 1)
  assert.equal(current.verifyBlocked, undefined, 'one failure is still within the budget')

  recordVerification(current, outcome({ errors: ['second failure'] }), budget)
  assert.equal(current.verificationAttempts, 2)
  assert.ok(current.verifyBlocked, 'the second failure exhausts the budget')
  assert.match(current.verifyBlocked.reason, /retry budget/)

  // The exit from the loop is a granted advance that must deliver blocked.
  const check = checkAdvance(current, 'deliver')
  assert.equal(check.ok, true, 'the move is granted')
  assert.equal(check.blocked, true, 'the delivery must be reported blocked')

  // A passing verification ends the loop and restores a normal delivery.
  recordVerification(current, outcome({ passed: true, exitCode: 0, failedTests: [], errors: [] }), budget)
  assert.equal(current.verifyBlocked, undefined)
  assert.equal(current.verificationAttempts, 0)
  assert.equal(current.sameFailureCount, 0)
  const delivered = checkAdvance(current, 'deliver')
  assert.equal(delivered.ok, true)
  assert.equal(delivered.blocked, undefined)
})

test('repeated identical failure exhausts the budget early', () => {
  const budget = { maxAttempts: 0, maxSameFailure: 2 }

  const repeated = reachedVerify()
  recordVerification(repeated, outcome(), budget)
  assert.equal(repeated.sameFailureCount, 1)
  assert.equal(repeated.verifyBlocked, undefined)
  recordVerification(repeated, outcome(), budget)
  assert.equal(repeated.sameFailureCount, 2)
  assert.equal(repeated.verifyBlocked.attempts, 2, 'the repeat counter alone exhausts the budget')

  const varied = reachedVerify()
  recordVerification(varied, outcome(), budget)
  recordVerification(varied, outcome({ errors: ['a different error'] }), budget)
  assert.equal(varied.sameFailureCount, 1, 'a different signature restarts the repeat count')
  assert.equal(varied.verificationAttempts, 2, 'the spent attempts are never refunded')
  assert.equal(varied.verifyBlocked, undefined, 'two different failures are not a repeat')
})

test('resetVerification keeps the last outcome but clears the budget', () => {
  const current = reachedVerify()
  const budget = { maxAttempts: 2, maxSameFailure: 0 }
  recordVerification(current, outcome(), budget)
  recordVerification(current, outcome(), budget)
  assert.ok(current.verifyBlocked)

  resetVerification(current)
  assert.equal(current.verificationAttempts, 0)
  assert.equal(current.sameFailureCount, 0)
  assert.equal(current.verifyBlocked, undefined)
  assert.equal(current.verification?.passed, false, 'the last outcome stays as evidence')

  // The failed check still refuses delivery: only its budget was forgotten.
  const refused = checkAdvance(current, 'deliver')
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /verification has not passed/)
})

test('checkpoint carries the handoff and the retry budget', () => {
  const current = reachedVerify()
  const budget = { maxAttempts: 2, maxSameFailure: 0 }
  recordVerification(current, outcome(), budget)
  recordVerification(current, outcome(), budget)

  const checkpoint = checkpointOf(current)
  assert.equal(checkpoint.handoff.goal, 'fix the bug')
  assert.deepEqual(checkpoint.handoff.acceptance, ['the failing test passes'])
  assert.equal(checkpoint.verifyAttempts, 2)
  assert.equal(checkpoint.verifyBlocked.attempts, 2)
  assert.deepEqual(asCheckpoint(JSON.parse(JSON.stringify(checkpoint))), checkpoint)
  assert.equal(asCheckpoint({ ...checkpoint, verifyAttempts: -1 }), undefined)

  // A checkpoint written before the handoff and the retry budget existed still parses.
  const legacy = { ...checkpoint }
  delete legacy.handoff
  delete legacy.verifyAttempts
  delete legacy.verifyBlocked
  const parsed = asCheckpoint(legacy)
  assert.ok(parsed)
  assert.equal('handoff' in parsed, false)
  assert.equal('verifyAttempts' in parsed, false)
  assert.equal('verifyBlocked' in parsed, false)
})

test('checkpoint carries the latest failure', () => {
  const current = state()
  current.failure = makeFailure('delegate', new Error('model missing'), 'zh', 123)
  const checkpoint = checkpointOf(current)
  assert.equal(checkpoint.failure.point, 'delegate')
  assert.equal(checkpoint.failure.at, 123)
  assert.match(statusLine(current), /failure delegate/, 'the status line states the interruption')

  // The report is durable JSON, so the round trip must keep the reason verbatim.
  const parsed = asCheckpoint(JSON.parse(JSON.stringify(checkpoint)))
  assert.equal(parsed.failure.point, 'delegate')
  assert.match(parsed.failure.reason, /model missing/)
  assert.equal(parsed.failure.at, 123)

  // An illegal report reads as "no failure": a junk field must not drop the
  // whole card, by the same tolerance a malformed handoff gets.
  const tolerant = asCheckpoint({
    ...checkpoint,
    failure: { point: 'nope', reason: 'x', action: 'y', at: 1 },
  })
  assert.ok(tolerant, 'the rest of the checkpoint still parses')
  assert.equal(tolerant.failure, undefined)

  // A checkpoint written before the failure existed carries no such field.
  const legacy = { ...checkpoint }
  delete legacy.failure
  assert.equal('failure' in asCheckpoint(legacy), false)
})
