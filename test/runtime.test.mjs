/**
 * Runtime tests for the Coding preset plugin.
 *
 * The harness implements the exact Cordis surface the plugin uses (`on`,
 * `effect`, `tools.register/guard/schemas`, `inject`, `get`) and drives the
 * registered listeners the way the Host does: a waterfall chain for
 * `tools/pre-execute` and `agent/pre-step`, a direct call for the guard, and a
 * tool call for the verbs. It asserts the two constraints the plugin exists for:
 * a stage-forbidden edit is refused with an actionable reason, and a failed
 * verification blocks delivery.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as preset from '../lib/preset.js'
import { IMPLEMENT_TABLE, TOOL } from '../lib/stages.js'

const CONFIG = {
  defaultMode: 'codex',
  implementWorkerModel: 'deepseek-account/deepseek-flash',
  plannerWorkerModel: 'deepseek-account/deepseek-v4-pro',
  verifyWorkerModel: 'deepseek-account/deepseek-flash',
  reasoning: 'auto',
  maxVerifyAttempts: 5,
  maxSameFailure: 2,
  verificationTimeoutMs: 360000,
  verificationCommands: {},
}

/** Build one fake Host context around the real preset plugin. */
async function createHarness(options = {}) {
  const listeners = new Map()
  const registrations = new Map()
  const commands = []
  const guards = []
  const restrictions = []
  const activations = []
  let exitCode = options.exitCode ?? 1

  const tools = new Map()
  const add = (definition) => {
    tools.set(definition.name, definition)
    return () => tools.delete(definition.name)
  }

  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    dshCodingRuntime: { options: { ...CONFIG } },
    subagents: {
      getProvider: () => ({ capabilities: { agentOptions: true, agentPreset: true, outputSchema: true } }),
      startActivation: async (spec) => {
        activations.push(spec)
        const report = spec.agentPreset === 'dsh-coding-planner'
          ? { ok: true, summary: 'planned the work', tasks: ['add the flag', 'cover it with a test'] }
          : spec.agentPreset === 'dsh-coding-implement'
            ? { ok: true, summary: 'changed two files', files: ['src/a.ts', 'src/b.ts'] }
            : { ok: false, summary: 'one test fails', failedTests: ['adds numbers'], kind: 'test', scope: 'package' }
        return {
          childId: 'child-1',
          name: 'lead/worker',
          messageId: 'm1',
          result: Promise.resolve({ stopReason: 'completed', structured: report, output: [] }),
          dispose: async () => {},
        }
      },
    },
    llm: { listProviders: () => [{ id: 'deepseek-account' }] },
    agentPresets: {},
    sessionProjections: {
      register(definition) {
        const events = options.projectionEvents ?? []
        return {
          stateOf(session) {
            let state = definition.init(session.header, 0)
            for (const event of events) state = definition.apply(state, event)
            return state
          },
          dispose: async () => {},
        }
      },
    },
    subprocess: {
      spawn: () => ({
        done: Promise.resolve({ exitCode, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text: 'not ok 1 adds numbers', nextOffset: 22, lossy: false }) },
          stderr: { readFrom: () => ({ text: 'expected 3 but got 4', nextOffset: 21, lossy: false }) },
        },
      }),
    },
    get(name) {
      return this[name]
    },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {}
    },
    effect(effect) {
      const disposer = effect()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    tools: {
      register: add,
      guard(guard) {
        guards.push(guard)
        return () => {}
      },
      schemas() {
        return [...tools.values()]
      },
      restrict(filter) {
        restrictions.push(filter)
        return () => {}
      },
    },
    inject(services, callback) {
      if (services.includes('commands')) callback({ commands: { register: (definition) => { commands.push(definition); return () => {} } } })
      if (services.includes('fs')) callback({ ...ctx, tools: ctx.tools })
      if (services.includes('sessionProjections')) callback({ ...ctx, sessionProjections: ctx.sessionProjections })
    },
  }

  // A stand-in for the tools the preset composition mounts beside the plugin.
  for (const name of ['read', 'grep', 'apply_patch', 'write', 'edit', 'bash', 'todo_write', 'run_verification']) {
    if (name === 'run_verification') continue
    add({ name, description: name, parameters: {}, output: { schema: { type: 'string' }, render: () => [] }, execute: async () => '' })
  }

  await preset.apply(ctx)

  /** Visible tool names after every agent-scope restriction. */
  const visible = () => [...tools.keys()].filter((name) => restrictions.every((filter) => {
    if (filter.allow !== undefined && !filter.allow.includes(name)) return false
    if (filter.deny !== undefined && filter.deny.includes(name)) return false
    return true
  }))

  /** Drive one waterfall the way the Host does, ending in the supplied default. */
  async function waterfall(event, args, fallback) {
    const list = listeners.get(event) ?? []
    const step = async (index) => (index >= list.length ? fallback() : list[index](...args, () => step(index + 1)))
    return step(0)
  }

  /** Drive post-execute with a result the tool produced. */
  async function postExecute(exec, result) {
    return waterfall('tools/post-execute', [exec, result], async () => ({ kind: 'accept' }))
  }

  /** Drive pre-step with claimed messages. */
  async function preStep(agent, messages = []) {
    return waterfall(
      'agent/pre-step',
      [{ agent, messages, turn: 1, step: 1, signal: new AbortController().signal, modelSelection: {} }],
      async () => ({ kind: 'enter', messages }),
    )
  }

  /** Drive pre-execute for one tool name. */
  async function preExecute(agent, name, args = {}) {
    return waterfall(
      'tools/pre-execute',
      [{ agent, name, arguments: args, callId: 'call-1', signal: new AbortController().signal }],
      async () => ({ kind: 'allow' }),
    )
  }

  /** Call one registered tool the way the executor would. */
  async function callTool(name, args, agent) {
    const definition = tools.get(name)
    assert.ok(definition, `tool ${name} is registered`)
    return definition.execute(args, {
      agent,
      name,
      arguments: args,
      callId: 'call-1',
      signal: new AbortController().signal,
      deferContext() {},
      concludeTurn() {},
    })
  }

  return {
    ctx, tools, guards, restrictions, activations, commands,
    listeners, visible, preExecute, preStep, postExecute, callTool, waterfall,
    setExitCode(value) { exitCode = value },
  }
}

