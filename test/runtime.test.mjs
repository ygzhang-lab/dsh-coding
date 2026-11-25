/**
 * Runtime tests for the Coding preset plugin.
 *
 * The harness implements the exact Cordis surface the plugin uses (`on`,
 * `effect`, `tools.register/guard/schemas/view`, `inject`, `get`) and drives the
 * registered listeners the way the Host does: a waterfall chain for
 * `tools/pre-execute` and `agent/pre-step`, a direct call for the guard, and a
 * tool call for the verbs. It asserts the two constraints the plugin exists for:
 * a stage-forbidden edit is refused with an actionable reason, and a failed
 * verification blocks delivery.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
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
  // 测试不依赖宿主 locale：语言钉成英文，zh 场景在用例里用 config 覆盖
  language: 'en',
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
  /**
   * 生效中的 agent-scope 限制及其 disposer。插件每次阶段变化都会重算工具表并
   * 释放上一份限制，所以撤销必须在这里生效：被释放的限制不再隐藏工具。
   */
  const restrictionEntries = []
  /** 应用一条限制，返回插件按 agent 保存的 disposer。 */
  const restrictScope = (filter) => {
    const entry = { filter, active: true }
    restrictionEntries.push(entry)
    restrictions.push(filter)
    return () => {
      if (!entry.active) return
      entry.active = false
      const index = restrictions.indexOf(filter)
      if (index >= 0) restrictions.splice(index, 1)
    }
  }
  /** 所有生效中的 agent-scope 限制是否放行这个工具名。 */
  const admits = (name) => restrictionEntries.every((entry) => {
    if (!entry.active) return true
    const filter = entry.filter
    if (filter.allow !== undefined && !filter.allow.includes(name)) return false
    if (filter.deny !== undefined && filter.deny.includes(name)) return false
    return true
  })
  const activations = []
  let exitCode = options.exitCode ?? 1

  // The memory writer and `/coding init` both consume the injected fs service,
  // so a fake records what the Host would have written; `fs: null` models a
  // Host that exposes no filesystem service at all.
  const writes = []
  const files = new Map()
  const fsService = {
    async resolve(path) {
      return { targetKey: path, displayPath: `D:/proj/${path}` }
    },
    async stat(target) {
      const content = files.get(target.targetKey)
      if (content !== undefined) return { version: 'v1', type: 'file' }
      // 目录也答得上：`readLatestMemory` 先 stat 目录再 listDir，目录里有文件就算存在。
      const key = String(target.targetKey).replace(/[\\/]+$/u, '')
      const sep = key.includes('\\') ? '\\' : '/'
      for (const child of files.keys()) {
        if (child === key || child.startsWith(key + sep)) return { type: 'directory' }
      }
      return undefined
    },
    async readText(target) {
      const content = files.get(target.targetKey)
      if (content === undefined) throw new Error(`ENOENT: ${String(target.targetKey)}`)
      return content
    },
    // 读取交接文档要枚举目录：只列 `.agents/memory` 的直接子项，深层路径留给读盘报错。
    async listDir(target) {
      const key = String(target.targetKey)
      const sep = key.includes('\\') ? '\\' : '/'
      const prefix = key.replace(/[\\/]+$/u, '') + sep
      const entries = []
      for (const child of files.keys()) {
        if (!child.startsWith(prefix)) continue
        const rest = child.slice(prefix.length)
        if (rest.includes('\\') || rest.includes('/')) continue
        entries.push({ name: rest, type: 'file', target: { targetKey: child, displayPath: `D:/proj/${child}` } })
      }
      return entries
    },
    async writeText(target, content, expected, _signal, policy) {
      writes.push({ target, content, expected, policy })
      files.set(target.targetKey, content)
      return { operation: 'create', version: 'v1' }
    },
  }

  // `/coding init` 现在立即回执、后台生成：假 Host 记下 followup 回执与在途后台任务。
  // runMaintenance 模拟宿主维护名额，忙时同步抛错，插件应退回独立后台任务。
  const followups = []
  const backgroundTasks = []
  let maintenanceMode = options.maintenance ?? 'ok' // 'ok' | 'busy'
  const runMaintenance = (task) => {
    if (maintenanceMode === 'busy') throw new Error('agent is busy')
    const promise = task(new AbortController().signal)
    backgroundTasks.push(promise)
    return promise
  }
  /** 等所有排队中的后台任务 settle；后台任务的 rejection 已被运行器吞掉。 */
  async function waitForBackground() {
    while (backgroundTasks.length > 0) {
      const batch = backgroundTasks.splice(0)
      await Promise.allSettled(batch)
    }
  }
  function setMaintenanceMode(mode) { maintenanceMode = mode }

  const tools = new Map()
  const add = (definition) => {
    tools.set(definition.name, definition)
    return () => tools.delete(definition.name)
  }

  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    fs: options.fs === null ? undefined : options.fs ?? fsService,
    dshCodingRuntime: { options: { ...CONFIG, ...(options.config ?? {}) } },
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
    llm: {
      listProviders: () => [{ id: 'deepseek-account' }],
      async prepareCall(config) {
        return {
          config: { ...config },
          async *stream() {
            yield { type: 'text-delta', index: 0, text: '## 快速开始\n\n- 安装：`pnpm install`\n' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      },
    },
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
      /** 与真实 DSH 同构：schemas() 只返回当前限制放行的定义。 */
      schemas() {
        return [...tools.entries()].filter(([name]) => admits(name)).map(([, definition]) => definition)
      },
      /** 与真实 DSH 同构：view() 暴露未受限的 knownNames / restrictableNames。 */
      view() {
        const visibleTools = new Map([...tools.entries()].filter(([name]) => admits(name)))
        return {
          visible: visibleTools,
          registrations: visibleTools,
          knownNames: new Set(tools.keys()),
          restrictableNames: new Set(tools.keys()),
        }
      },
      restrict(filter) {
        return restrictScope(filter)
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

  /** Visible tool names after every active agent-scope restriction. */
  const visible = () => [...tools.keys()].filter(admits)

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
    ctx, tools, guards, restrictions, activations, commands, writes, files, followups,
    listeners, visible, preExecute, preStep, postExecute, callTool, waterfall, restrictScope,
    waitForBackground, setMaintenanceMode, runMaintenance,
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
          return harness.restrictScope(filter)
        },
      },
    },
    followup(message) {
      harness.followups.push(message)
    },
    runMaintenance(task) {
      return harness.runMaintenance(task)
    },
  }
}

