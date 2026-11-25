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
  VERIFY_INSTRUCTION_FILE_THRESHOLD,
  VERIFY_INSTRUCTION_TASK_THRESHOLD,
  asCheckpoint,
  asStage,
  entryStage,
  needsWorkspaceInstructions,
  stageAdmits,
  stageInMode,
  toolClass,
} from '../lib/stages.js'
import { makeFailure } from '../lib/failures.js'
import {
  HANDOFF_ITEMS_LIMIT,
  asHandoff,
  handoffDigest,
  handoffForWorker,
  mergeHandoff,
} from '../lib/handoff.js'
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
  stageToolTable,
  statusLine,
  tableTrim,
} from '../lib/state.js'

/** A fresh session state in one mode. */
function state(mode = 'codex') {
  return createState('session-1', mode)
}

/**
 * A recorded handoff, shaped as `coding_handoff` merges it into the state. The
 * delivery fields stay absent / empty until the deliver stage writes them.
 */
function handoffOf(goal = 'fix the bug', acceptance = ['the failing test passes']) {
  return {
    version: 1,
    goal,
    constraints: [],
    acceptance,
    findings: [],
    decisions: [],
    open: [],
    followUps: [],
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

test('verify loads repository instructions only for a complex codex run', () => {
  const demand = (mode, taskCount, changedFiles) => needsWorkspaceInstructions({ mode, taskCount, changedFiles })
  assert.equal(demand('codex', 1, 1), false, 'one task over one file does not earn a whole AGENTS.md')
  assert.equal(
    demand('codex', VERIFY_INSTRUCTION_TASK_THRESHOLD, 0),
    true,
    'dependent sub-tasks need the repository rules',
  )
  assert.equal(
    demand('codex', 0, VERIFY_INSTRUCTION_FILE_THRESHOLD),
    true,
    'a broad change needs the repository rules',
  )
  assert.equal(demand('review', 5, 5), false, 'review verifies existing behavior, so it never injects')
  assert.equal(demand('consult', 2, 3), false)
  assert.equal(demand('auto', 2, 3), false)
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

/** A four-item task list, the smallest list the planner gate calls complex. */
function complexPlan(contents = ['a', 'b', 'c', 'd']) {
  return { items: contents.map(content => ({ content, status: 'in_progress' })), at: Date.now() }
}

test('codex requires the planner for a complex task list', () => {
  const current = state()
  current.handoff = handoffOf()
  current.plan = complexPlan()

  // More than three items is the only machine-checkable complexity signal: the
  // planner must have been dispatched before implement.
  const refused = checkAdvance(current, 'implement')
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /delegate_plan/)

  // A small single-file change (three items or fewer) skips the gate.
  current.plan = complexPlan(['a', 'b', 'c'])
  assert.equal(checkAdvance(current, 'implement').ok, true)

  // A recorded attempt opens the gate whatever the outcome was.
  current.plan = complexPlan()
  current.planner = { route: 'deepseek-account/deepseek-v4-pro', outcome: 'completed', at: Date.now() }
  assert.equal(checkAdvance(current, 'implement').ok, true)

  const failedAttempt = state()
  failedAttempt.handoff = handoffOf()
  failedAttempt.plan = complexPlan()
  failedAttempt.planner = { route: 'deepseek-account/deepseek-v4-pro', outcome: 'failed', at: Date.now() }
  assert.equal(checkAdvance(failedAttempt, 'implement').ok, true, 'a failed dispatch still counts as an attempt')

  // A lead that already runs the planner route needs no planner worker.
  const leadIsPlanner = state()
  leadIsPlanner.plan = complexPlan()
  assert.equal(checkAdvance(leadIsPlanner, 'implement', { leadIsPlanner: true }).ok, true)

  // `requirePlanner: off` switches the whole gate off.
  const disabled = state()
  disabled.plan = complexPlan()
  assert.equal(checkAdvance(disabled, 'implement', { plannerGate: false }).ok, true)
})

test('the planner gate never replaces the mode stage set', () => {
  const current = state('consult')
  current.plan = complexPlan()
  const refused = checkAdvance(current, 'implement')
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /not part of consult mode/, 'the stage-set refusal wins')
  assert.doesNotMatch(refused.reason, /delegate_plan/)
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
  assert.equal(IMPLEMENT_TABLE.includes('bash'), true, 'the lead keeps a shell while implementing')
  assert.equal(IMPLEMENT_TABLE.includes('pwsh'), true, 'the Windows shell stays in the table too')
  assert.equal(IMPLEMENT_TABLE.includes('apply_patch'), false)
  assert.equal(IMPLEMENT_TABLE.includes('edit'), false)
  assert.equal(IMPLEMENT_TABLE.includes('write'), false)
  assert.equal(tableTrim('requirements'), undefined)
})

test('stageToolTable 为 verify / deliver 按阶段准入显式裁剪', () => {
  // 本 agent scope 实际注册的工具名：编码工具 + 一个类未知的第三方工具。
  const known = [
    'read', 'grep', 'run_verification', 'delegate_verify', 'delegate_plan', 'delegate_implement',
    'write', 'edit', 'apply_patch', 'bash', 'pwsh', 'todo_write', 'coding_stage', 'coding_mode',
    'coding_reasoning', 'coding_handoff', 'third_party_tool',
  ]

  const verify = stageToolTable('verify', known)
  for (const name of [
    'run_verification', 'delegate_verify', 'read', 'bash', 'pwsh', 'todo_write',
    'coding_stage', 'coding_handoff', 'third_party_tool',
  ]) {
    assert.equal(verify.includes(name), true, `${name} 在 verify 阶段仍可见`)
  }
  // delegate_plan / delegate_implement 属 delegate 类，verify 不授予；写类同样被裁掉。
  for (const name of ['delegate_plan', 'delegate_implement', 'write', 'edit', 'apply_patch']) {
    assert.equal(verify.includes(name), false, `${name} 在 verify 阶段必须被裁掉`)
  }

  const deliver = stageToolTable('deliver', known)
  for (const name of ['read', 'todo_write', 'coding_stage', 'coding_handoff', 'third_party_tool']) {
    assert.equal(deliver.includes(name), true, `${name} 在 deliver 阶段仍可见`)
  }
  // 交付只报告：验证、执行、写与委派动词全部裁掉。
  for (const name of [
    'run_verification', 'delegate_verify', 'delegate_plan', 'delegate_implement',
    'bash', 'pwsh', 'write', 'edit', 'apply_patch',
  ]) {
    assert.equal(deliver.includes(name), false, `${name} 在 deliver 阶段必须被裁掉`)
  }

  // implement 仍用显式表，requirements / plan 不裁剪（undefined 表示保持整表）。
  assert.deepEqual([...stageToolTable('implement', known)].sort(), [...IMPLEMENT_TABLE].sort())
  assert.equal(stageToolTable('requirements', known), undefined)
  assert.equal(stageToolTable('plan', known), undefined)
})

test('stage admissions stay in sync with the tool classes', () => {
  assert.equal(stageAdmits('implement', 'delegate'), true)
  assert.equal(stageAdmits('implement', 'write'), false)
  assert.equal(toolClass(TOOL.handoff), 'stage')
  assert.equal(stageAdmits('requirements', 'stage'), true, 'the handoff verb is available in every stage')
  assert.equal(stageAdmits('verify', 'verify'), true)
  assert.equal(stageAdmits('verify', 'write'), false)
  assert.equal(stageAdmits('deliver', 'write'), false)
  assert.equal(stageAdmits('implement', 'exec'), true, 'the lead runs installs and git itself')
  assert.equal(stageAdmits('verify', 'exec'), true, 'verify may reproduce a failure directly')
  assert.equal(stageAdmits('deliver', 'exec'), false, 'delivery reports without running commands')
  assert.equal(stageAdmits('verify', 'plan'), true, 'verify can close a finished step')
  assert.equal(stageAdmits('deliver', 'plan'), true, 'deliver can close the last step')
  assert.equal(stageAdmits('requirements', 'plan'), false, 'the plan gate still starts in plan')
})

test('the lead holds a shell in implement and verify but not in deliver', () => {
  const implement = state()
  implement.stage = 'implement'
  assert.equal(checkTool(implement, 'bash').deny, undefined)
  assert.equal(checkTool(implement, 'pwsh').deny, undefined)

  const verify = state()
  verify.stage = 'verify'
  assert.equal(checkTool(verify, 'bash').deny, undefined)

  const deliver = state()
  deliver.stage = 'deliver'
  const denied = checkTool(deliver, 'bash').deny
  assert.equal(typeof denied, 'string')
  assert.ok(denied.includes('run_verification'), denied)
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

test('a checkpoint carries the planner attempt and rejects a malformed one', () => {
  const current = state()
  current.planner = { route: 'deepseek-account/deepseek-v4-pro', outcome: 'completed', at: 42 }
  const checkpoint = checkpointOf(current)
  assert.deepEqual(checkpoint.planner, current.planner)

  // The checkpoint is durable JSON: the attempt must survive the round trip,
  // or a resumed session would ask for the planner a second time.
  const parsed = asCheckpoint(JSON.parse(JSON.stringify(checkpoint)))
  assert.ok(parsed)
  assert.deepEqual(parsed.planner, current.planner)

  // A present but illegal attempt is a corrupt checkpoint, unlike an absent one.
  assert.equal(asCheckpoint({ ...checkpoint, planner: { route: 1 } }), undefined)
  assert.equal(asCheckpoint({ ...checkpoint, planner: { route: 'x', outcome: 'done', at: 1 } }), undefined)
  assert.equal(asCheckpoint({ ...checkpoint, planner: { route: 'x', outcome: 'failed', at: 'x' } }), undefined)

  // A checkpoint written before `planner` existed reads as "never attempted".
  const legacy = { ...checkpoint }
  delete legacy.planner
  assert.equal('planner' in asCheckpoint(legacy), false)

  // A session that never dispatched the planner emits no such field at all, so
  // the gate stays closed only by the missing attempt, never by a null record.
  const plain = JSON.parse(JSON.stringify(checkpointOf(state())))
  const parsedPlain = asCheckpoint(plain)
  assert.ok(parsedPlain, 'a checkpoint without a planner attempt still parses')
  assert.equal('planner' in parsedPlain, false)
})

test('restoring a checkpoint resumes the recorded planner attempt', () => {
  const recorded = state('codex')
  recorded.planner = { route: 'deepseek-account/deepseek-v4-pro', outcome: 'failed', at: 77 }

  const current = state('codex')
  restoreFromView(current, {
    mode: 'codex',
    stage: 'plan',
    updatedAt: 80,
    plan: complexPlan().items,
    checkpoint: asCheckpoint(checkpointOf(recorded)),
  })
  assert.equal(current.stage, 'plan')
  assert.deepEqual(current.planner, recorded.planner)
  assert.match(statusLine(current), /planner failed/)
  assert.equal(checkAdvance(current, 'implement').ok, true, 'the resumed attempt keeps the gate open')
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

test('delivered overwrites the previous delivery record and an empty string clears it', () => {
  const base = mergeHandoff(undefined, { goal: 'g', delivered: 'turn 1: shipped the flag' })
  assert.equal(base.delivered, 'turn 1: shipped the flag')

  const refined = mergeHandoff(base, { delivered: 'turn 2: refined' })
  assert.equal(refined.delivered, 'turn 2: refined', 'a later record replaces the previous delivery')
  assert.equal(refined.goal, 'g', 'overwriting the delivery keeps the rest of the handoff')

  const cleared = mergeHandoff(refined, { delivered: '' })
  assert.equal(cleared.delivered, undefined, 'an empty string clears the delivery record')
  assert.equal(cleared.goal, 'g', 'clearing the delivery keeps the rest of the handoff')
})

test('followUps append, de-duplicate, and keep the newest HANDOFF_ITEMS_LIMIT entries', () => {
  const first = mergeHandoff(undefined, { goal: 'g', followUps: ['harden the parser', 'add a doc'] })
  const twice = mergeHandoff(first, { followUps: ['add a doc', 'rerun the suite'] })
  assert.deepEqual(twice.followUps, ['harden the parser', 'add a doc', 'rerun the suite'])

  let grown = mergeHandoff(undefined, { goal: 'g' })
  for (let index = 0; index < 15; index += 1) {
    grown = mergeHandoff(grown, { followUps: [`item ${index}`] })
  }
  assert.equal(grown.followUps.length, HANDOFF_ITEMS_LIMIT)
  assert.equal(grown.followUps.at(-1), 'item 14', 'the newest entries are the ones kept')
})

test('a record written before the delivery fields still parses', () => {
  const legacy = asHandoff({
    version: 1,
    goal: 'g',
    constraints: [],
    acceptance: [],
    findings: [],
    decisions: [],
    open: [],
    tasks: [],
    changes: [],
    updatedAt: 1,
  })
  assert.ok(legacy, 'a record without delivered/followUps is still usable')
  assert.equal(legacy.goal, 'g')
  assert.equal(legacy.delivered, undefined, 'a missing delivery record reads as none')
  assert.deepEqual(legacy.followUps, [], 'a missing follow-up list reads as empty')

  assert.equal(asHandoff({ version: 2 }), undefined, 'the version check still rejects unknown shapes')
})

test('the delivery record reaches the digest and the plan/implement slices only', () => {
  const record = mergeHandoff(undefined, {
    goal: 'fix the bug',
    delivered: 'turn 1: shipped the flag behind a config switch',
    followUps: ['harden the parser'],
  })

  const digest = handoffDigest(record)
  assert.match(digest, /delivered: /)
  assert.match(digest, /follow-ups: /)
  assert.match(digest, /harden the parser/)

  assert.match(handoffForWorker(record, 'plan'), /Delivered:/)
  assert.match(handoffForWorker(record, 'implement'), /Delivered:/)
  assert.doesNotMatch(handoffForWorker(record, 'verify'), /Delivered:/)
})