/** One lead agent whose scope records tool-table restrictions. */
function makeAgent(cwd, harness) {
  return {
    session: { header: { id: 'session-1', delegationDepth: 0, cwd, agentPreset: 'dsh-coding' } },
    ctx: {
      tools: {
        restrict(filter) {
          harness.restrictions.push(filter)
          return () => {}
        },
      },
    },
  }
}

/** Emit agent/created so the plugin initialises its per-agent state. */
async function created(harness, agent) {
  for (const listener of harness.listeners.get('agent/created') ?? []) {
    await listener({ agent, source: 'startup' })
  }
}

/** Record one successful requirements observation, the handoff, and advance to plan. */
async function reachPlan(harness, agent) {
  await harness.postExecute({ agent, name: 'read', arguments: {} }, { isError: false, value: '' })
  // codex refuses plan without a recorded goal and verify without acceptance.
  await harness.callTool(TOOL.handoff, { goal: 'fix the bug', acceptance: ['the failing test passes'] }, agent)
  return harness.callTool(TOOL.stage, { stage: 'plan' }, agent)
}

/** Record a structured task list through the durable session event. */
function writePlan(harness, agent) {
  for (const listener of harness.listeners.get('session/event') ?? []) {
    listener({ header: { id: agent.session.header.id } }, {
      type: 'todo/write',
      time: Date.now(),
      data: { todos: [{ content: 'fix the bug', status: 'in_progress' }] },
    })
  }
}

/** One whole-value checkpoint as a Coding tool result carries it in `meta`. */
const RESUME_VERIFICATION = {
  passed: true,
  kind: 'test',
  scope: 'package',
  source: 'lead',
  command: 'npm run test',
  exitCode: 0,
  durationMs: 5,
  failedTests: [],
  errors: [],
  ranAt: 9,
}

/** The handoff a resumed codex checkpoint carries: the goal and its acceptance check. */
const RESUME_HANDOFF = {
  version: 1,
  goal: 'fix the bug',
  constraints: [],
  acceptance: ['the failing test passes'],
  findings: [],
  decisions: [],
  open: [],
  tasks: [],
  changes: [],
  updatedAt: 8,
}

/**
 * Durable events of a Coding run that reached the implement stage. `handoff`
 * defaults to the recorded one; pass `null` for a checkpoint written before the
 * handoff existed, which only the plan stage tolerates.
 */
function resumeEvents(stage = 'implement', verification, handoff = RESUME_HANDOFF) {
  return [
    { type: 'todo/write', time: 10, data: { todos: [{ content: 'fix the bug', status: 'in_progress' }] } },
    {
      type: 'tool/result',
      time: 11,
      data: {
        meta: {
          v: 1,
          runId: 'session-1:resume',
          turn: 1,
          step: 3,
          mode: 'codex',
          stage,
          allowedStages: ['requirements', 'plan', 'implement', 'verify', 'deliver'],
          planItems: 1,
          openPlanItems: 1,
          edits: 2,
          ...verification === undefined ? {} : { verification },
          ...handoff === null ? {} : { handoff },
          verifyAttempts: 0,
          updatedAt: 12,
        },
      },
    },
  ]
}

test('plan stage: apply_patch is denied by the waterfall with guidance', async () => {
  const harness = await createHarness()
  const agent = makeAgent(process.cwd(), harness)
  await created(harness, agent)
  const advanced = await reachPlan(harness, agent)
  assert.equal(advanced.ok, true, 'requirements observation lets plan start')

  const decision = await harness.preExecute(agent, 'apply_patch', { input: 'x' })
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /not available in the plan stage/)
  assert.match(decision.reason, /delegate_implement/)
  assert.notEqual(decision.kind, 'ask')
})

test('plan stage: the monotonic guard refuses the same call', async () => {
  const harness = await createHarness()
  const agent = makeAgent(process.cwd(), harness)
  await created(harness, agent)
  await reachPlan(harness, agent)
  assert.equal(harness.guards.length, 1, 'exactly one guard is registered through ctx.tools.guard')

  const denial = harness.guards[0]({ agent, name: 'apply_patch', arguments: {} })
  assert.equal(typeof denial, 'string')
  assert.match(denial, /plan stage/)
  // A call the stage allows passes the guard untouched.
  assert.equal(harness.guards[0]({ agent, name: 'read', arguments: {} }), undefined)
})

test('codex plan requires coding_handoff before advancing', async () => {
  const harness = await createHarness()
  const agent = makeAgent(process.cwd(), harness)
  await created(harness, agent)
  await harness.postExecute({ agent, name: 'read', arguments: {} }, { isError: false, value: '' })

  const refused = await harness.callTool(TOOL.stage, { stage: 'plan' }, agent)
  assert.equal(refused.ok, false, 'a requirements observation alone no longer opens plan')
  assert.match(refused.reason, /coding_handoff/)

  await harness.callTool(TOOL.handoff, { goal: 'fix the bug' }, agent)
  const advanced = await harness.callTool(TOOL.stage, { stage: 'plan' }, agent)
  assert.equal(advanced.ok, true, 'the recorded goal lets plan start')
})

test('implement: the tool table is trimmed to the delegation set', async () => {
  const harness = await createHarness()
  const agent = makeAgent(process.cwd(), harness)
  await created(harness, agent)
  await reachPlan(harness, agent)
  writePlan(harness, agent)

  const advanced = await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)
  assert.equal(advanced.ok, true)

  const table = harness.visible()
  assert.equal(table.includes('apply_patch'), false, 'the lead must not see apply_patch during implement')
  assert.equal(table.includes('edit'), false)
  assert.equal(table.includes('write'), false)
  assert.equal(table.includes(TOOL.implement), true)
  assert.deepEqual(
    [...table].sort(),
    [...IMPLEMENT_TABLE].filter(name => harness.tools.has(name)).sort(),
  )

  // Denying at dispatch is separate from hiding: both hold.
  const decision = await harness.preExecute(agent, 'apply_patch')
  assert.equal(decision.kind, 'deny')
})