/** Emit agent/created so the plugin initialises its per-agent state. */
async function created(harness, agent) {
  for (const listener of harness.listeners.get('agent/created') ?? []) {
    await listener({ agent, source: 'startup' })
  }
}

/** Emit agent/disposed so the plugin releases the agent's scope, state, and table restriction. */
function disposed(harness, agent) {
  for (const listener of harness.listeners.get('agent/disposed') ?? []) {
    listener({ agent })
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
  writePlanOf(harness, agent, ['fix the bug'])
}

/** Record a structured task list of `contents` through the durable session event. */
function writePlanOf(harness, agent, contents) {
  for (const listener of harness.listeners.get('session/event') ?? []) {
    listener({ header: { id: agent.session.header.id } }, {
      type: 'todo/write',
      time: Date.now(),
      data: { todos: contents.map((content) => ({ content, status: 'in_progress' })) },
    })
  }
}

/** Stub the worker backend: an implement report naming `files`, and a passing verify report. */
function stubWorkerReports(harness, files) {
  harness.ctx.subagents.startActivation = async (spec) => {
    harness.activations.push(spec)
    return {
      childId: 'child-1',
      name: 'lead/worker',
      messageId: 'm1',
      result: Promise.resolve({
        stopReason: 'completed',
        structured: spec.agentPreset === 'dsh-coding-implement'
          ? { ok: true, summary: 'changed the brief', files }
          : { ok: true, summary: 'the suite passes', command: 'npm run test', kind: 'test', scope: 'package' },
        output: [],
      }),
      dispose: async () => {},
    }
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
  assert.equal(table.includes('bash'), true, 'the lead keeps the shell during implement')
  assert.deepEqual(
    [...table].sort(),
    [...IMPLEMENT_TABLE].filter(name => harness.tools.has(name)).sort(),
  )

  // Denying at dispatch is separate from hiding: both hold.
  const decision = await harness.preExecute(agent, 'apply_patch')
  assert.equal(decision.kind, 'deny')
  const shell = await harness.preExecute(agent, 'bash')
  assert.equal(shell.kind, 'allow', 'the lead may run its own commands while implementing')
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

test('an auto worker route follows the lead model at dispatch', async () => {
  const harness = await createHarness({ config: { implementWorkerModel: 'auto' } })
  const agent = makeAgent(process.cwd(), harness)
  agent.model = { current: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) }
  harness.ctx.llm.listProviders = () => [{ id: 'deepseek-official' }]
  await created(harness, agent)
  await reachPlan(harness, agent)
  writePlan(harness, agent)
  await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)

  const result = await harness.callTool(TOOL.implement, { task: 'fix the flag' }, agent)
  assert.equal(result.ok, true)
  const spec = harness.activations.at(-1)
  assert.deepEqual(spec.agentOptions, { provider: 'deepseek-official', model: 'deepseek-flash' },
    'auto resolves to the lead route, not to a fixed default')
  assert.equal(spec.agentPreset, 'dsh-coding-implement')
})

test('an auto worker route refuses the dispatch when the lead model is unreadable', async () => {
  const harness = await createHarness({ config: { implementWorkerModel: 'auto' } })
  const agent = makeAgent(process.cwd(), harness)
  await created(harness, agent)
  await reachPlan(harness, agent)
  writePlan(harness, agent)
  await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)

  await assert.rejects(
    () => harness.callTool(TOOL.implement, { task: 'fix it' }, agent),
    (error) => {
      assert.match(error.message, /is "auto"/u)
      assert.match(error.message, /lead's current model/u)
      assert.match(error.message, /no other route is substituted/u)
      return true
    },
  )
  assert.equal(harness.activations.length, 0, 'the dispatch is refused before any worker starts')

  agent.model = { current: () => { throw new Error('no selection yet') } }
  await assert.rejects(
    () => harness.callTool(TOOL.implement, { task: 'fix it' }, agent),
    /no selection yet/u,
    'the reason the lead route is unreadable reaches the model',
  )
  assert.equal(harness.activations.length, 0)
})

test('planner auto counts as the lead being the planner', async () => {
  const harness = await createHarness({ config: { plannerWorkerModel: 'auto' } })
  const agent = makeAgent(process.cwd(), harness)
  await created(harness, agent)
  await reachPlan(harness, agent)
  writePlanOf(harness, agent, ['a', 'b', 'c', 'd'])

  // makeAgent carries no model at all: auto must short-circuit before any read.
  const advanced = await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)
  assert.equal(advanced.ok, true)
  assert.equal(advanced.checkpoint.planner, undefined, 'skipping the gate is not a planner attempt')
  assert.equal(harness.activations.length, 0)

  // A throwing selection must be just as harmless.
  const other = await createHarness({ config: { plannerWorkerModel: 'auto' } })
  const lead = makeAgent(process.cwd(), other)
  lead.model = { current: () => { throw new Error('no selection yet') } }
  await created(other, lead)
  await reachPlan(other, lead)
  writePlanOf(other, lead, ['a', 'b', 'c', 'd'])
  const again = await other.callTool(TOOL.stage, { stage: 'implement' }, lead)
  assert.equal(again.ok, true, 'auto never reads the model, so it cannot throw')
})