test('verify and deliver admit todo_write so the task list can be closed', async () => {
  const harness = await createHarness({ exitCode: 0 })
  const agent = makeAgent(process.cwd(), harness)
  await created(harness, agent)
  await reachPlan(harness, agent)
  writePlan(harness, agent)
  await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)
  await harness.callTool(TOOL.implement, { task: 'fix it' }, agent)
  await harness.callTool(TOOL.stage, { stage: 'verify' }, agent)

  assert.equal((await harness.preExecute(agent, 'todo_write')).kind, 'allow', 'verify can close a finished step')
  assert.equal(harness.guards[0]({ agent, name: 'todo_write', arguments: {} }), undefined)

  await harness.callTool(TOOL.verification, { kind: 'test', scope: 'package' }, agent)
  await harness.callTool(TOOL.stage, { stage: 'deliver' }, agent)
  assert.equal((await harness.preExecute(agent, 'todo_write')).kind, 'allow', 'deliver can close the last step')
  assert.equal(harness.guards[0]({ agent, name: 'todo_write', arguments: {} }), undefined)
})

test('verify requires a recorded acceptance check', async () => {
  const harness = await createHarness()
  const agent = makeAgent(process.cwd(), harness)
  await created(harness, agent)
  await harness.postExecute({ agent, name: 'read', arguments: {} }, { isError: false, value: '' })
  // A goal alone opens plan and implement; only a definition of done opens verify.
  await harness.callTool(TOOL.handoff, { goal: 'fix the bug' }, agent)
  await harness.callTool(TOOL.stage, { stage: 'plan' }, agent)
  writePlan(harness, agent)
  await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)
  await harness.callTool(TOOL.implement, { task: 'fix it' }, agent)

  const refused = await harness.callTool(TOOL.stage, { stage: 'verify' }, agent)
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /acceptance|definition of done/)

  await harness.callTool(TOOL.handoff, { acceptance: ['the failing test passes'] }, agent)
  const advanced = await harness.callTool(TOOL.stage, { stage: 'verify' }, agent)
  assert.equal(advanced.ok, true, 'the recorded acceptance check lets verify start')
})

test('delegation requires the implement stage and reports the configured route', async () => {
  const harness = await createHarness()
  const agent = makeAgent(process.cwd(), harness)
  await created(harness, agent)

  await assert.rejects(
    () => harness.callTool(TOOL.implement, { task: 'do it' }, agent),
    /runs only in the implement stage/,
  )

  await reachPlan(harness, agent)
  writePlan(harness, agent)
  await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)
  const result = await harness.callTool(TOOL.implement, { task: 'fix the bug', files: ['src/a.ts'] }, agent)

  assert.equal(result.ok, true)
  assert.deepEqual(result.files, ['src/a.ts', 'src/b.ts'])
  const spec = harness.activations.at(-1)
  assert.equal(spec.agentPreset, 'dsh-coding-implement', 'the child preset is the tool whitelist')
  assert.deepEqual(spec.agentOptions, { provider: 'deepseek-account', model: 'deepseek-flash' })
  assert.equal(spec.delivery, 'caller')
  assert.ok(spec.outputSchema, 'the child must return a structured report')
  assert.match(spec.name, /^implement-[0-9a-z]+-\d+$/u, 'each dispatch takes a fresh name')
  assert.equal(spec.label, 'implement: fix the bug', 'the catalog label names the brief')

  // The reported edit satisfies the verify gate.
  const verify = await harness.callTool(TOOL.stage, { stage: 'verify' }, agent)
  assert.equal(verify.ok, true)
})

test('an unusable worker model fails the dispatch without starting a worker', async () => {
  const harness = await createHarness()
  const agent = makeAgent(process.cwd(), harness)
  await created(harness, agent)
  await reachPlan(harness, agent)
  writePlan(harness, agent)
  await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)

  // The catalog names the route but refuses to resolve it.
  harness.ctx.llm.resolveModelInfo = async () => { throw new Error('unknown model') }
  harness.ctx.llm.listModels = async () => [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-flash' }]

  await assert.rejects(
    () => harness.callTool(TOOL.implement, { task: 'fix it' }, agent),
    (error) => {
      assert.match(error.message, /not a usable model route/)
      assert.match(error.message, /implementWorkerModel/)
      assert.match(error.message, /deepseek-v4-pro/)
      assert.match(error.message, /never falls back/)
      return true
    },
  )
  assert.equal(harness.activations.length, 0, 'the dispatch is refused before any worker starts')
})

test('a delegate failure is reported once to the user and cleared by a later success', async () => {
  const harness = await createHarness()
  const agent = makeAgent(process.cwd(), harness)
  await created(harness, agent)
  await reachPlan(harness, agent)
  writePlan(harness, agent)
  await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)

  // The live catalog refuses the configured worker route: no worker starts.
  harness.ctx.llm.resolveModelInfo = async () => { throw new Error('model missing') }
  await assert.rejects(
    () => harness.callTool(TOOL.implement, { task: 'fix it' }, agent),
    /model missing|not a usable model route/,
  )

  // The interruption is durable state, not only an exception in the tool call.
  const view = await harness.callTool(TOOL.stage, {}, agent)
  assert.equal(view.checkpoint.failure.point, 'delegate')
  assert.match(view.checkpoint.failure.reason, /model missing/)
  assert.match(view.status, /failure delegate/)

  // The model is told what broke and what to do before its next step.
  const step = await harness.preStep(agent, [])
  const notice = step.messages.find((message) => message.source?.kind === 'dsh-coding-control')
  assert.ok(notice, 'the failure rides a control notice')
  const text = notice.content[0].text
  assert.match(text, /运行中断|runtime failure/)
  assert.match(text, /model missing/)
  assert.match(text, /处理|What to do/)

  // It is a one-shot notice: the next step repeats neither the card nor the text.
  const again = await harness.preStep(agent, [])
  assert.equal(
    again.messages.some((message) => message.source?.kind === 'dsh-coding-control'),
    false,
    'the notice is delivered exactly once',
  )

  // Once the route resolves, the same dispatch succeeds and clears the failure.
  harness.ctx.llm.resolveModelInfo = undefined
  const retried = await harness.callTool(TOOL.implement, { task: 'fix it' }, agent)
  assert.equal(retried.ok, true)
  const cleared = await harness.callTool(TOOL.stage, {}, agent)
  assert.equal(cleared.checkpoint.failure, undefined, 'a successful dispatch clears the failure')
  assert.doesNotMatch(cleared.status, /failure delegate/)
})

test('deliver: a failed verification refuses the advance and blocks the next step', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-coding-'))
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'exit 1' } }))
  const harness = await createHarness({ exitCode: 1 })
  const agent = makeAgent(dir, harness)
  await created(harness, agent)
  await reachPlan(harness, agent)
  writePlan(harness, agent)
  await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)
  await harness.callTool(TOOL.implement, { task: 'fix it' }, agent)
  await harness.callTool(TOOL.stage, { stage: 'verify' }, agent)

  const run = await harness.callTool(TOOL.verification, { kind: 'test', scope: 'package' }, agent)
  assert.equal(run.passed, false)
  assert.equal(run.command, 'npm run test')
  assert.deepEqual(run.failedTests, ['adds numbers'])

  const refused = await harness.callTool(TOOL.stage, { stage: 'deliver' }, agent)
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /verification has not passed/)

  const step = await harness.preStep(agent, [])
  assert.equal(step.kind, 'reject', 'skipping the gate blocks the next step')

  // Once the check passes, delivery is allowed.
  harness.setExitCode(0)
  const again = await harness.callTool(TOOL.verification, { kind: 'test', scope: 'package' }, agent)
  assert.equal(again.passed, true)
  const delivered = await harness.callTool(TOOL.stage, { stage: 'deliver' }, agent)
  assert.equal(delivered.ok, true)
})

test('a failed verification blocks delivery after the retry budget', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-coding-budget-'))
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'exit 1' } }))
  const harness = await createHarness({ exitCode: 1 })
  harness.ctx.dshCodingRuntime.options = { ...CONFIG, maxVerifyAttempts: 2, maxSameFailure: 0 }
  const agent = makeAgent(dir, harness)
  await created(harness, agent)
  await reachPlan(harness, agent)
  writePlan(harness, agent)
  await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)
  await harness.callTool(TOOL.implement, { task: 'fix it' }, agent)
  await harness.callTool(TOOL.stage, { stage: 'verify' }, agent)

  // Two failures spend the whole budget; the loop must stop instead of looping.
  await harness.callTool(TOOL.verification, { kind: 'test', scope: 'package' }, agent)
  await harness.callTool(TOOL.verification, { kind: 'test', scope: 'package' }, agent)

  const blocked = await harness.callTool(TOOL.stage, { stage: 'deliver' }, agent)
  assert.equal(blocked.ok, true, 'an exhausted budget grants the exit instead of dead-locking')
  assert.equal(blocked.blocked, true)
  assert.equal(blocked.stage, 'deliver')
  assert.match(blocked.status, /BLOCKED/)
  assert.equal(blocked.checkpoint.verifyAttempts, 2)
  assert.equal(blocked.checkpoint.verifyBlocked.attempts, 2)

  // A passing check clears the budget and restores a normal delivery.
  harness.setExitCode(0)
  assert.equal((await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)).ok, true)
  assert.equal((await harness.callTool(TOOL.stage, { stage: 'verify' }, agent)).ok, true)
  const passed = await harness.callTool(TOOL.verification, { kind: 'test', scope: 'package' }, agent)
  assert.equal(passed.passed, true)
  const delivered = await harness.callTool(TOOL.stage, { stage: 'deliver' }, agent)
  assert.equal(delivered.ok, true)
  assert.equal('blocked' in delivered, false, 'a passing check restores an ordinary delivery')
  assert.equal(delivered.checkpoint.verifyBlocked, undefined)
})

test('/coding reset clears an exhausted retry budget', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-coding-reset-'))
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'exit 1' } }))
  const harness = await createHarness({ exitCode: 1 })
  harness.ctx.dshCodingRuntime.options = { ...CONFIG, maxVerifyAttempts: 2, maxSameFailure: 0 }
  const agent = makeAgent(dir, harness)
  await created(harness, agent)
  await reachPlan(harness, agent)
  writePlan(harness, agent)
  await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)
  await harness.callTool(TOOL.implement, { task: 'fix it' }, agent)
  await harness.callTool(TOOL.stage, { stage: 'verify' }, agent)
  await harness.callTool(TOOL.verification, { kind: 'test', scope: 'package' }, agent)
  await harness.callTool(TOOL.verification, { kind: 'test', scope: 'package' }, agent)
  const blocked = await harness.callTool(TOOL.stage, { stage: 'deliver' }, agent)
  assert.equal(blocked.blocked, true)

  // The same blocked exit through the user command must publish the same
  // state: the session already sits in deliver, so applyStage returns early
  // and only the flag makes the status line disclose the failing check.
  const blockedView = harness.commands[0].handler({ agent, rawInput: 'stage deliver' })
  assert.equal(blockedView.kind, 'success')
  assert.match(blockedView.text, /delivery BLOCKED/)

  const reset = harness.commands[0].handler({ agent, rawInput: 'reset' })
  assert.equal(reset.kind, 'success')
  assert.match(reset.text, /retry budget reset/)

  // The budget is gone, but the failed verification still refuses delivery.
  const refused = await harness.callTool(TOOL.stage, { stage: 'deliver' }, agent)
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /verification has not passed/)
})

test('pre-step injects the stage contract instead of a global prompt', async () => {
  const harness = await createHarness()
  const agent = makeAgent(process.cwd(), harness)
  await created(harness, agent)
  const claimed = [{ role: 'user', id: 'u1', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }]

  const decision = await harness.preStep(agent, claimed)
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 2, 'the claimed message plus one injected context')
  const injected = decision.messages[1]
  assert.equal(injected.source.kind, 'dsh-coding-stage')
  assert.equal(injected.source.form, 'notice')
  assert.match(injected.content[0].text, /dsh-coding runtime/)
  assert.match(injected.content[0].text, /### requirements/)
})