test('all-auto worker routes mount without an agent context', async () => {
  const harness = await createHarness({
    config: { implementWorkerModel: 'auto', verifyWorkerModel: 'auto', plannerWorkerModel: 'auto' },
  })
  assert.equal(harness.ctx.dshCodingRuntime.options.plannerWorkerModel, 'auto',
    'createHarness mounts the preset during construction; reaching this line means preflight accepted auto')
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
  const blockedView = await harness.commands[0].handler({ agent, rawInput: 'stage deliver' })
  assert.equal(blockedView.kind, 'success')
  assert.match(blockedView.text, /delivery BLOCKED/)

  const reset = await harness.commands[0].handler({ agent, rawInput: 'reset' })
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

  const status = await command.handler({ agent, rawInput: '' })
  assert.equal(status.kind, 'success')

  // A gate that is not satisfied is refused, not silently accepted.
  const refused = await command.handler({ agent, rawInput: 'stage deliver' })
  assert.equal(refused.kind, 'error')
  assert.match(refused.text, /verification has not passed/)

  // A mode switch queues a follow-up turn.
  const switched = await command.handler({ agent, rawInput: 'review' })
  assert.equal(switched.kind, 'success')
  assert.equal(followed.length, 1)
  assert.equal(followed[0].source.kind, 'dsh-coding-control')

  // A stage move steers the live turn.
  const moved = await command.handler({ agent, rawInput: 'stage verify' })
  assert.equal(moved.kind, 'success')
  assert.equal(steered.length, 1)
  assert.equal(steered[0].source.kind, 'dsh-coding-control')

  // `set` is the silent pre-Turn path: the mode changes, no Turn starts.
  const silent = await command.handler({ agent, rawInput: 'set review' })
  assert.equal(silent.kind, 'success')
  assert.match(silent.text, /mode set to review/)
  assert.equal(followed.length, 1, 'set never queues a follow-up Turn')
  assert.equal(steered.length, 1, 'set never steers the live Turn')
  assert.equal((await command.handler({ agent, rawInput: 'set shipping' })).kind, 'error')
})

/** 建一个 `/coding init` 用的临时项目：清单 + 一个源码文件 + README。 */
async function initProject(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'exit 0' } }))
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'src/index.ts'), 'export const answer = 42\n')
  await writeFile(join(dir, 'README.md'), '# fixture\n\nA fixture repository.\n')
  return dir
}

test('/coding init generates AGENTS.md through the session model', async () => {
  const dir = await initProject('dsh-coding-init-')
  // 回执中文：显式钉住会话语言，不依赖跑测试这台机器的 locale。
  const harness = await createHarness({ config: { language: 'zh' } })
  const agent = makeAgent(dir, harness)
  agent.model = { current: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) }
  await created(harness, agent)

  const command = harness.commands[0]
  assert.match(command.description, /init/u)
  assert.match(command.input.hint, /init/u)

  const result = await command.handler({ agent, rawInput: 'init', signal: new AbortController().signal })
  assert.equal(result.kind, 'success')
  // 命令先回执：既没写盘，也没有完成通知，模型还在后台跑。
  assert.match(result.text, /已开始文档生成/u, '回执说清任务已在后台开始')
  assert.match(result.text, /后台执行/u)
  assert.match(result.text, /deepseek-account\/deepseek-flash/u, '回执带本次使用的模型路由')
  assert.equal(harness.writes.length, 0, '回执先于写盘')
  assert.equal(harness.followups.length, 0, '回执先于完成通知')

  // 后台跑完：写出一份文档，并回一条 followup 通知。
  await harness.waitForBackground()
  assert.equal(harness.writes.length, 1, '后台任务写出一份项目级文档')
  const write = harness.writes[0]
  assert.equal(write.target.targetKey, join(dir, 'AGENTS.md'))
  assert.match(write.content, /^# AGENTS\.md — fixture/u, '标题行来自项目事实')
  assert.match(write.content, /## 快速开始/u, 'the written document carries the model section')
  assert.match(write.content, /pnpm install/u, 'the model body reaches the file')
  assert.doesNotMatch(write.content, /TODO|待补充/u, '文档里不再残留占位符')

  assert.equal(harness.followups.length, 1, '完成后只回一条通知')
  assert.equal(harness.followups[0].source.kind, 'dsh-coding-control')
  const notice = harness.followups[0].content[0].text
  assert.match(notice, /文档生成完成/u)
  assert.match(notice, /运行时回执，无需调用工具/u)
})

test('/coding init refuses an empty project without writing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-coding-init-empty-'))
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'fixture' }))
  const harness = await createHarness({ config: { language: 'zh' } })
  const agent = makeAgent(dir, harness)
  await created(harness, agent)

  const result = await harness.commands[0].handler({
    agent,
    rawInput: 'init -modules',
    signal: new AbortController().signal,
  })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /未检测到代码文件/u)
  assert.equal(harness.writes.length, 0, 'an empty project writes nothing')
  assert.equal(harness.followups.length, 0, '空项目不启动后台，也就没有通知')
})

test('/coding init passes the session sandbox policy to the write', async () => {
  const dir = await initProject('dsh-coding-init-policy-')
  const harness = await createHarness()
  const agent = makeAgent(dir, harness)
  agent.model = { current: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) }
  const policy = { mode: 'workspace-write' }
  const resolveInputs = []
  agent.ctx.sandboxPolicy = {
    async resolve(input) {
      resolveInputs.push(input)
      return policy
    },
  }
  await created(harness, agent)

  const result = await harness.commands[0].handler({
    agent,
    rawInput: 'init',
    signal: new AbortController().signal,
  })
  assert.equal(result.kind, 'success')
  await harness.waitForBackground()
  assert.equal(harness.writes.length, 1)
  assert.equal(harness.writes[0].policy, policy, 'the resolved policy is passed through unchanged')
  assert.equal(resolveInputs[0].session, agent.session, 'the policy is resolved for this session')
})

test('/coding init falls back to a detached task when the agent is busy', async () => {
  const dir = await initProject('dsh-coding-init-busy-')
  const harness = await createHarness({ config: { language: 'zh' } })
  harness.setMaintenanceMode('busy')
  const agent = makeAgent(dir, harness)
  agent.model = { current: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) }
  await created(harness, agent)

  const result = await harness.commands[0].handler({
    agent,
    rawInput: 'init',
    signal: new AbortController().signal,
  })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /宿主正忙/u, '回执说明维护名额被占，已改用独立后台任务')
  assert.match(result.text, /独立后台任务/u)

  // 独立后台任务不进 backgroundTasks（维护名额已同步抛错），只能轮询等待完成。
  for (let i = 0; i < 100; i++) {
    if (harness.followups.length > 0) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(harness.writes.length, 1, '独立后台任务照样写盘')
  assert.equal(harness.followups.length, 1, '独立后台任务照样回通知')
})

test('/coding init refuses synchronously when the session has no model', async () => {
  const dir = await initProject('dsh-coding-init-nomodel-')
  const harness = await createHarness({ config: { language: 'zh' } })
  const agent = makeAgent(dir, harness)
  await created(harness, agent)

  const result = await harness.commands[0].handler({
    agent,
    rawInput: 'init',
    signal: new AbortController().signal,
  })
  assert.equal(result.kind, 'error', '读不到模型就同步拒绝')
  assert.match(result.text, /读不到本会话当前模型/u)
  assert.equal(harness.writes.length, 0, '没有模型不写任何文件')
  assert.equal(harness.followups.length, 0, '没有模型不启动后台任务')
})

/** 回执里的中文；英文模式下必须一个都没有。 */
const CJK = /[\u4e00-\u9fff]/u

test('/coding init receipts follow the configured conversation language', async () => {
  const dir = await initProject('dsh-coding-init-lang-')

  // 英文：立即回执与后台完成通知都说英文，且不含中文。
  const en = await createHarness({ config: { language: 'en' } })
  const enAgent = makeAgent(dir, en)
  enAgent.model = { current: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) }
  await created(en, enAgent)
  const enResult = await en.commands[0].handler({
    agent: enAgent,
    rawInput: 'init',
    signal: new AbortController().signal,
  })
  assert.equal(enResult.kind, 'success')
  assert.match(enResult.text, /Background document generation started/u, '英文立即回执')
  assert.doesNotMatch(enResult.text, CJK, '英文回执不含中文')
  await en.waitForBackground()
  assert.equal(en.followups.length, 1, '英文模式后台完成同样回一条通知')
  const enNotice = en.followups[0].content[0].text
  assert.match(enNotice, /Document generation completed/u, '英文完成通知')
  assert.doesNotMatch(enNotice, CJK, '英文通知不含中文')

  // 中文：显式覆盖默认的 en，回执保持既有中文文案。
  const zh = await createHarness({ config: { language: 'zh' } })
  const zhAgent = makeAgent(dir, zh)
  zhAgent.model = { current: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) }
  await created(zh, zhAgent)
  const zhResult = await zh.commands[0].handler({
    agent: zhAgent,
    rawInput: 'init',
    signal: new AbortController().signal,
  })
  assert.equal(zhResult.kind, 'success')
  assert.match(zhResult.text, /已开始文档生成/u, '中文立即回执')
  await zh.waitForBackground()
  assert.match(zh.followups[0].content[0].text, /文档生成完成/u, '中文完成通知')
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

  const result = await command.handler({ agent, rawInput: 'stage implement' })
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