test('a mode without the current stage resets to its entry stage', async () => {
  const harness = await createHarness()
  const agent = makeAgent(process.cwd(), harness)
  await created(harness, agent)
  const switched = await harness.callTool(TOOL.mode, { mode: 'review' }, agent)
  assert.equal(switched.mode, 'review')
  assert.equal(switched.stage, 'requirements')
  const refused = await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /not part of review mode/)
})

test('auto mode selects a workflow in requirements without blocking the next step', async () => {
  const harness = await createHarness()
  harness.ctx.dshCodingRuntime.options = { ...CONFIG, defaultMode: 'auto' }
  const agent = makeAgent(process.cwd(), harness)
  await created(harness, agent)

  const status = await harness.callTool(TOOL.stage, {}, agent)
  assert.equal(status.mode, 'auto')
  assert.equal(status.stage, 'requirements')

  const early = await harness.callTool(TOOL.stage, { stage: 'plan' }, agent)
  assert.equal(early.ok, false)
  assert.equal(early.soft, true)
  assert.match(early.reason, /coding_mode/)

  // The refusal is a decision, not a skipped gate: the next step must run.
  assert.equal((await harness.preStep(agent, [])).kind, 'enter')

  // One requirements observation, then choose the fallback workflow.
  await harness.postExecute({ agent, name: 'read', arguments: {} }, { isError: false, value: '' })
  const chosen = await harness.callTool(TOOL.mode, { mode: 'consult' }, agent)
  assert.equal(chosen.mode, 'consult')
  assert.equal(chosen.stage, 'requirements')
  const delivered = await harness.callTool(TOOL.stage, { stage: 'deliver' }, agent)
  assert.equal(delivered.ok, true)
})

test('/coding control verbs reach the agent as steering or follow-up', async () => {
  const harness = await createHarness()
  const agent = makeAgent(process.cwd(), harness)
  const steered = []
  const followed = []
  agent.steer = (message) => steered.push(message)
  agent.followup = (message) => followed.push(message)
  await created(harness, agent)

  assert.equal(harness.commands.length, 1)
  const command = harness.commands[0]
  assert.equal(command.name, 'coding')

  const status = command.handler({ agent, rawInput: '' })
  assert.equal(status.kind, 'success')

  // A gate that is not satisfied is refused, not silently accepted.
  const refused = command.handler({ agent, rawInput: 'stage deliver' })
  assert.equal(refused.kind, 'error')
  assert.match(refused.text, /verification has not passed/)

  // A mode switch queues a follow-up turn.
  const switched = command.handler({ agent, rawInput: 'review' })
  assert.equal(switched.kind, 'success')
  assert.equal(followed.length, 1)
  assert.equal(followed[0].source.kind, 'dsh-coding-control')

  // A stage move steers the live turn.
  const moved = command.handler({ agent, rawInput: 'stage verify' })
  assert.equal(moved.kind, 'success')
  assert.equal(steered.length, 1)
  assert.equal(steered[0].source.kind, 'dsh-coding-control')

  // `set` is the silent pre-Turn path: the mode changes, no Turn starts.
  const silent = command.handler({ agent, rawInput: 'set review' })
  assert.equal(silent.kind, 'success')
  assert.match(silent.text, /mode set to review/)
  assert.equal(followed.length, 1, 'set never queues a follow-up Turn')
  assert.equal(steered.length, 1, 'set never steers the live Turn')
  assert.equal(command.handler({ agent, rawInput: 'set shipping' }).kind, 'error')
})

test('a misconfigured worker route fails the mount instead of inheriting the lead model', async () => {
  const harness = await createHarness()
  harness.ctx.dshCodingRuntime.options = { ...CONFIG, implementWorkerModel: '' }
  await assert.rejects(() => preset.apply(harness.ctx), /implementWorkerModel is required/)
})

test('a refused advance re-injects its reason with the next contract', async () => {
  const harness = await createHarness()
  const agent = makeAgent(process.cwd(), harness)
  await created(harness, agent)

  // The model asks for implement without a task list: refused, and the
  // following step is blocked (skipping a gate is the documented penalty).
  const refused = await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)
  assert.equal(refused.ok, false)
  assert.equal((await harness.preStep(agent, [])).kind, 'reject')

  // The blocked turn carried no messages, so the reason must arrive with the
  // next step's contract.
  const decision = await harness.preStep(agent, [])
  assert.equal(decision.kind, 'enter')
  const injected = decision.messages.at(-1).content[0].text
  assert.match(injected, /last stage advance was refused/)
  assert.match(injected, /todo_write/)

  // Once delivered, it is not repeated.
  const again = await harness.preStep(agent, [])
  assert.doesNotMatch(again.messages.at(-1).content[0].text, /last stage advance was refused/)
})

test('a user /coding refusal reports the gate without blocking the next step', async () => {
  const harness = await createHarness()
  const agent = makeAgent(process.cwd(), harness)
  await created(harness, agent)
  const command = harness.commands[0]

  const result = command.handler({ agent, rawInput: 'stage implement' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /todo_write/)

  const decision = await harness.preStep(agent, [])
  assert.equal(decision.kind, 'enter', 'a user-issued move never blocks the model')
})

test('a verify worker that names no command cannot satisfy the deliver gate', async () => {
  const harness = await createHarness()
  // The fake child reports ok without a command: not evidence.
  harness.ctx.subagents.startActivation = async (spec) => ({
    childId: spec.agentPreset === 'dsh-coding-implement' ? 'child-implement' : 'child-verify',
    name: 'lead/worker',
    messageId: 'm2',
    result: Promise.resolve({
      stopReason: 'completed',
      structured: spec.agentPreset === 'dsh-coding-implement'
        ? { ok: true, summary: 'changed one file', files: ['src/a.ts'] }
        : { ok: true, summary: 'looks fine' },
      output: [],
    }),
    dispose: async () => {},
  })
  const agent = makeAgent(process.cwd(), harness)
  await created(harness, agent)
  await reachPlan(harness, agent)
  writePlan(harness, agent)
  await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)
  await harness.callTool(TOOL.implement, { task: 'fix it' }, agent)
  await harness.callTool(TOOL.stage, { stage: 'verify' }, agent)

  const delegation = await harness.callTool(TOOL.verify, { task: 'check it' }, agent)
  assert.equal(delegation.ok, true, 'the worker itself completed')
  const refused = await harness.callTool(TOOL.stage, { stage: 'deliver' }, agent)
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /verification has not passed/)
})