test('state 重建后释放旧的 implement 裁剪，verify 重新拿到 run_verification', async () => {
  const harness = await createHarness({ exitCode: 0 })
  const agent = makeAgent(process.cwd(), harness)
  await created(harness, agent)
  await reachPlan(harness, agent)
  writePlan(harness, agent)

  const implemented = await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)
  assert.equal(implemented.ok, true)
  const trimmed = harness.visible()
  assert.equal(trimmed.includes('apply_patch'), false, 'implement 期间主代理看不到 apply_patch')
  assert.equal(trimmed.includes(TOOL.implement), true, 'implement 期间委派动词仍可见')
  assert.equal(harness.restrictions.length, 1, '一个 agent 只持有一份限制')

  // state 重建：disposed 释放这个 agent 的旧限制，created 再按新状态重新建档。
  disposed(harness, agent)
  await created(harness, agent)
  assert.equal(harness.visible().includes('apply_patch'), true, '旧 implement 限制已随 agent/disposed 释放')

  const rebuilt = await harness.callTool(TOOL.stage, {}, agent)
  assert.equal(rebuilt.stage, 'requirements', '重建后的状态从入口阶段重新开始')

  // 重建后重走 requirements → plan → implement → delegate → verify。
  await reachPlan(harness, agent)
  writePlan(harness, agent)
  await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)
  await harness.callTool(TOOL.implement, { task: 'fix it' }, agent)
  const verified = await harness.callTool(TOOL.stage, { stage: 'verify' }, agent)
  assert.equal(verified.ok, true)

  const table = harness.visible()
  assert.equal(table.includes(TOOL.verification), true, 'verify 工具表重新包含 run_verification')
  assert.equal(table.includes(TOOL.verify), true, 'verify 工具表包含 delegate_verify')
  assert.equal(table.includes(TOOL.implement), false, 'verify 工具表不含 delegate_implement')
  assert.equal(table.includes('apply_patch'), false, 'verify 工具表不含写类工具')
  assert.equal(harness.restrictions.length, 1, '重入 implement 与切到 verify 都不叠加限制')
})

test('投影晚就绪时首个 pre-step 重试恢复，并下发 verify 工具表', async () => {
  const events = []
  const harness = await createHarness({ projectionEvents: events, exitCode: 0 })
  const agent = makeAgent(process.cwd(), harness)
  // 会话先以别的预设开始：投影此刻 active=false，created 的恢复只能是 pending。
  agent.session.header.agentPreset = 'standard'
  await created(harness, agent)
  assert.equal(harness.visible().includes('apply_patch'), true, '待恢复会话的工具表尚未被裁剪')

  // 首次 pre-step 之前投影才就绪：选择 Coding 预设，并落一条 verify 阶段的整值 checkpoint。
  events.push({ type: 'agent-preset/selected', time: 9, data: { agentPreset: 'dsh-coding' } })
  events.push(...resumeEvents('verify', RESUME_VERIFICATION))

  const first = await harness.preStep(agent, [])
  assert.equal(first.kind, 'enter', 'pre-step 的重试恢复不阻塞这一步')

  const restored = await harness.callTool(TOOL.stage, {}, agent)
  assert.equal(restored.stage, 'verify', '重试把 checkpoint 里的阶段恢复回来')
  assert.equal(harness.visible().includes(TOOL.verification), true, '恢复后同步为 verify 工具表')
  assert.equal(harness.visible().includes('apply_patch'), false, 'verify 工具表不含写类工具')

  // 第二次 pre-step 不再重复恢复：不报错、不叠加限制、状态保持 verify。
  const second = await harness.preStep(agent, [])
  assert.equal(second.kind, 'enter')
  const kept = await harness.callTool(TOOL.stage, {}, agent)
  assert.equal(kept.stage, 'verify', '状态保持 verify')
  assert.equal(harness.restrictions.length, 1, '重试只下发一次限制')
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

test('a complex codex verify dispatch loads the repository-instructions preset', async () => {
  const harness = await createHarness()
  // One changed file and two plan items: only the sub-task count can ask for the injection.
  stubWorkerReports(harness, ['src/a.ts'])
  const agent = makeAgent(process.cwd(), harness)
  await created(harness, agent)
  await reachPlan(harness, agent)
  writePlanOf(harness, agent, ['add the flag', 'cover it with a test'])
  await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)
  await harness.callTool(TOOL.implement, { task: 'add the flag' }, agent)
  await harness.callTool(TOOL.stage, { stage: 'verify' }, agent)
  await harness.callTool(TOOL.verify, { task: 'check the flag' }, agent)

  const spec = harness.activations.at(-1)
  assert.equal(spec.agentPreset, 'dsh-coding-verify-instructions', 'dependent sub-tasks need the repository rules')
  assert.match(spec.prompt[0].text, /AGENTS\.md.*already injected/)
})

test('a single-task verify dispatch over one file stays on the lean preset', async () => {
  const harness = await createHarness()
  stubWorkerReports(harness, ['src/a.ts'])
  const agent = makeAgent(process.cwd(), harness)
  await created(harness, agent)
  await reachPlan(harness, agent)
  writePlan(harness, agent)
  await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)
  await harness.callTool(TOOL.implement, { task: 'fix it' }, agent)
  await harness.callTool(TOOL.stage, { stage: 'verify' }, agent)
  await harness.callTool(TOOL.verify, { task: 'check it' }, agent)

  const spec = harness.activations.at(-1)
  assert.equal(spec.agentPreset, 'dsh-coding-verify', 'one task over one file does not earn a whole AGENTS.md')
  assert.doesNotMatch(spec.prompt[0].text, /already injected/)
})

test('review mode keeps the lean verify preset however many tasks are listed', async () => {
  const harness = await createHarness()
  stubWorkerReports(harness, [])
  const agent = makeAgent(process.cwd(), harness)
  await created(harness, agent)
  const switched = await harness.callTool(TOOL.mode, { mode: 'review' }, agent)
  assert.equal(switched.mode, 'review')
  writePlanOf(harness, agent, ['audit the parser', 'audit the writer'])
  const advanced = await harness.callTool(TOOL.stage, { stage: 'verify' }, agent)
  assert.equal(advanced.ok, true, 'review verifies without a prior edit')
  await harness.callTool(TOOL.verify, { task: 'check the parser' }, agent)

  const spec = harness.activations.at(-1)
  assert.equal(spec.agentPreset, 'dsh-coding-verify', 'only codex verification follows a change')
})

test('the exported preset roster hides the four worker presets and restores on dispose', async () => {
  const { filterWorkerPresets, installWorkerPresetFilter } = await import('../lib/index.js')
  const ROSTER = [
    { id: 'standard', isDefault: true },
    { id: 'dsh-coding', isDefault: false, name: 'Coding' },
    { id: 'dsh-coding-planner', isDefault: false },
    { id: 'dsh-coding-implement', isDefault: false },
    { id: 'dsh-coding-verify', isDefault: false },
    { id: 'dsh-coding-verify-instructions', isDefault: false },
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

test('the delivery record is written back by coding_handoff and enters the next step context', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-coding-delivered-'))
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'exit 1' } }))
  const harness = await createHarness({ exitCode: 0 })
  const agent = makeAgent(dir, harness)
  await created(harness, agent)
  await reachPlan(harness, agent)
  writePlan(harness, agent)
  await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)
  await harness.callTool(TOOL.implement, { task: 'fix it' }, agent)
  await harness.callTool(TOOL.stage, { stage: 'verify' }, agent)
  const run = await harness.callTool(TOOL.verification, { kind: 'test', scope: 'package' }, agent)
  assert.equal(run.passed, true, 'the passing check opens deliver')
  const delivered = await harness.callTool(TOOL.stage, { stage: 'deliver' }, agent)
  assert.equal(delivered.ok, true)

  // In deliver the model writes the record back: what shipped, and what is left.
  const recorded = await harness.callTool(TOOL.handoff, {
    delivered: 'turn 1: shipped the flag',
    followUps: ['harden the parser'],
  }, agent)
  assert.match(recorded.digest, /delivered: turn 1: shipped the flag/)
  assert.match(recorded.digest, /follow-ups: harden the parser/)
  assert.equal(recorded.checkpoint.handoff.delivered, 'turn 1: shipped the flag')
  assert.deepEqual(recorded.checkpoint.handoff.followUps, ['harden the parser'])

  // The next pre-step injects the stage contract, so the record is already read.
  const decision = await harness.preStep(agent, [])
  assert.equal(decision.kind, 'enter')
  const context = decision.messages
    .flatMap((message) => message.content)
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  assert.match(context, /delivered: turn 1: shipped the flag/, 'the contract carries the recorded delivery')
})

test('/coding memory writes the handoff document through the fs service', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-coding-memory-'))
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'exit 0' } }))
  const harness = await createHarness({ exitCode: 0 })
  const agent = makeAgent(dir, harness)
  await created(harness, agent)
  await reachPlan(harness, agent)
  writePlan(harness, agent)
  await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)
  await harness.callTool(TOOL.implement, { task: 'fix it' }, agent)
  await harness.callTool(TOOL.stage, { stage: 'verify' }, agent)
  const run = await harness.callTool(TOOL.verification, { kind: 'test', scope: 'package' }, agent)
  assert.equal(run.passed, true, 'the passing check opens deliver')
  const delivered = await harness.callTool(TOOL.stage, { stage: 'deliver' }, agent)
  assert.equal(delivered.ok, true)

  const receipt = await harness.commands[0].handler({
    agent,
    rawInput: 'memory',
    signal: new AbortController().signal,
  })
  assert.equal(receipt.kind, 'success')
  assert.match(receipt.text, /handoff document written:/u)
  assert.match(receipt.text, /\.agents/u, 'the receipt names the project-relative directory')
  assert.match(receipt.text, /\.md/u)

  assert.equal(harness.writes.length, 1, 'one command writes exactly one document')
  const write = harness.writes[0]
  assert.match(write.target.targetKey, /\.agents[\\/]memory[\\/]\d{8}-\d{6}-fix-the-bug\.md$/u)
  assert.deepEqual(write.expected, { kind: 'createIfAbsent' }, 'a second press never overwrites the first file')
  const name = write.target.targetKey.split(/[\\/]/u).at(-1)
  assert.ok(receipt.text.includes(name), 'the receipt names the file it wrote')
  assert.match(write.content, /# Coding 任务交接文档/u)
  assert.match(write.content, /fix the bug/u, 'the recorded goal reaches the document')
  assert.match(write.content, /npm run test/u, 'the verification command reaches the document')
  assert.match(write.content, /src\/a\.ts/u, 'the changed file reaches the document')
})