test('a resumed session keeps its recorded stage, plan, and verification', async () => {
  const harness = await createHarness({ projectionEvents: resumeEvents('implement', RESUME_VERIFICATION) })
  const agent = makeAgent(process.cwd(), harness)
  await created(harness, agent)

  const inspected = await harness.callTool(TOOL.stage, {}, agent)
  assert.equal(inspected.ok, true)
  assert.equal(inspected.stage, 'implement', 'the projection reseeds the stage instead of restarting at requirements')
  assert.equal(harness.visible().includes('apply_patch'), false, 'the restored implement table is trimmed')

  const verify = await harness.callTool(TOOL.stage, { stage: 'verify' }, agent)
  assert.equal(verify.ok, true, 'the restored edit count satisfies the verify gate')

  const deliver = await harness.callTool(TOOL.stage, { stage: 'deliver' }, agent)
  assert.equal(deliver.ok, true, 'the restored verification satisfies the deliver gate')
})

test('a resumed plan stage advances on its recorded task list', async () => {
  // This checkpoint predates the handoff, so it carries neither a goal nor an
  // acceptance check: advancing plan → implement only needs the task list.
  const harness = await createHarness({ projectionEvents: resumeEvents('plan', undefined, null) })
  const agent = makeAgent(process.cwd(), harness)
  await created(harness, agent)

  const advanced = await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)
  assert.equal(advanced.ok, true, 'the restored plan satisfies the plan gate')
})

test('two delegations take distinct worker names', async () => {
  const harness = await createHarness()
  const agent = makeAgent(process.cwd(), harness)
  await created(harness, agent)
  await reachPlan(harness, agent)
  writePlan(harness, agent)
  await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)

  await harness.callTool(TOOL.implement, { task: 'first change' }, agent)
  // The name carries a millisecond timestamp, so two dispatches need the clock
  // to tick to be distinguishable; a real dispatch takes far longer than that.
  await new Promise((resolve) => setTimeout(resolve, 2))
  await harness.callTool(TOOL.implement, { task: 'second change' }, agent)
  const [first, second] = harness.activations
  assert.match(first.name, /^implement-[0-9a-z]+-\d+$/u)
  assert.match(second.name, /^implement-[0-9a-z]+-\d+$/u)
  assert.notEqual(first.name, second.name, 'the parent catalog never releases a committed name')
})

test('a repeated report of the same path does not double the edit count', async () => {
  const harness = await createHarness()
  const agent = makeAgent(process.cwd(), harness)
  await created(harness, agent)
  await reachPlan(harness, agent)
  writePlan(harness, agent)
  await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)

  // Both workers re-report the same two paths; a dispatch total would say four.
  const first = await harness.callTool(TOOL.implement, { task: 'first change' }, agent)
  const second = await harness.callTool(TOOL.implement, { task: 'second change' }, agent)
  assert.equal(first.checkpoint.edits, 2)
  assert.deepEqual(first.checkpoint.files, ['src/a.ts', 'src/b.ts'])
  assert.equal(second.checkpoint.edits, 2, 'the same paths are counted once')
  assert.deepEqual(second.checkpoint.files, ['src/a.ts', 'src/b.ts'])

  // A worker that overlaps one path and adds another moves the count to three.
  harness.ctx.subagents.startActivation = async (spec) => {
    harness.activations.push(spec)
    return {
      childId: 'child-3',
      name: 'lead/worker',
      messageId: 'm5',
      result: Promise.resolve({
        stopReason: 'completed',
        structured: { ok: true, summary: 'changed two files', files: ['src/b.ts', 'src/c.ts'] },
        output: [],
      }),
      dispose: async () => {},
    }
  }
  const third = await harness.callTool(TOOL.implement, { task: 'third change' }, agent)
  assert.equal(third.checkpoint.edits, 3, 'only the path not seen before is added')
  assert.deepEqual(third.checkpoint.files, ['src/a.ts', 'src/b.ts', 'src/c.ts'])
})

test('a remounted plugin still dispatches: a committed worker name is never reused', async () => {
  const harness = await createHarness({ projectionEvents: resumeEvents('implement') })
  // The fake parent catalog keeps every committed name and refuses a repeat,
  // exactly like the Host does across a restart.
  const committed = new Set()
  harness.ctx.subagents.startActivation = async (spec) => {
    harness.activations.push(spec)
    if (committed.has(spec.name)) {
      throw new Error(`agent name "${spec.name}" is already used by another subagent you created; choose another name`)
    }
    committed.add(spec.name)
    return {
      childId: `child-${committed.size}`,
      name: 'lead/worker',
      messageId: 'm4',
      result: Promise.resolve({
        stopReason: 'completed',
        structured: { ok: true, summary: 'changed one file', files: ['src/a.ts'] },
        output: [],
      }),
      dispose: async () => {},
    }
  }
  const agent = makeAgent(process.cwd(), harness)
  await created(harness, agent)

  const first = await harness.callTool(TOOL.implement, { task: 'first change' }, agent)
  assert.equal(first.ok, true, 'the first dispatch starts a worker')

  // A Host restart rebuilds the plugin instance, while the parent catalog and
  // the names already committed to it survive.
  await preset.apply(harness.ctx)
  await created(harness, agent)
  // The name carries a millisecond timestamp, so let the clock tick: a real
  // dispatch takes far longer than one millisecond.
  await new Promise((resolve) => setTimeout(resolve, 2))

  const second = await harness.callTool(TOOL.implement, { task: 'second change' }, agent)
  assert.equal(second.ok, true, 'the remounted plugin must not collide with the previous generation')
  assert.equal(committed.size, 2, 'both dispatches committed a name')
  assert.notEqual(harness.activations[0].name, harness.activations[1].name)
})