test('/coding memory reports a missing fs service instead of throwing', async () => {
  const harness = await createHarness({ fs: null })
  const agent = makeAgent(process.cwd(), harness)
  await created(harness, agent)

  const receipt = await harness.commands[0].handler({
    agent,
    rawInput: 'memory',
    signal: new AbortController().signal,
  })

  assert.equal(receipt.kind, 'error')
  assert.match(receipt.text, /fs service/u)
  assert.equal(harness.writes.length, 0, 'nothing is written when the Host serves no filesystem')
})

test('/coding memory open loads the newest archived handoff document', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-coding-memory-open-'))
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'exit 0' } }))
  const harness = await createHarness({ exitCode: 0 })
  const agent = makeAgent(dir, harness)
  await created(harness, agent)
  await reachPlan(harness, agent)
  writePlan(harness, agent)
  await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)
  await harness.callTool(TOOL.implement, { task: 'fix it' }, agent)
  await harness.callTool(TOOL.stage, { stage: 'verify' }, agent)
  const run = await harness.callTool(TOOL.verification, { kind: 'test', scope: 'package' }, agent)
  assert.equal(run.passed, true, 'the passing check opens deliver')
  await harness.callTool(TOOL.stage, { stage: 'deliver' }, agent)

  // 先写一篇交接文档，再用同一个 agent 读回它（同秒内无法写出第二篇）。
  const written = await harness.commands[0].handler({
    agent,
    rawInput: 'memory',
    signal: new AbortController().signal,
  })
  assert.equal(written.kind, 'success')
  assert.equal(harness.writes.length, 1)

  const steered = []
  agent.steer = (message) => steered.push(message)

  const receipt = await harness.commands[0].handler({
    agent,
    rawInput: 'memory open',
    signal: new AbortController().signal,
  })
  assert.equal(receipt.kind, 'success')
  assert.match(receipt.text, /handoff document loaded:/u)

  assert.equal(steered.length, 1, 'the archived document reaches the live session exactly once')
  assert.equal(steered[0].source.kind, 'dsh-coding-control')
  const injected = steered[0].content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  assert.match(injected, /archived handoff/u)
  assert.match(injected, /read-only snapshot/u)
  assert.match(injected, /coding_handoff/u, 'the notice keeps the live record authoritative')
  assert.match(injected, /# Coding 任务交接文档/u, 'the document body is injected')
  assert.match(injected, /fix the bug/u)

  const missing = await harness.commands[0].handler({
    agent,
    rawInput: 'memory open no-such-keyword',
    signal: new AbortController().signal,
  })
  assert.equal(missing.kind, 'error')
  assert.match(missing.text, /no handoff document matches/u)
  assert.equal(steered.length, 1, 'a failed read injects nothing')
})

test('codex refuses implement for a complex task list until the planner ran', async () => {
  const harness = await createHarness()
  const agent = makeAgent(process.cwd(), harness)
  await created(harness, agent)
  await reachPlan(harness, agent)

  // Four items is over the threshold: the planner must be dispatched first.
  writePlanOf(harness, agent, ['a', 'b', 'c', 'd'])
  const refused = await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /delegate_plan/u)
  assert.match(refused.reason, /4 items/u, 'the refusal names the size that made the task list complex')
  assert.equal(refused.checkpoint.planner, undefined, 'a refusal is not a planner attempt')

  // Three items are a small single-file change and skip the gate.
  writePlanOf(harness, agent, ['a', 'b', 'c'])
  const advanced = await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)
  assert.equal(advanced.ok, true)
})

test('a failed planner dispatch still opens the gate', async () => {
  const harness = await createHarness()
  const agent = makeAgent(process.cwd(), harness)
  await created(harness, agent)
  await reachPlan(harness, agent)
  writePlanOf(harness, agent, ['a', 'b', 'c', 'd'])

  // The configured planner route cannot be resolved: the dispatch fails before
  // any worker starts, and the failure must not dead-lock the codex run.
  harness.ctx.llm.resolveModelInfo = async () => { throw new Error('no route') }
  await assert.rejects(
    () => harness.callTool(TOOL.plan, { task: 'plan it' }, agent),
    /not a usable model route/u,
  )
  assert.equal(harness.activations.length, 0, 'the failed dispatch never started a worker')

  const advanced = await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)
  assert.equal(advanced.ok, true, 'a dispatch that failed is still an attempt')
  // The attempt rides the stage tool's own checkpoint, so a resumed lead reads
  // it back as a recorded dispatch rather than an untried one.
  assert.equal(advanced.checkpoint.planner.outcome, 'failed')
  assert.equal(advanced.checkpoint.planner.route, CONFIG.plannerWorkerModel)
})