test('a verify worker that reports failing tests cannot satisfy the deliver gate', async () => {
  const harness = await createHarness()
  harness.ctx.subagents.startActivation = async (spec) => ({
    childId: spec.agentPreset === 'dsh-coding-implement' ? 'child-implement' : 'child-verify',
    name: 'lead/worker',
    messageId: 'm3',
    result: Promise.resolve({
      stopReason: 'completed',
      structured: spec.agentPreset === 'dsh-coding-implement'
        ? { ok: true, summary: 'changed one file', files: ['src/a.ts'] }
        : {
          ok: true,
          summary: 'one failure',
          command: 'npm run test',
          kind: 'test',
          scope: 'package',
          failedTests: ['adds numbers'],
        },
      output: [],
    }),
    dispose: async () => {},
  })
  const agent = makeAgent(process.cwd(), harness)
  await created(harness, agent)
  await reachPlan(harness, agent)
  writePlan(harness, agent)
  await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)
  await harness.callTool(TOOL.implement, { task: 'fix it' }, agent)
  await harness.callTool(TOOL.stage, { stage: 'verify' }, agent)

  const delegation = await harness.callTool(TOOL.verify, { task: 'check it' }, agent)
  assert.deepEqual(delegation.failedTests, ['adds numbers'], 'the failing tests reach the lead')
  const refused = await harness.callTool(TOOL.stage, { stage: 'deliver' }, agent)
  assert.equal(refused.ok, false, 'a self-contradictory report is not evidence')
  assert.match(refused.reason, /verification has not passed/)
})

test('the exported preset roster hides the three worker presets and restores on dispose', async () => {
  const { filterWorkerPresets, installWorkerPresetFilter } = await import('../lib/index.js')
  const ROSTER = [
    { id: 'standard', isDefault: true },
    { id: 'dsh-coding', isDefault: false, name: 'Coding' },
    { id: 'dsh-coding-planner', isDefault: false },
    { id: 'dsh-coding-implement', isDefault: false },
    { id: 'dsh-coding-verify', isDefault: false },
    { id: 'broken-preset', isDefault: false, broken: 'activation failed' },
  ]
  assert.deepEqual(
    filterWorkerPresets({ presets: ROSTER }).presets.map(row => row.id),
    ['standard', 'dsh-coding', 'broken-preset'],
  )
  const registry = { remoteExportList: async () => ({ presets: ROSTER }) }
  const original = registry.remoteExportList
  const disposers = []
  const ctx = {
    inject(names, callback) { assert.deepEqual(names, ['agentPresets']); callback({ agentPresets: registry, effect(fn) { disposers.push(fn()); return fn } }) },
  }
  installWorkerPresetFilter(ctx)
  assert.deepEqual(
    (await registry.remoteExportList()).presets.map(row => row.id),
    ['standard', 'dsh-coding', 'broken-preset'],
  )
  disposers[0]()
  assert.equal(registry.remoteExportList, original, 'dispose restores the registry method')
  assert.equal((await registry.remoteExportList()).presets.length, ROSTER.length)
})

test('the subagent catalog label carries the brief summary', () => {
  const { workerLabel } = preset
  assert.equal(workerLabel('implement', 'fix the bug'), 'implement: fix the bug')
  assert.equal(workerLabel('verify', '\n\n  run   the   suite  \nsecond line'), 'verify: run the suite')
  assert.equal(workerLabel('implement', ''), 'implement: change')
  assert.equal(workerLabel('verify', '\n \n'), 'verify: change')
  const long = workerLabel('implement', 'x'.repeat(120))
  assert.equal(long, `implement: ${'x'.repeat(60)}`)
  assert.ok(long.length <= 60 + 'implement: '.length)
})

test('coding_reasoning reports the automatic choice and accepts a session override', async () => {
  const harness = await createHarness()
  const agent = makeAgent(process.cwd(), harness)
  await created(harness, agent)

  const inspected = await harness.callTool(TOOL.reasoning, {}, agent)
  assert.equal(inspected.ok, true)
  assert.equal(inspected.reasoning, '')
  assert.equal(inspected.source, 'auto')

  const pinned = await harness.callTool(TOOL.reasoning, { effort: 'max' }, agent)
  assert.equal(pinned.ok, true)
  assert.equal(pinned.reasoning, 'max')
  assert.equal(pinned.source, 'manual')

  const cleared = await harness.callTool(TOOL.reasoning, { effort: 'auto' }, agent)
  assert.equal(cleared.ok, true)
  assert.equal(cleared.source, 'auto')
})

test('the reasoning verb stays callable in every stage and in the trimmed implement table', async () => {
  const harness = await createHarness()
  const agent = makeAgent(process.cwd(), harness)
  await created(harness, agent)
  await reachPlan(harness, agent)
  assert.equal((await harness.preExecute(agent, TOOL.reasoning)).kind, 'allow')
  writePlan(harness, agent)
  await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)
  assert.equal(harness.visible().includes(TOOL.reasoning), true)
})

test('pre-step classifies the admitted request and writes the model effort', async () => {
  const harness = await createHarness()
  harness.ctx.llm.resolveModelInfo = async () => ({
    reasoning: { efforts: [{ id: 'low' }, { id: 'high' }, { id: 'max' }] },
  })
  const selection = { current: { provider: 'deepseek-account', model: 'deepseek-flash' } }
  const agent = makeAgent(process.cwd(), harness)
  agent.model = {
    current: () => ({ ...selection.current }),
    select: (next) => { selection.current = { ...next } },
  }
  agent.session.deriveMessages = () => [{
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: '修改 src/a.ts 和 src/b.ts，共享同一个 mapper' }],
  }]
  await created(harness, agent)
  await harness.preStep(agent)
  assert.equal(selection.current.reasoningEffort, 'high')
})

test('delegate_plan dispatches the planner preset with the pro route and returns tasks', async () => {
  const harness = await createHarness()
  const agent = makeAgent(process.cwd(), harness)
  await created(harness, agent)

  await assert.rejects(
    () => harness.callTool(TOOL.plan, { task: 'plan it' }, agent),
    /runs only in the plan stage/,
  )

  await reachPlan(harness, agent)
  const result = await harness.callTool(TOOL.plan, { task: 'add a flag' }, agent)
  assert.equal(result.ok, true)
  // A bare string task from an older prompt still normalizes into a handoff task.
  assert.deepEqual(result.tasks, [
    { goal: 'add the flag', files: [], acceptance: '' },
    { goal: 'cover it with a test', files: [], acceptance: '' },
  ])
  const spec = harness.activations.at(-1)
  assert.equal(spec.agentPreset, 'dsh-coding-planner', 'the planner preset is the child scope')
  assert.deepEqual(spec.agentOptions, { provider: 'deepseek-account', model: 'deepseek-v4-pro' })
  assert.match(spec.name, /^plan-[0-9a-z]+-\d+$/u)
})

test('worker reports flow into the handoff', async () => {
  const harness = await createHarness()
  harness.ctx.subagents.startActivation = async (spec) => {
    harness.activations.push(spec)
    const structured = spec.agentPreset === 'dsh-coding-planner'
      ? { ok: true, summary: 'planned the work', tasks: [{ goal: 'add flag', files: ['src/a.ts'], acceptance: 'test passes' }] }
      : { ok: true, summary: 'changed two files', files: ['src/a.ts', 'src/b.ts'] }
    return {
      childId: 'child-1',
      name: 'lead/worker',
      messageId: 'm1',
      result: Promise.resolve({ stopReason: 'completed', structured, output: [] }),
      dispose: async () => {},
    }
  }
  const agent = makeAgent(process.cwd(), harness)
  await created(harness, agent)
  await reachPlan(harness, agent)

  await harness.callTool(TOOL.plan, { task: 'add a flag' }, agent)
  const planned = await harness.callTool(TOOL.handoff, {}, agent)
  assert.match(planned.digest, /add flag/, 'the planner task list reaches the handoff')
  assert.match(planned.digest, /test passes/, 'the task acceptance check reaches the handoff')
  const plannerPrompt = harness.activations.at(-1).prompt[0].text
  assert.match(plannerPrompt, /## Handoff/)
  assert.match(plannerPrompt, /fix the bug/)

  writePlan(harness, agent)
  await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)
  await harness.callTool(TOOL.implement, { task: 'add the flag' }, agent)
  const implemented = await harness.callTool(TOOL.handoff, {}, agent)
  assert.match(implemented.digest, /src\/a\.ts/, 'the implement worker files become the handoff changes')

  const implementPrompt = harness.activations.at(-1).prompt[0].text
  assert.match(implementPrompt, /## Handoff/)
  assert.match(implementPrompt, /fix the bug/)
  assert.match(implementPrompt, /add flag/)
  assert.doesNotMatch(implementPrompt, /## Task list from the lead/, 'a handoff with tasks replaces the raw task list')
})

test('a second dispatch while a worker is running is refused', async () => {
  const harness = await createHarness()
  const agent = makeAgent(process.cwd(), harness)
  await created(harness, agent)
  await reachPlan(harness, agent)
  writePlan(harness, agent)
  await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)

  let release
  harness.ctx.subagents.startActivation = async (spec) => {
    harness.activations.push(spec)
    return {
      childId: 'child-slow',
      name: 'lead/worker',
      messageId: 'm9',
      result: new Promise((resolve) => { release = resolve }),
      dispose: async () => {},
    }
  }
  const first = harness.callTool(TOOL.implement, { task: 'first change' }, agent)
  await assert.rejects(
    () => harness.callTool(TOOL.implement, { task: 'second change' }, agent),
    /already running/,
  )
  release({ stopReason: 'completed', structured: { ok: true, summary: 'done', files: ['src/a.ts'] }, output: [] })
  const done = await first
  assert.equal(done.ok, true)
})

test('a new implementation invalidates an earlier verification', async () => {
  const harness = await createHarness({ exitCode: 0 })
  const agent = makeAgent(process.cwd(), harness)
  await created(harness, agent)
  await reachPlan(harness, agent)
  writePlan(harness, agent)
  await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)
  await harness.callTool(TOOL.implement, { task: 'first change' }, agent)
  await harness.callTool(TOOL.stage, { stage: 'verify' }, agent)
  const run = await harness.callTool(TOOL.verification, { kind: 'test', scope: 'package' }, agent)
  assert.equal(run.passed, true)

  // A follow-up implementation means the earlier pass no longer covers the tree.
  await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)
  const second = await harness.callTool(TOOL.implement, { task: 'second change' }, agent)
  assert.equal('verification' in second.checkpoint, false, 'the stale pass is cleared')

  const deliver = await harness.callTool(TOOL.stage, { stage: 'deliver' }, agent)
  assert.equal(deliver.ok, false)
  assert.match(deliver.reason, /verification has not passed/)
})

test('an unresolvable verification command is still recorded as evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-coding-noverify-'))
  const harness = await createHarness()
  const agent = makeAgent(dir, harness)
  await created(harness, agent)
  await reachPlan(harness, agent)
  writePlan(harness, agent)
  await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)
  await harness.callTool(TOOL.implement, { task: 'change it' }, agent)
  await harness.callTool(TOOL.stage, { stage: 'verify' }, agent)

  await assert.rejects(
    () => harness.callTool(TOOL.verification, { kind: 'test', scope: 'package' }, agent),
    /no package\.json/,
  )
  // The failed attempt is still recorded, so the card and a review delivery can
  // disclose it instead of dead-locking on an undefined verification.
  const view = await harness.callTool(TOOL.stage, {}, agent)
  assert.equal(view.checkpoint.verification.passed, false)
  assert.match(view.checkpoint.verification.errors.join(' '), /no package\.json/)

  // A check that could not even start is a runtime failure as well: it names
  // the subsystem and the configuration that decides the command and its bound.
  assert.equal(view.checkpoint.failure.point, 'verification')
  assert.match(view.checkpoint.failure.reason, /no package\.json/)
  const step = await harness.preStep(agent, [])
  const notice = step.messages.find((message) => message.source?.kind === 'dsh-coding-control')
  assert.ok(notice, 'the verification failure rides a control notice')
  const text = notice.content[0].text
  assert.match(text, /验证执行|Verification/)
  assert.match(text, /verificationCommands|verificationTimeoutMs/)
})