test('a lead already on the planner route skips the planner gate', async () => {
  const harness = await createHarness()
  const agent = makeAgent(process.cwd(), harness)
  // CONFIG.plannerWorkerModel is this exact route: the lead is the planner.
  agent.model = { current: () => ({ provider: 'deepseek-account', model: 'deepseek-v4-pro' }) }
  await created(harness, agent)
  await reachPlan(harness, agent)
  writePlanOf(harness, agent, ['a', 'b', 'c', 'd'])

  const advanced = await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)
  assert.equal(advanced.ok, true)
  assert.equal(harness.activations.length, 0, 'no planner worker is dispatched for a planner lead')
})

test('requirePlanner off skips the planner gate', async () => {
  const harness = await createHarness()
  harness.ctx.dshCodingRuntime.options = { ...CONFIG, requirePlanner: 'off' }
  const agent = makeAgent(process.cwd(), harness)
  await created(harness, agent)
  await reachPlan(harness, agent)
  writePlanOf(harness, agent, ['a', 'b', 'c', 'd'])

  const advanced = await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)
  assert.equal(advanced.ok, true, 'the gate is configuration, not a hard rule')
})

test('a lead whose model selection is unreadable is not the planner', async () => {
  const harness = await createHarness()
  const agent = makeAgent(process.cwd(), harness)
  await created(harness, agent)
  await reachPlan(harness, agent)
  writePlanOf(harness, agent, ['a', 'b', 'c', 'd'])

  // makeAgent carries no model at all: an absent selection must read as "not
  // the planner" and never throw out of the advance.
  const refused = await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /delegate_plan/)

  agent.model = { current: () => { throw new Error('no selection yet') } }
  const throwing = await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)
  assert.equal(throwing.ok, false)
  assert.match(throwing.reason, /delegate_plan/)

  // Another model on the same provider is not the planner route either.
  agent.model = { current: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) }
  const flash = await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)
  assert.equal(flash.ok, false)
  assert.match(flash.reason, /delegate_plan/)
})

test('阶段内新注册的工具在下一步可见，且不叠加限制', async () => {
  const harness = await createHarness({ exitCode: 0 })
  const agent = makeAgent(process.cwd(), harness)
  await created(harness, agent)
  await reachPlan(harness, agent)
  writePlan(harness, agent)
  await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)
  await harness.callTool(TOOL.implement, { task: 'fix it' }, agent)
  await harness.callTool(TOOL.stage, { stage: 'verify' }, agent)
  assert.equal(harness.visible().includes('late_tool'), false, '进入阶段时快照里没有这个工具')

  // 进入 verify 之后才注册的工具（插件热加载 / MCP 连接）。
  harness.ctx.tools.register({
    name: 'late_tool',
    description: 'late',
    parameters: {},
    output: { schema: { type: 'string' }, render: () => [] },
    execute: async () => '',
  })
  await harness.preStep(agent, [])
  assert.equal(harness.visible().includes('late_tool'), true, '下一步重算工具表后即可见')
  assert.equal(harness.restrictions.length, 1, '重算不叠加限制')
})

test('implement 切到 verify 时按未受限全集重建工具表', async () => {
  const harness = await createHarness({ exitCode: 0 })
  const agent = makeAgent(process.cwd(), harness)
  await created(harness, agent)
  await reachPlan(harness, agent)
  writePlan(harness, agent)
  await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)
  const implementing = harness.visible()
  assert.equal(implementing.includes('read'), false, 'implement 只剩委派集')
  assert.equal(implementing.includes(TOOL.implement), true)

  await harness.callTool(TOOL.implement, { task: 'fix it' }, agent)
  await harness.callTool(TOOL.stage, { stage: 'verify' }, agent)
  const verifying = harness.visible()
  for (const name of ['read', 'grep', TOOL.verification, TOOL.verify, 'bash', 'todo_write']) {
    assert.equal(verifying.includes(name), true, `verify 表应含 ${name}`)
  }
  for (const name of ['apply_patch', 'write', 'edit', TOOL.implement]) {
    assert.equal(verifying.includes(name), false, `verify 表不应含 ${name}`)
  }
})

test('阶段推进被拒时用户能看到运行中断提示', async () => {
  const harness = await createHarness()
  const agent = makeAgent(process.cwd(), harness)
  await created(harness, agent)
  await reachPlan(harness, agent)

  // 没有任务单就推进 implement：被拒，并记成一次阶段推进失败。
  const refused = await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)
  assert.equal(refused.ok, false)
  const view = await harness.callTool(TOOL.stage, {}, agent)
  assert.equal(view.checkpoint.failure.point, 'stage')
  assert.match(view.status, /failure stage/)

  // 下一步被阻断（模型跳过了门禁），提示留给再下一步。
  const blocked = await harness.preStep(agent, [])
  assert.equal(blocked.kind, 'reject')
  const next = await harness.preStep(agent, [])
  const notice = next.messages.find((message) => message.source?.kind === 'dsh-coding-control')
  assert.ok(notice, '拒绝要以控制消息形式告知用户')
  assert.match(notice.content[0].text, /运行中断|runtime failure/)
  assert.match(notice.content[0].text, /阶段推进|Stage advance/)

  // 条件补齐后推进成功，失败标记清除。
  writePlan(harness, agent)
  const advanced = await harness.callTool(TOOL.stage, { stage: 'implement' }, agent)
  assert.equal(advanced.ok, true)
  const cleared = await harness.callTool(TOOL.stage, {}, agent)
  assert.equal(cleared.checkpoint.failure, undefined)
})
