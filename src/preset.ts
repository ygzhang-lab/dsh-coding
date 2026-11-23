/**
 * The Coding runtime preset plugin.
 *
 * Three enforcement layers, deliberately independent:
 *
 * 1. `tools/pre-execute` — a friendly, actionable denial (`{ kind: 'deny' }`,
 *    never `ask`: this is a rule, not a question for the user).
 * 2. `ctx.tools.guard()` — the monotonic backstop. It runs after pre-execute
 *    resolves to `allow`, so no later listener order or approval channel can
 *    let a stage-forbidden call through.
 * 3. `agent/pre-step` — the stage contract injected as step context, plus a
 *    one-shot step rejection when the model tried to skip a gate.
 *
 * The tool table is trimmed (`agent.ctx.tools.restrict({ allow })`) during
 * `implement`, so the model does not even see the edit tools it may not use.
 *
 * @module dsh-coding/preset
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { type CodingConfig, type ReasoningMode } from './config.js'
import { ReasoningController } from './reasoning.js'
import { reasoningProjection } from './reasoning-projection.js'
import { writeMemoryDocument } from './memory.js'
import { controlMessage, stageMessage } from './messages.js'
import { failureNotice, makeFailure, type FailurePoint } from './failures.js'
import {
  assertWorkerModel,
  describeProviders,
  resolveWorkerRoute,
  workerPreset,
  WORKER_ROLES,
  type WorkerRole,
} from './models.js'
import {
  handoffDigest,
  handoffForWorker,
  mergeHandoff,
  type HandoffPatch,
  type HandoffTask,
} from './handoff.js'
import {
  CODING_MODES,
  CODING_STAGES,
  TOOL,
  WORKER_PRESETS,
  asCheckpoint,
  needsWorkspaceInstructions,
  stagePath,
  toolClass,
  type CodingMode,
  type CodingStage,
  type VerificationOutcome,
} from './stages.js'
import {
  CodingStateStore,
  applyMode,
  applyStage,
  checkAdvance,
  checkTool,
  checkpointOf,
  clearFailure,
  clearRefusal,
  isLeadAgent,
  recordFailure,
  recordRefusal,
  recordVerification,
  resetVerification,
  restoreFromView,
  sessionIdOf,
  statusLine,
  tableTrim,
  takeFailureNotice,
  takeLastRefusal,
  type CodingState,
} from './state.js'
import { stageContext } from './contract.js'
import { registerVerificationTool } from './verification-tool.js'
import { codingProjection, type CodingStageView } from './coding-projection.js'
import { languagePrompt, resolveHostLanguage, type PromptLanguage } from './language.js'
import { systemLanguages } from './system-language.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-coding-preset'

/**
 * Hard dependencies: this preset cannot honour its own gates without the
 * delegation backend or the structured verifier, so it fails loudly instead of
 * silently downgrading to advice. The preset registry is deliberately NOT a
 * dependency: the worker preset is selected through `ctx.subagents`, and a
 * preset-scope plugin should not need the registry that mounted it.
 */
export const inject = [
  'tools',
  'systemPrompt',
  'dshCodingRuntime',
  'subagents',
  'subprocess',
  'llm',
  // The per-turn conversation card reads this projection; without it the
  // session still runs, it just loses its visible stage surface.
  'sessionProjections',
]

/** Structured report the implement worker must return. */
const IMPLEMENT_REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'summary', 'files'],
  properties: {
    ok: { type: 'boolean' },
    summary: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
} as const

/** Structured report the verify worker must return. */
const VERIFY_REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'summary'],
  properties: {
    ok: { type: 'boolean' },
    summary: { type: 'string' },
    command: { type: 'string' },
    kind: { type: 'string', enum: ['test', 'build', 'lint', 'typecheck'] },
    scope: { type: 'string', enum: ['targeted', 'package', 'full'] },
    failedTests: { type: 'array', items: { type: 'string' } },
    findings: { type: 'array', items: { type: 'string' } },
  },
} as const

/** Structured report the planner worker must return. */
const PLANNER_REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'summary', 'tasks'],
  properties: {
    ok: { type: 'boolean' },
    summary: { type: 'string' },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['goal', 'acceptance'],
        properties: {
          goal: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          acceptance: { type: 'string' },
          avoid: { type: 'string' },
        },
      },
    },
  },
} as const

/** One worker report after local validation. */
interface WorkerReport {
  readonly ok: boolean
  readonly summary: string
  readonly files: readonly string[]
  readonly notes?: string
  readonly command?: string
  readonly kind?: VerificationOutcome['kind']
  readonly scope?: VerificationOutcome['scope']
  readonly failedTests: readonly string[]
  readonly tasks: readonly HandoffTask[]
  readonly findings: readonly string[]
}

/** Every string of an untyped array, dropping anything else. */
function stringList(candidate: unknown): string[] {
  return Array.isArray(candidate) ? candidate.filter((item): item is string => typeof item === 'string') : []
}

/**
 * Normalize the planner's task list into handoff tasks. The value crossed a
 * provider boundary, so an item may still be a bare string from an older
 * prompt; an object item must name a goal, and every other field is optional.
 * @param value - `structured.tasks` of the planner worker.
 * @returns the normalized tasks, dropping the ones without a goal.
 */
function asHandoffTasks(value: unknown): HandoffTask[] {
  if (!Array.isArray(value)) return []
  const tasks: HandoffTask[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      const goal = item.trim()
      if (goal !== '') tasks.push({ goal, files: [], acceptance: '' })
      continue
    }
    if (typeof item !== 'object' || item === null) continue
    const raw = item as Record<string, unknown>
    const goal = typeof raw['goal'] === 'string' ? raw['goal'].trim() : ''
    if (goal === '') continue
    const acceptance = typeof raw['acceptance'] === 'string' ? raw['acceptance'].trim() : ''
    const avoid = typeof raw['avoid'] === 'string' ? raw['avoid'].trim() : ''
    tasks.push({
      goal,
      files: stringList(raw['files']),
      acceptance,
      ...avoid === '' ? {} : { avoid },
    })
  }
  return tasks
}

/**
 * Validate the child's structured value. The value crossed a provider boundary,
 * so nothing about its shape is assumed.
 * @param value - `SubagentResult.structured`.
 * @returns the narrowed report, or undefined when the child produced none.
 */
function asWorkerReport(value: unknown): WorkerReport | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  if (typeof v['ok'] !== 'boolean' || typeof v['summary'] !== 'string') return undefined
  const kind = v['kind']
  const scope = v['scope']
  return {
    ok: v['ok'],
    summary: v['summary'],
    files: stringList(v['files']),
    ...typeof v['notes'] === 'string' ? { notes: v['notes'] } : {},
    ...typeof v['command'] === 'string' ? { command: v['command'] } : {},
    ...kind === 'test' || kind === 'build' || kind === 'lint' || kind === 'typecheck' ? { kind } : {},
    ...scope === 'targeted' || scope === 'package' || scope === 'full' ? { scope } : {},
    failedTests: stringList(v['failedTests']),
    tasks: asHandoffTasks(v['tasks']),
    findings: stringList(v['findings']),
  }
}

/** Read the delegation plan as worker-facing text. */
function planText(state: CodingState): string {
  const items = state.plan?.items ?? []
  if (items.length === 0) return '(no structured task list)'
  return items.map(item => `- [${item.status}] ${item.content}`).join('\n')
}

/**
 * The handoff fragment one worker receives, as prompt lines. The roles differ:
 * the planner gets the problem, the implementer the decisions and tasks, the
 * verifier the definition of done and what already changed.
 * @param state - live session state carrying the handoff.
 * @param role - worker about to run.
 * @returns the prompt lines, or [] when the handoff has nothing for this role.
 */
function handoffSection(state: CodingState, role: WorkerRole): string[] {
  const text = handoffForWorker(state.handoff, role)
  return text === '' ? [] : ['', '## Handoff', text]
}

/** Whether the handoff already carries the plan task list the workers read. */
function hasHandoffTasks(state: CodingState): boolean {
  return (state.handoff?.tasks.length ?? 0) > 0
}

/** Characters kept from a brief's first line in the subagent catalog label. */
const LABEL_LIMIT = 60

/**
 * One-line catalog label for a dispatched worker: the role plus the brief's
 * first non-empty line, collapsed and capped. The catalog keeps every child for
 * the life of the session, so the label is what lets a reader tell two runs
 * apart.
 * @param role - worker role.
 * @param task - the brief the lead handed the worker.
 * @returns a single-line label no longer than the cap plus its role prefix.
 */
export function workerLabel(role: 'plan' | 'implement' | 'verify', task: string): string {
  const firstLine = task
    .split(/\r?\n/u)
    .map(line => line.trim())
    .find(line => line !== '') ?? ''
  const summary = Array.from(firstLine.replace(/\s+/gu, ' ')).slice(0, LABEL_LIMIT).join('').trim()
  return summary === '' ? `${role}: change` : `${role}: ${summary}`
}

/** Implement-worker prompt: self-contained, because the child has no parent context. */
function implementPrompt(task: string, files: readonly string[], acceptance: string | undefined, state: CodingState): string {
  return [
    'You are the implement worker of the DSH Coding runtime. You have a fresh context: this task is complete on its own.',
    'Rules:',
    '- The repository instructions (AGENTS.md) are already injected into this session: follow them; do not read the file again.',
    '- Read a file before editing it. Prefer apply_patch for multi-file or multi-hunk changes; use edit for one literal replacement and write for a new file.',
    '- Change only what the task needs: no drive-by refactor, no unrelated reformatting, no new dependency.',
    '- `acceptance` is the standard this change is measured against: satisfy it. Do not edit files outside the handoff.',
    '- Never commit, push, tag, or open a pull request.',
    '- Finish by calling structured_output exactly once with { ok, summary, files, notes }; files lists every path you changed.',
    '',
    '## Task',
    task,
    ...acceptance === undefined ? [] : ['', '## Acceptance criteria', acceptance],
    ...files.length === 0 ? [] : ['', '## Files in scope', ...files.map(file => `- ${file}`)],
    ...handoffSection(state, 'implement'),
    ...hasHandoffTasks(state) ? [] : ['', '## Task list from the lead', planText(state)],
  ].join('\n')
}

/** Verify-worker prompt: read-only investigation of one check. */
function verifyPrompt(task: string, state: CodingState, withInstructions = false): string {
  return [
    'You are the verify worker of the DSH Coding runtime. You cannot edit files; you run checks and report evidence.',
    'Rules:',
    ...withInstructions
      ? ['- The repository instructions (AGENTS.md) are already injected into this session: follow them; do not read the file again.']
      : [],
    '- Use run_verification to execute a check; inspect the failing output it returns.',
    '- Report findings with file:line and a reproducible scenario, ordered by impact.',
    '- Report the command you actually ran, and put every conclusion about the acceptance criteria into findings.',
    '- Never claim a passing check you did not run.',
    '- Finish by calling structured_output exactly once with { ok, summary, command, kind, scope, failedTests, findings }.',
    '',
    '## Task',
    task,
    ...handoffSection(state, 'verify'),
    '',
    '## Current state',
    statusLine(state),
    ...hasHandoffTasks(state) ? [] : ['', '## Task list from the lead', planText(state)],
  ].join('\n')
}

/** Planner-worker prompt: explore read-only and return single-purpose tasks. */
function plannerPrompt(task: string, state: CodingState): string {
  return [
    'You are the planner worker of the DSH Coding runtime. You have a fresh context: the requirement below is complete on its own.',
    'Rules:',
    '- Explore the workspace first: read AGENTS.md, the README, the package manifests, and the files the requirement touches. Use read, glob, grep, and web.',
    '- Then analyse the requirement against what the workspace actually contains.',
    '- State in `summary` what the user actually asked for, what the workspace currently contains, and why the tasks are ordered this way.',
    '- For every task give `goal` (what changes), `files` (the exact paths in scope), `acceptance` (an observable check that proves it is done), and `avoid` (what it must not touch). One coherent change per task, so an implement worker can finish it from that text alone.',
    '- Produce single-purpose sub-tasks: each task does exactly one thing (one file or one coherent unit), is imperative, and is verifiable. Never bundle unrelated work into one task.',
    '- Order the tasks so each later task depends only on earlier ones.',
    '- Finish by calling structured_output exactly once with { ok, summary, tasks }; tasks is an array of objects { goal, files, acceptance, avoid }.',
    '',
    '## Requirement',
    task,
    ...handoffSection(state, 'plan'),
    '',
    '## Current state',
    statusLine(state),
  ].join('\n')
}

/** The Coding runtime plugin body. */
export async function apply(ctx: any): Promise<void> {
  const settings = ctx.dshCodingRuntime as { options: CodingConfig }
  const config = (): CodingConfig => settings.options

  /**
   * 主 Agent 自身是否就是配置的 planner 路由：这时 planner worker 是多余的，
   * 门禁直接放行。读不到模型选择时按“不是”处理，门禁照常生效。
   */
  const leadIsPlanner = (agent: any): boolean => {
    try {
      const current = agent?.model?.current?.()
      if (typeof current?.provider !== 'string' || typeof current?.model !== 'string') return false
      const route = resolveWorkerRoute(config(), 'plan')
      return current.provider === route.provider && current.model === route.model
    } catch {
      return false
    }
  }

  /** 门禁需要的运行时事实：主 Agent 的路由，以及 `requirePlanner` 开关。 */
  const advanceOptions = (agent: any) => ({
    leadIsPlanner: leadIsPlanner(agent),
    plannerGate: config().requirePlanner !== 'off',
  })

  const store = new CodingStateStore(config)

  /** Current conversation language, used for the user-facing failure notice. */
  const currentLanguage = (): PromptLanguage => resolveHostLanguage({
    mode: config().language,
    loader: ctx.get?.('loader') ?? ctx.loader,
    systemLanguages,
  })

  /**
   * Record a blocking failure and log it once. The next step consumes the
   * pending notice; the status line and checkpoint keep the failure until the
   * same subsystem succeeds.
   */
  const fail = (state: CodingState, point: FailurePoint, error: unknown): void => {
    const failure = makeFailure(point, error, currentLanguage())
    recordFailure(state, failure)
    ctx.logger?.warn?.(`dsh-coding: ${point} failed: ${failure.reason}`)
  }

  try {
    await preflight(ctx, config())
  } catch (error) {
    throw new Error(
      `${messageOf(error)}\nWhat to do: fix the worker model routes and composition in the plugin page `
      + '(or cordis.patch.yml), then restart DSH.',
    )
  }

  // ── Conversation language ─────────────────────────────────────────────────
  // Fixed per request at assembly time, so a settings change or a DSH language
  // switch reaches the next turn without a remount. Auto resolves DSH's own
  // preference, then the OS language list, then the host locale.
  registerLanguage(ctx, config)

  // ── Durable stage projection ──────────────────────────────────────────────
  // The conversation card reads this, never the in-memory state machine, so a
  // reloaded session shows the stage, plan, and verification the log recorded.
  let projectionHandle: { stateOf(session: any): CodingStageView | undefined } | undefined
  let projectionError: unknown
  let projectionReady: Promise<unknown> = Promise.resolve()
  ctx.inject(['sessionProjections'], (child: any) => {
    child.effect(() => {
      let disposed = false
      let handle: { stateOf(session: any): CodingStageView; dispose?: () => Promise<void> } | undefined
      projectionReady = Promise.resolve(child.sessionProjections.register(
        codingProjection(() => config().defaultMode),
      ))
        .then((ready: typeof handle) => {
          if (disposed) {
            void ready?.dispose?.()
            return undefined
          }
          handle = ready
          projectionHandle = ready
          return ready
        })
        .catch((error: unknown) => {
          ctx.logger?.warn?.(`dsh-coding: could not register the stage projection: ${messageOf(error)}`)
          projectionError = error
          return undefined
        })
      return () => {
        disposed = true
        projectionHandle = undefined
        void handle?.dispose?.()
      }
    }, 'dsh-coding: stage projection')
  })

  // ── Durable reasoning choice ─────────────────────────────────────────────
  // The controller reads this through `snapshot()`; registering it keeps the
  // chat-box pick and the `coding_reasoning` override across a Host restart.
  ctx.inject(['sessionProjections'], (child: any) => {
    child.effect(() => {
      let disposed = false
      let handle: { dispose?: () => Promise<void> } | undefined
      Promise.resolve(child.sessionProjections.register(reasoningProjection))
        .then((registered: typeof handle) => {
          if (disposed) {
            void registered?.dispose?.()
            return undefined
          }
          handle = registered
          return registered
        })
        .catch((error: unknown) => {
          ctx.logger?.warn?.(`dsh-coding: could not register the reasoning projection: ${messageOf(error)}`)
          return undefined
        })
      return () => {
        disposed = true
        void handle?.dispose?.()
      }
    }, 'dsh-coding: reasoning projection')
  })

  /** Resolve the live state of a lead agent, creating it on first touch. */
  const stateOf = (agent: any): CodingState | undefined => {
    if (!isLeadAgent(agent)) return undefined
    const sessionId = sessionIdOf(agent)
    if (sessionId === undefined) return undefined
    return store.peek(agent) ?? store.ensure(agent, sessionId)
  }

  /** Automatic / pinned / overridden reasoning level for this agent. */
  const reasoning = new ReasoningController(ctx, config, {
    turnOf: (agent: any) => stateOf(agent)?.turn ?? 0,
    planOf: (agent: any) => stateOf(agent)?.plan?.items ?? [],
  })

  /**
   * Re-derive the lead's visible tool table for the current stage. The
   * restriction is scoped to the agent, so it disappears with that Agent; the
   * returned disposer is kept so a stage change lifts it immediately.
   */
  const syncTable = (agent: any, state: CodingState): void => {
    state.tableRestriction?.()
    state.tableRestriction = undefined
    const allow = tableTrim(state.stage)
    if (allow === undefined) return
    let known: Set<string>
    try {
      known = new Set((ctx.tools.schemas(agent) as { name: string }[]).map(schema => schema.name))
    } catch (error) {
      fail(state, 'tool-table', error)
      return
    }
    // `restrict` rejects unknown names; keep only the verbs this scope actually has.
    const filtered = allow.filter(toolName => known.has(toolName))
    if (!filtered.includes(TOOL.implement)) {
      ctx.logger?.warn?.('dsh-coding: delegation tool is missing; the implement table was not trimmed')
      return
    }
    try {
      state.tableRestriction = agent.ctx.tools.restrict({ allow: filtered })
    } catch (error) {
      ctx.logger?.warn?.(`dsh-coding: could not trim the implement tool table: ${String(error)}`)
      fail(state, 'tool-table', error)
    }
  }

  /**
   * Seed a resumed session from its durable projection. The live state is a
   * cache; the Session log is the source of truth for the stage, plan, and
   * verification the resumed conversation already recorded.
   */
  const restore = async (agent: any, state: CodingState): Promise<void> => {
    await projectionReady
    const handle = projectionHandle
    if (handle === undefined) {
      // Registration is the only path that fills the handle, so its failure is
      // what leaves a resumed session without its durable stage.
      if (projectionError !== undefined) fail(state, 'projection', projectionError)
      return
    }
    let view: CodingStageView | undefined
    try {
      view = handle.stateOf(agent.session)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-coding: could not read the stage projection: ${messageOf(error)}`)
      fail(state, 'restore', error)
      return
    }
    if (view === undefined || view.active !== true) return
    if (view.checkpoint === null && view.plan.length === 0) return
    restoreFromView(state, view)
  }

  // ── Layer 1: friendly waterfall denial ────────────────────────────────────
  ctx.effect(() => ctx.on('tools/pre-execute', async (exec: any, next: () => Promise<unknown>) => {
    const state = stateOf(exec.agent)
    if (state === undefined) return next()
    const verdict = checkTool(state, exec.name)
    if (verdict.deny !== undefined) return { kind: 'deny', reason: verdict.deny }
    return next()
  }), 'dsh-coding: pre-execute gate')

  // ── Layer 2: monotonic guard (runs after pre-execute allowed the call) ────
  ctx.effect(() => ctx.tools.guard((exec: any): string | undefined => {
    const state = stateOf(exec.agent)
    if (state === undefined) return undefined
    return checkTool(state, exec.name).deny
  }), 'dsh-coding: stage guard')

  // ── Result observation: requirements evidence + structured follow-ups ────
  ctx.effect(() => ctx.on('tools/post-execute', async (exec: any, result: any, next: () => Promise<any>) => {
    const downstream = await next()
    const state = stateOf(exec.agent)
    if (state === undefined) return downstream
    if (result.isError !== true && state.stage === 'requirements') {
      const kind = toolClass(exec.name)
      if (kind === 'read' || kind === 'exec') state.requirementsObserved += 1
    }
    const notices: unknown[] = []
    const checkpoint = asCheckpoint((result as { value?: { checkpoint?: unknown } }).value?.checkpoint)
    if (checkpoint?.verification !== undefined && checkpoint.verification.passed === false) {
      const failed = checkpoint.verification.failedTests
      const attempts = checkpoint.verifyBlocked?.attempts ?? checkpoint.verifyAttempts ?? 0
      const evidence = [
        failed.length === 0 ? '' : `Failing tests: ${failed.join('; ')}`,
        `Command: ${checkpoint.verification.command} (exit ${String(checkpoint.verification.exitCode)})`,
      ].filter(line => line !== '')
      notices.push(stageMessage(
        checkpoint.verifyBlocked === undefined
          ? [
            'Verification failed. Do not deliver.',
            ...evidence,
            'Return to the implement stage, fix the failure with delegate_implement, then verify again.',
            attempts > 0 ? `Attempt ${attempts} of the retry budget recorded.` : '',
          ].filter(line => line !== '').join('\n')
          : [
            `Verification retry budget exhausted after ${attempts} attempt(s). Do not retry the same failure.`,
            'Stop the fix/verify loop: make a materially different fix, ask the user for a decision,',
            'or advance to deliver and report a BLOCKED delivery naming the failing check and the last error.',
            ...evidence,
          ].join('\n'),
        `verification failed: ${checkpoint.verification.kind}`,
      ))
    }
    if (exec.name === TOOL.stage) {
      const value = (result as { value?: { ok?: unknown; soft?: unknown; reason?: unknown } }).value
      if (value?.ok === false && value.soft !== true && typeof value.reason === 'string') {
        notices.push(stageMessage(
          `The stage advance was refused: ${value.reason}\nThe next step is blocked until the gate is satisfied.`,
          'stage advance refused',
        ))
      }
    }
    if (notices.length === 0) return downstream
    return {
      ...downstream,
      additionalContexts: [...(downstream as { additionalContexts?: unknown[] }).additionalContexts ?? [], ...notices],
    }
  }), 'dsh-coding: post-execute notice')

  // The Host emits this synchronously from `inbox.claim()`, before it reads
  // `model.current()` for step preparation, so it is the only point where an
  // automatic effort can reach the turn's first step. A cold capability cache
  // writes nothing; `agent/pre-step` then applies the level from the next step.
  ctx.effect(() => ctx.on('agent/inbox/claimed', (payload: any) => {
    try {
      reasoning.applySync(
        payload.agent,
        payload.message,
        typeof payload.turn === 'number' ? payload.turn : undefined,
      )
    } catch (error) {
      ctx.logger?.warn?.(`dsh-coding: reasoning claim failed: ${messageOf(error)}`)
    }
  }), 'dsh-coding: reasoning claim')

  // ── Layer 3: stage context and gate-skip rejection ────────────────────────
  ctx.effect(() => ctx.on('agent/pre-step', async (payload: any, next: () => Promise<any>) => {
    const agent = payload.agent
    const state = stateOf(agent)
    // Always delegate first: other listeners own their own decisions.
    const decision = await next()
    if (state === undefined) return decision
    state.turn = typeof payload.turn === 'number' ? payload.turn : state.turn
    state.step = typeof payload.step === 'number' ? payload.step : state.step
    if (decision.kind === 'reject') return decision
    try {
      // The projection is the durable copy: a chat-box pick may have landed
      // since the last step, so fold it back before classifying this one.
      reasoning.syncProjection(agent)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-coding: could not sync the reasoning choice: ${messageOf(error)}`)
      fail(state, 'reasoning', error)
    }
    try {
      await reasoning.apply(agent, payload.signal, decision.messages)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-coding: could not apply the reasoning level: ${messageOf(error)}`)
      fail(state, 'reasoning', error)
    }
    const refusal = state.refusal
    if (refusal !== undefined) {
      // The model tried to skip a gate: end this turn blocked, once. The reason
      // is kept for the next step's contract, because a rejected step drops its
      // own messages and the turn ends without them.
      clearRefusal(state)
      ctx.logger?.info?.(`dsh-coding: blocked a step that skipped the ${refusal.target} gate`)
      return { kind: 'reject' }
    }
    const rejection = takeLastRefusal(state)
    const text = stageContext({
      mode: state.mode,
      stage: state.stage,
      status: statusLine(state),
      handoff: handoffDigest(state.handoff),
      ...rejection === undefined ? {} : { rejection },
    })
    // Read after this step's own failures, so a failure raised above travels
    // with the same step's contract. The notice is one-shot: a later step
    // repeats neither the card nor the message.
    const pending = takeFailureNotice(state)
    const messages = [
      ...decision.messages,
      stageMessage(text, `coding stage: ${state.stage}`),
    ]
    if (pending !== undefined) {
      messages.push(controlMessage(
        failureNotice(pending, currentLanguage()),
        `runtime failure: ${pending.point}`,
      ))
    }
    return { ...decision, messages }
  }), 'dsh-coding: stage context')

  // ── Durable folds: the plan lives in the Session log ──────────────────────
  ctx.effect(() => ctx.on('session/event', (session: any, event: any) => {
    if (event.type !== 'todo/write') return
    const sessionId = session?.header?.id
    if (typeof sessionId !== 'string') return
    const state = store.bySessionId(sessionId)
    if (state === undefined) return
    const todos = (event.data as { todos?: unknown }).todos
    if (!Array.isArray(todos)) return
    const items = todos
      .filter((item): item is { content: string; status: PlanItemStatus } => (
        typeof item === 'object' && item !== null
        && typeof (item as { content?: unknown }).content === 'string'
        && ((item as { status?: unknown }).status === 'pending'
          || (item as { status?: unknown }).status === 'in_progress'
          || (item as { status?: unknown }).status === 'completed')
      ))
      .map(item => ({ content: item.content, status: item.status }))
    state.plan = { items, at: typeof event.time === 'number' ? event.time : Date.now() }
    state.updatedAt = state.plan.at
  }), 'dsh-coding: plan fold')

  // ── Per-agent lifecycle ───────────────────────────────────────────────────
  ctx.effect(() => ctx.on('agent/created', async ({ agent }: any) => {
    const state = stateOf(agent)
    if (state === undefined) return
    // Warm the effort table so the first claimed message can pick a level
    // synchronously, before the Host snapshots the step's selection.
    void reasoning.prewarm(agent).catch(() => {})
    // Fresh sessions have an empty projection, so this is a no-op for them.
    await restore(agent, state)
    syncTable(agent, state)
  }), 'dsh-coding: agent created')
  ctx.effect(() => ctx.on('agent/disposed', ({ agent }: any) => {
    store.release(agent, sessionIdOf(agent))
  }), 'dsh-coding: agent disposed')

  // ── Control verbs ─────────────────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: TOOL.stage,
    description: [
      'Inspect or advance the enforced coding stage (requirements, plan, implement, verify, deliver).',
      'Omit `stage` to read the current stage and gate status.',
      'In auto mode only requirements is open: choose the workflow with coding_mode before advancing.',
      'The plugin decides whether the move is allowed: plan needs a requirements observation,',
      'implement needs a todo_write task list, verify needs a landed implement-worker edit,',
      'and deliver needs a passing run_verification. A refused move repeats the reason;',
      'a move that skips a gate also blocks the next step.',
      'Under codex, plan also needs a recorded handoff goal and verify a recorded acceptance criterion;',
      'once the verification retry budget is exhausted, deliver is granted but the delivery is BLOCKED.',
    ].join(' '),
    parameters: {
      stage: {
        type: 'string' as const,
        enum: [...CODING_STAGES],
        description: 'Target stage. Omit to inspect the current state.',
      },
      note: {
        type: 'string' as const,
        description: 'One line on why you are moving; recorded in the transition log.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          stage: { type: 'string', required: true },
          mode: { type: 'string', required: true },
          status: { type: 'string', required: true },
          reason: { type: 'string' },
          soft: { type: 'boolean' },
          blocked: { type: 'boolean' },
          checkpoint: { type: 'json' },
        },
      },
      render: (_args: unknown, value: any) => [{
        type: 'text',
        text: value.ok === true
          ? value.blocked === true
            ? `delivery BLOCKED: ${value.stage}; ${value.status}`
            : `stage ${value.stage} (${value.mode}); ${value.status}`
          : `stage advance refused: ${String(value.reason ?? '')}`,
      }],
      presentationMeta: (_args: unknown, value: any) => value.checkpoint,
    },
    async execute(args: { stage?: CodingStage; note?: string }, exec: any): Promise<any> {
      if (exec.agent === undefined) throw new Error('coding_stage requires an owning agent session')
      const state = stateOf(exec.agent)
      if (state === undefined) throw new Error('coding_stage: this agent is not a Coding lead session')
      if (args?.stage === undefined) {
        return {
          ok: true,
          stage: state.stage,
          mode: state.mode,
          status: statusLine(state),
          checkpoint: checkpointOf(state),
        }
      }
      const check = checkAdvance(state, args.stage, advanceOptions(exec.agent))
      if (!check.ok) {
        const reason = check.reason ?? 'the stage gate refused this move'
        // Auto's workflow choice is a decision, not a skipped gate: report it
        // without arming the one-shot step rejection meant for jumping a gate.
        if (check.soft !== true) recordRefusal(state, args.stage, reason)
        return {
          ok: false,
          stage: state.stage,
          mode: state.mode,
          status: statusLine(state),
          reason,
          ...check.soft === true ? { soft: true } : {},
          checkpoint: checkpointOf(state),
        }
      }
      applyStage(state, args.stage, args.note?.trim() || 'model requested the next stage')
      // A granted exit from an exhausted retry budget is a blocked delivery:
      // the report must name the failing check instead of claiming success.
      if (check.blocked === true) state.deliveryBlocked = true
      syncTable(exec.agent, state)
      return {
        ok: true,
        stage: state.stage,
        mode: state.mode,
        status: statusLine(state),
        ...check.blocked === true ? { blocked: true } : {},
        checkpoint: checkpointOf(state),
      }
    },
  })), 'dsh-coding: coding_stage')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: TOOL.mode,
    description: [
      'Inspect or switch the workflow mode: auto (requirements chooses the workflow), consult (Q&A), review, or codex.',
      'A mode determines the stage set: auto opens only requirements; consult requirements/plan/deliver; review requirements/verify/deliver;',
      'codex all five. Switching to a mode that does not open the current stage resets to that mode\'s first stage.',
      'In auto mode call this in requirements, once, to choose the concrete workflow; prefer consult when the request is',
      'unclear, and do not over-interpret it. Otherwise call only when the user asks to switch or asks which mode is active.',
    ].join(' '),
    parameters: {
      mode: {
        type: 'string' as const,
        enum: [...CODING_MODES],
        description: 'Target mode. Omit to inspect.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          stage: { type: 'string', required: true },
          mode: { type: 'string', required: true },
          status: { type: 'string', required: true },
          reason: { type: 'string' },
          checkpoint: { type: 'json' },
        },
      },
      render: (_args: unknown, value: any) => [{
        type: 'text',
        text: `mode ${value.mode}; stage ${value.stage}; stages ${stagePath(value.mode as CodingMode)}`,
      }],
      presentationMeta: (_args: unknown, value: any) => value.checkpoint,
    },
    async execute(args: { mode?: CodingMode }, exec: any): Promise<any> {
      if (exec.agent === undefined) throw new Error('coding_mode requires an owning agent session')
      const state = stateOf(exec.agent)
      if (state === undefined) throw new Error('coding_mode: this agent is not a Coding lead session')
      if (args?.mode === undefined) {
        return {
          ok: true,
          stage: state.stage,
          mode: state.mode,
          status: statusLine(state),
          checkpoint: checkpointOf(state),
        }
      }
      applyMode(state, args.mode)
      syncTable(exec.agent, state)
      return {
        ok: true,
        stage: state.stage,
        mode: state.mode,
        status: statusLine(state),
        checkpoint: checkpointOf(state),
      }
    },
  })), 'dsh-coding: coding_mode')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: TOOL.reasoning,
    description: [
      'Inspect the active Coding reasoning level, or set a session override.',
      'Call with no effort to report the current level and where it came from.',
      'Set low, high, or max only when the user asks to change it or the task has clearly outgrown the current level;',
      'ordinary work is classified automatically and needs no call.',
    ].join(' '),
    parameters: {
      effort: {
        type: 'string' as const,
        enum: ['auto', 'low', 'high', 'max'],
        description: 'Omit to inspect; auto clears an override; low/high/max pins this session.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reasoning: { type: 'string', required: true },
          source: { type: 'string', required: true },
          effort: { type: 'string', required: true },
          reason: { type: 'string' },
          stage: { type: 'string', required: true },
          mode: { type: 'string', required: true },
          status: { type: 'string', required: true },
          checkpoint: { type: 'json' },
        },
      },
      render: (_args: unknown, value: any) => [{
        type: 'text',
        text: value.ok === true
          ? `reasoning ${value.reasoning} (${value.source}); effort ${value.effort === '' ? 'not applied' : value.effort}`
          : `reasoning not changed: ${String(value.reason ?? '')}`,
      }],
      presentationMeta: (_args: unknown, value: any) => value.checkpoint,
    },
    async execute(args: { effort?: ReasoningMode }, exec: any): Promise<any> {
      if (exec.agent === undefined) throw new Error('coding_reasoning requires an owning agent session')
      const state = stateOf(exec.agent)
      if (state === undefined) throw new Error('coding_reasoning: this agent is not a Coding lead session')
      const report = (ok: boolean, extra: Record<string, unknown>): any => {
        const summary = reasoning.summary(exec.agent)
        return {
          ok,
          reasoning: summary.level ?? '',
          source: summary.source,
          effort: reasoning.describe(exec.agent).effort ?? '',
          ...summary.reason === undefined ? {} : { reason: summary.reason },
          stage: state.stage,
          mode: state.mode,
          status: statusLine(state),
          checkpoint: checkpointOf(state),
          ...extra,
        }
      }
      if (args?.effort === undefined) return report(true, {})
      const pinned = config().reasoning
      if (pinned !== 'auto') {
        return report(false, {
          reason: `reasoning is pinned to ${pinned} by the Coding configuration; `
            + 'set reasoning: auto before using an in-session override',
        })
      }
      reasoning.override(exec.agent, args.effort, state.turn)
      await reasoning.apply(exec.agent, exec.signal, undefined, state.turn)
      return report(true, {})
    },
  })), 'dsh-coding: coding_reasoning')

  // ── Cross-stage handoff ───────────────────────────────────────────────────
  // The record, not the conversation, is what the workers receive: the lead
  // writes it here, the runtime caps it, and every stage reads its own slice.
  ctx.effect(() => ctx.tools.register(defineTool({
    name: TOOL.handoff,
    description: [
      'Read or update the cross-stage handoff record: the bounded context every worker receives.',
      'In requirements record the goal, the constraints, and the acceptance criteria; in plan record the',
      'decisions and the acceptance checks. Any stage may add findings and open questions as evidence.',
      '`goal` replaces the recorded goal; every list field appends (de-duplicated, capped by the plugin).',
      'Record only what this stage adds or corrects; there is no need to repeat the whole history.',
      'In deliver write the delivery record back first (`delivered` / `followUps`): the next turn and a',
      'resumed session read that record, not this turn\'s message.',
    ].join(' '),
    parameters: {
      goal: {
        type: 'string' as const,
        description: 'What the run is for; replaces the recorded goal.',
      },
      constraints: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description: 'Limits the change must respect; appended.',
      },
      acceptance: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description: 'Observable checks that define done; appended. codex cannot enter verify without one.',
      },
      findings: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description: 'Evidence worth carrying to the next stage; appended.',
      },
      decisions: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description: 'Settled choices later stages must respect; appended.',
      },
      open: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description: 'Questions still unanswered; appended.',
      },
      delivered: {
        type: 'string' as const,
        description: '一条紧凑的交付记录：交付了什么、改了哪些文件、跑了哪个检查；覆盖已记录的交付。'
          + '在 deliver 阶段写入，下一轮对话与重开会话都读它。',
      },
      followUps: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description: '残余风险或后续跟进项；追加。',
      },
      reset: {
        type: 'boolean' as const,
        description: 'Reset the verification retry budget; the handoff itself is kept.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          status: { type: 'string', required: true },
          digest: { type: 'string', required: true },
          checkpoint: { type: 'json' },
        },
      },
      render: (_args: unknown, value: any) => [{
        type: 'text',
        text: value.digest === '' ? value.status : value.digest,
      }],
      presentationMeta: (_args: unknown, value: any) => value.checkpoint,
    },
    async execute(args: {
      goal?: string
      constraints?: string[]
      acceptance?: string[]
      findings?: string[]
      decisions?: string[]
      open?: string[]
      delivered?: string
      followUps?: string[]
      reset?: boolean
    }, exec: any): Promise<any> {
      if (exec.agent === undefined) throw new Error('coding_handoff requires an owning agent session')
      const state = stateOf(exec.agent)
      if (state === undefined) throw new Error('coding_handoff: this agent is not a Coding lead session')
      if (args?.reset === true) resetVerification(state)
      // A field the model omitted is untouched, and an empty list is "no
      // change": only the fields actually supplied reach the merge.
      const list = (value: unknown): readonly string[] | undefined => (
        Array.isArray(value) ? stringList(value) : undefined
      )
      const goal = typeof args?.goal === 'string' ? args.goal : undefined
      const constraints = list(args?.constraints)
      const acceptance = list(args?.acceptance)
      const findings = list(args?.findings)
      const decisions = list(args?.decisions)
      const open = list(args?.open)
      const delivered = typeof args?.delivered === 'string' ? args.delivered : undefined
      const followUps = list(args?.followUps)
      const patch: HandoffPatch = {
        ...goal === undefined ? {} : { goal },
        ...constraints === undefined ? {} : { constraints },
        ...acceptance === undefined ? {} : { acceptance },
        ...findings === undefined ? {} : { findings },
        ...decisions === undefined ? {} : { decisions },
        ...open === undefined ? {} : { open },
        ...delivered === undefined ? {} : { delivered },
        ...followUps === undefined ? {} : { followUps },
      }
      if (Object.keys(patch).length > 0) {
        try {
          state.handoff = mergeHandoff(state.handoff, patch)
        } catch (error) {
          // The record is the workers' only context: a lost merge must reach the
          // lead as a reported failure, not as a silently dropped update.
          fail(state, 'handoff', error)
          throw error
        }
        state.updatedAt = Date.now()
      }
      return {
        ok: true,
        status: statusLine(state),
        digest: handoffDigest(state.handoff),
        checkpoint: checkpointOf(state),
      }
    },
  })), 'dsh-coding: coding_handoff')

  // ── Delegation: the only way the lead may change a file ───────────────────
  // A subagent name is committed to the parent's catalog and never released, so
  // a fixed name would permit exactly one delegation per session. A per-process
  // ordinal is not enough either: this plugin instance is rebuilt on every Host
  // restart while the catalog survives, so the ordinal repeats and the first
  // dispatch after a restart collides with the previous generation's worker.
  // The name therefore carries a timestamp; the role prefix keeps it readable.
  let workerSeq = 0
  const delegate = async (
    exec: any,
    role: WorkerRole,
    args: { task?: string; files?: string[]; acceptance?: string },
  ): Promise<any> => {
    if (exec.agent === undefined) throw new Error(`delegate_${role} requires an owning agent session`)
    const state = stateOf(exec.agent)
    if (state === undefined) throw new Error(`delegate_${role}: this agent is not a Coding lead session`)
    // One worker at a time: a second dispatch would overwrite the first
    // worker's record while its result is still in flight.
    if (state.worker?.status === 'running') {
      throw new Error(`delegate_${role}: a ${state.worker.role} worker is already running; wait for it to finish`)
    }
    const required: CodingStage = role === 'plan' ? 'plan' : role === 'implement' ? 'implement' : 'verify'
    if (state.stage !== required) {
      throw new Error(`delegate_${role} runs only in the ${required} stage (current: ${state.stage})`)
    }
    if (role === 'implement' && (state.plan === undefined || state.plan.items.length === 0)) {
      throw new Error('delegate_implement needs the plan stage task list: call todo_write first')
    }
    const task = typeof args?.task === 'string' ? args.task.trim() : ''
    if (task === '') throw new Error(`delegate_${role}: task must be a non-empty self-contained brief`)
    const files = Array.isArray(args.files) ? args.files.filter((file): file is string => typeof file === 'string') : []
    const route = resolveWorkerRoute(config(), role)
    const workerName = `${role}-${Date.now().toString(36)}-${(workerSeq += 1)}`
    const startedAt = Date.now()
    // Reserve the single worker slot before the model check awaits: a
    // concurrent dispatch must see the slot taken even while validation is
    // still in flight, or both calls pass the guard and race for the result.
    state.worker = { role, status: 'running', startedAt }
    state.updatedAt = startedAt
    // planner 尝试一进入就记为失败：worker 路由不可用时门禁仍然打开，避免一次
    // 失败的派发锁死整个 codex 流程；派发结束再按实际结果改写。
    if (role === 'plan') state.planner = { route: route.text, outcome: 'failed', at: startedAt }
    try {
      await assertWorkerModel(ctx, route, exec.signal)
    } catch (error) {
      fail(state, 'delegate', error)
      const text = messageOf(error)
      state.worker = { role, status: 'failed', startedAt, finishedAt: Date.now(), summary: text }
      state.updatedAt = Date.now()
      throw new Error(
        `${text} Fix the route and call delegate_${role} again; retrying the same route will fail identically.`,
      )
    }
    // verify 只有在 codex 且任务复杂时才值得付出整份 AGENTS.md 的上下文：
    // 多子任务意味着跨任务依赖，改动面大意味着需要仓库规则。
    const taskCount = Math.max(state.handoff?.tasks.length ?? 0, state.plan?.items.length ?? 0)
    const withInstructions = role === 'verify'
      && needsWorkspaceInstructions({ mode: state.mode, taskCount, changedFiles: state.files.size })
    let started: any
    try {
      started = await ctx.subagents.startActivation({
        provider: 'spawn',
        agentPreset: withInstructions ? WORKER_PRESETS.verifyWithInstructions : workerPreset(role),
        name: workerName,
        label: workerLabel(role, task),
        prompt: [{
          type: 'text',
          text: role === 'plan'
            ? plannerPrompt(task, state)
            : role === 'implement' ? implementPrompt(task, files, args.acceptance, state) : verifyPrompt(task, state, withInstructions),
        }],
        parent: exec.agent,
        signal: exec.signal,
        delivery: 'caller',
        agentOptions: { provider: route.provider, model: route.model },
        outputSchema: role === 'plan' ? PLANNER_REPORT_SCHEMA : role === 'implement' ? IMPLEMENT_REPORT_SCHEMA : VERIFY_REPORT_SCHEMA,
      })
    } catch (error) {
      fail(state, 'delegate', error)
      state.worker = { role, status: 'failed', startedAt, finishedAt: Date.now(), summary: messageOf(error) }
      throw new Error(`delegate_${role}: could not start the worker: ${messageOf(error)}`)
    }
    state.worker = { ...state.worker, childId: started.childId, startedAt }
    let result: any
    try {
      result = await started.result
    } catch (error) {
      fail(state, 'delegate', error)
      state.worker = { role, status: 'failed', childId: started.childId, startedAt, finishedAt: Date.now(), summary: messageOf(error) }
      throw new Error(`delegate_${role}: the worker failed: ${messageOf(error)}`)
    } finally {
      void Promise.resolve(started.dispose?.()).catch(() => {})
    }
    const report = asWorkerReport(result?.structured)
    const stopReason = String(result?.stopReason ?? 'error')
    const ok = stopReason === 'completed' && report?.ok === true
    state.worker = {
      role,
      status: ok ? 'completed' : 'failed',
      childId: started.childId,
      startedAt,
      finishedAt: Date.now(),
      ...report === undefined
        ? { summary: outputText(result) ?? `worker ended with ${stopReason}` }
        : { summary: report.summary, ...report.files.length === 0 ? {} : { files: report.files } },
    }
    state.updatedAt = Date.now()
    if (role === 'plan') {
      state.planner = { route: route.text, outcome: ok ? 'completed' : 'failed', at: state.updatedAt }
    }
    // The dispatch is the failure point either way: a worker that ran but did
    // not complete is the same interruption, and a completed one clears it.
    if (ok) clearFailure(state, 'delegate')
    else fail(state, 'delegate', new Error(state.worker?.summary ?? `the ${role} worker ended with ${stopReason}`))
    if (role === 'implement' && ok && report !== undefined) {
      // A new implementation invalidates any earlier verification: the deliver
      // gate must read evidence produced after the last edit.
      state.verification = undefined
      // A worker re-reports files it already touched, so a dispatch total
      // overcounts; the card's "files changed" is a session total of paths.
      for (const file of report.files) state.files.add(file)
      state.edits = state.baseEdits + state.files.size
      // The verifier and the delivery read the handoff, not the worker catalog:
      // record what this dispatch changed and what the worker noted.
      const notes = report.notes?.trim() ?? ''
      state.handoff = mergeHandoff(state.handoff, {
        changes: report.files.map(file => ({ file, summary: report.summary })),
        ...notes === '' ? {} : { findings: [notes] },
      })
    }
    if (role === 'plan' && ok && report !== undefined) {
      // The planner's task list becomes the plan the implement workers receive,
      // and its summary is the finding the later stages plan against.
      const summary = report.summary.trim()
      state.handoff = mergeHandoff(state.handoff, {
        tasks: report.tasks,
        ...summary === '' ? {} : { findings: [report.summary] },
      })
    }
    if (role === 'verify') {
      // A report that contradicts itself (ok, but failing tests) is not
      // evidence: the deliver gate reads this record, and the lead must see
      // both the command and the failing names.
      const command = report?.command?.trim() ?? ''
      const failedTests = report?.failedTests ?? []
      const missingCommand = command === ''
      const passed = ok && !missingCommand && failedTests.length === 0
      const outcome: VerificationOutcome = {
        passed,
        kind: report?.kind ?? 'test',
        scope: report?.scope ?? 'package',
        source: 'worker',
        command: missingCommand ? '(verify worker reported no command)' : command,
        exitCode: passed ? 0 : 1,
        durationMs: Date.now() - startedAt,
        failedTests,
        errors: [
          ...report?.findings ?? [],
          ...missingCommand ? ['the verify worker did not report the command it ran'] : [],
          ...failedTests.length === 0 ? [] : [`the verify worker reported failing tests: ${failedTests.join('; ')}`],
        ],
        ranAt: Date.now(),
      }
      // The retry budget, not the lead's patience, decides when the loop stops.
      recordVerification(state, outcome, {
        maxAttempts: config().maxVerifyAttempts,
        maxSameFailure: config().maxSameFailure,
      })
      const reported = report?.findings ?? []
      const findings = reported.length > 0
        ? reported
        : report !== undefined && report.summary.trim() !== '' ? [report.summary] : []
      if (findings.length > 0) state.handoff = mergeHandoff(state.handoff, { findings })
    }
    if (role === 'plan') {
      return {
        ok,
        worker: role,
        childId: started.childId,
        stopReason,
        summary: report?.summary ?? outputText(result) ?? '',
        tasks: report?.tasks ?? [],
        checkpoint: checkpointOf(state),
      }
    }
    return {
      ok,
      worker: role,
      childId: started.childId,
      stopReason,
      summary: report?.summary ?? outputText(result) ?? '',
      files: report?.files ?? [],
      findings: report?.findings ?? [],
      failedTests: report?.failedTests ?? [],
      notes: report?.notes ?? '',
      output: ok ? '' : outputText(result) ?? '',
      checkpoint: checkpointOf(state),
    }
  }

  const delegationOutput = {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean', required: true },
        worker: { type: 'string', required: true },
        childId: { type: 'string', required: true },
        stopReason: { type: 'string', required: true },
        summary: { type: 'string', required: true },
        files: { type: 'array', items: { type: 'string' } },
        findings: { type: 'array', items: { type: 'string' } },
        failedTests: { type: 'array', items: { type: 'string' } },
        notes: { type: 'string' },
        output: { type: 'string' },
        checkpoint: { type: 'json' },
      },
    } as const,
    render: (_args: unknown, value: any) => [{
      type: 'text' as const,
      text: value.ok === true
        ? `${value.worker} worker completed: ${value.summary}`
          + (value.files.length === 0 ? '' : `\nFiles changed: ${value.files.join(', ')}`)
        : `${value.worker} worker did not complete (${value.stopReason}): ${value.summary}`
          + (value.failedTests.length === 0 ? '' : `\nFailing tests: ${value.failedTests.join('; ')}`)
          + (value.output === '' ? '' : `\n${value.output}`),
    }],
    presentationMeta: (_args: unknown, value: any) => value.checkpoint,
  }

  const plannerOutput = {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean', required: true },
        worker: { type: 'string', required: true },
        childId: { type: 'string', required: true },
        stopReason: { type: 'string', required: true },
        summary: { type: 'string', required: true },
        // The planner's tasks are handoff tasks, so the canonical value keeps
        // the same shape the handoff and the implement briefs read.
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              goal: { type: 'string', required: true },
              files: { type: 'array', items: { type: 'string' } },
              acceptance: { type: 'string' },
              avoid: { type: 'string' },
            },
          },
        },
        checkpoint: { type: 'json' },
      },
    } as const,
    render: (_args: unknown, value: any) => [{
      type: 'text' as const,
      text: value.ok === true
        ? `plan worker completed: ${value.summary}\n\nSingle-purpose tasks:\n`
          + value.tasks.map((task: any, index: number) => (
            `${index + 1}. ${String(task.goal)}`
            + (Array.isArray(task.files) && task.files.length > 0 ? ` [${task.files.join(', ')}]` : '')
            + ` — done: ${String(task.acceptance ?? '')}`
            + (typeof task.avoid === 'string' && task.avoid !== '' ? `; avoid: ${task.avoid}` : '')
          )).join('\n')
          + '\n\nNext: call todo_write with one pending item per task, then advance to implement and dispatch each task with delegate_implement.'
        : `plan worker did not complete (${value.stopReason}): ${value.summary}`,
    }],
    presentationMeta: (_args: unknown, value: any) => value.checkpoint,
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: TOOL.plan,
    description: [
      'Delegate requirement analysis and sub-task planning to the planner worker (pro model).',
      'The worker explores the workspace read-only and returns a list of single-purpose sub-tasks;',
      'it cannot edit files, run a shell, or delegate further. Available only in the plan stage.',
      'After it returns, call todo_write with one pending item per task, then advance to implement.',
    ].join(' '),
    parameters: {
      task: {
        type: 'string' as const,
        required: true,
        description: 'The requirement to analyse, self-contained; the worker cannot see this conversation.',
      },
    },
    output: plannerOutput,
    timeoutMs: 3_600_000,
    async execute(args: { task?: string }, exec: any): Promise<any> {
      return delegate(exec, 'plan', args)
    },
  })), 'dsh-coding: delegate_plan')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: TOOL.implement,
    description: [
      'Delegate one implementation task to the implement worker and wait for its structured report.',
      'The worker runs in an isolated context with only the editing tools (read, apply_patch, edit, write);',
      'the lead keeps no edit permission. The brief must be self-contained: goal, acceptance criteria,',
      'exact files, and the excerpts the worker needs. Available only in the implement stage.',
    ].join(' '),
    parameters: {
      task: {
        type: 'string' as const,
        required: true,
        description: 'Complete, self-contained implementation brief; the worker cannot see this conversation.',
      },
      files: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description: 'Files the worker should touch, as repository-relative paths.',
      },
      acceptance: {
        type: 'string' as const,
        description: 'Observable acceptance criteria the worker must satisfy.',
      },
    },
    output: delegationOutput,
    timeoutMs: 3_600_000,
    async execute(args: { task?: string; files?: string[]; acceptance?: string }, exec: any): Promise<any> {
      return delegate(exec, 'implement', args)
    },
  })), 'dsh-coding: delegate_implement')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: TOOL.verify,
    description: [
      'Delegate one read-only verification investigation to the verify worker.',
      'The worker can read files, search them, and run checks through run_verification; it holds no edit tool.',
      'Use it when a failing check needs diagnosis, or when the report should cite reproducible evidence.',
      'Available only in the verify stage.',
    ].join(' '),
    parameters: {
      task: {
        type: 'string' as const,
        required: true,
        description: 'What to verify and the failure to investigate, self-contained.',
      },
    },
    output: delegationOutput,
    timeoutMs: 3_600_000,
    async execute(args: { task?: string; files?: string[] }, exec: any): Promise<any> {
      return delegate(exec, 'verify', args)
    },
  })), 'dsh-coding: delegate_verify')

  // ── Structured verification ───────────────────────────────────────────────
  registerVerificationTool(ctx, {
    config,
    onRun: (run, exec) => {
      const state = stateOf(exec.agent)
      if (state === undefined) return
      // Every failed check spends one attempt of the retry budget, whether the
      // lead ran it or a verify worker reported it.
      recordVerification(state, {
        passed: run.passed,
        kind: run.kind,
        scope: run.scope,
        source: 'lead',
        command: run.command,
        exitCode: run.exitCode,
        durationMs: run.durationMs,
        failedTests: run.failedTests,
        errors: run.errors,
        ranAt: run.ranAt,
      }, {
        maxAttempts: config().maxVerifyAttempts,
        maxSameFailure: config().maxSameFailure,
      })
      if (run.passed) {
        clearFailure(state, 'verification')
        return
      }
      // A normal failing check keeps its own budget/BLOCKED path; only a check
      // that could not start or timed out is a runtime failure.
      if (run.command === '' || run.errors.some(error => error.includes('verificationTimeoutMs'))) {
        fail(state, 'verification', new Error(
          run.errors.join('; ') || `verification ${run.kind} could not run`,
        ))
      }
    },
    decorate: (exec) => {
      const state = stateOf(exec.agent)
      return state === undefined ? null : checkpointOf(state)
    },
  })

  // ── Control channel for the UI and the user ──────────────────────────────
  // The body is extracted so an exception becomes a reported failure with a
  // next move: `/coding` is the operator's own recovery path.
  const handleCodingCommand = async ({ agent, rawInput, signal }: { agent: any; rawInput?: string; signal?: AbortSignal }) => {
    const state = stateOf(agent)
    if (state === undefined) {
      return { kind: 'error' as const, text: 'this session is not running the dsh-coding preset' }
    }
    const text = typeof rawInput === 'string' ? rawInput.trim().toLowerCase() : ''
    if (text === '') {
      return { kind: 'success' as const, text: `${statusLine(state)}\nstages: ${stagePath(state.mode)}` }
    }
    if (text === 'reset') {
      // The budget belongs to the current fix/verify loop; the handoff and
      // the recorded verification stay as evidence.
      resetVerification(state)
      return { kind: 'success' as const, text: `verification retry budget reset; ${statusLine(state)}` }
    }
    if (text === 'memory') {
      // 交接文档由 Host 写盘：浏览器半只发这一行命令，不直接写文件。
      const written = await writeMemoryDocument(ctx, agent, state, { signal })
      if (!written.ok) return { kind: 'error' as const, text: `${written.reason} — ${written.action}` }
      return {
        kind: 'success' as const,
        text: `handoff document written: ${written.displayPath} (session ${state.sessionId})`,
      }
    }
    if (text.startsWith('stage')) {
      const target = text.slice('stage'.length).trim() as CodingStage
      if (!(CODING_STAGES as readonly string[]).includes(target)) {
        return { kind: 'error' as const, text: `unknown stage "${target}"; use ${CODING_STAGES.join(', ')}` }
      }
      const check = checkAdvance(state, target, advanceOptions(agent))
      if (!check.ok) {
        // A user-issued move reports the gate but never arms the
        // step-blocking refusal meant for a model that tried to skip it.
        return { kind: 'error' as const, text: check.reason ?? 'refused' }
      }
      applyStage(state, target, 'user control')
      // A user-issued exit from an exhausted retry budget is still a
      // blocked delivery: the report must disclose the failing check.
      if (check.blocked === true) state.deliveryBlocked = true
      syncTable(agent, state)
      // A stage change takes effect at the next step of the live turn.
      agent.steer?.(controlMessage(
        `The user moved this session to the ${target} stage.\n\n${stageContext({
          mode: state.mode,
          stage: state.stage,
          status: statusLine(state),
          handoff: handoffDigest(state.handoff),
        })}`,
        `stage → ${target}`,
      ))
      return { kind: 'success' as const, text: `stage set to ${target}; ${statusLine(state)}` }
    }
    if (text.startsWith('set')) {
      const target = text.slice('set'.length).trim()
      if (!(CODING_MODES as readonly string[]).includes(target)) {
        return { kind: 'error' as const, text: `unknown mode "${target}"; use ${CODING_MODES.join(', ')}` }
      }
      applyMode(state, target as CodingMode)
      syncTable(agent, state)
      // Silent by design: the pre-Turn picker sets the mode for the first
      // message and must not start a Turn or inject a control message.
      return { kind: 'success' as const, text: `mode set to ${target}; ${statusLine(state)}` }
    }
    if (!(CODING_MODES as readonly string[]).includes(text)) {
      return { kind: 'error' as const, text: `unknown mode "${text}"; use ${CODING_MODES.join(', ')}` }
    }
    applyMode(state, text as CodingMode)
    syncTable(agent, state)
    // A mode switch changes the plan, so it belongs to a fresh turn.
    agent.followup?.(controlMessage(
      `The user switched this session to ${text} mode. Stages: ${stagePath(state.mode)}. `
      + 'Continue under that mode; re-read the stage contract injected with the next step.',
      `mode → ${text}`,
    ))
    return { kind: 'success' as const, text: `mode set to ${text}; ${statusLine(state)}` }
  }

  ctx.inject(['commands'], (child: any) => {
    child.commands.register({
      name: 'coding',
      description: 'Show or set this session\'s Coding mode or stage: /coding <auto|consult|review|codex>, /coding set <mode> (silent, no Turn), or /coding stage <name>. /coding memory writes a handoff document for this turn under .agents/memory at the project root.',
      input: { hint: 'auto | consult | review | codex | set <auto|consult|review|codex> | stage <requirements|plan|implement|verify|deliver> | reset | memory' },
      handler: async (payload: { agent: any; rawInput?: string; signal?: AbortSignal }) => {
        try {
          return await handleCodingCommand(payload)
        } catch (error) {
          const state = stateOf(payload.agent)
          if (state !== undefined) fail(state, 'command', error)
          const reason = messageOf(error)
          const action = state === undefined
            ? 'Fix the reported error, then retry the command.'
            : makeFailure('command', error, currentLanguage()).action
          return { kind: 'error' as const, text: `${reason} — ${action}` }
        }
      },
    })
  })
}


/**
 * Register the conversation-language section exactly once per agent.
 * @param ctx - preset context.
 * @param config - live configuration reader.
 */
function registerLanguage(ctx: any, config: () => CodingConfig): void {
  const prompt = ctx.get?.('systemPrompt') ?? ctx.systemPrompt
  if (typeof prompt?.context !== 'function') return
  try {
    prompt.context({
      name: 'coding:language',
      order: 12,
      text: () => languagePrompt(resolveHostLanguage({
        mode: config().language,
        loader: ctx.get?.('loader') ?? ctx.loader,
        systemLanguages,
      })),
    })
  } catch (error) {
    ctx.logger?.warn?.(`dsh-coding: could not register the language prompt section: ${messageOf(error)}`)
  }
}

/** One task-list status value. */
type PlanItemStatus = 'pending' | 'in_progress' | 'completed'

/** Render a worker's final text output, capped for a tool result. */
function outputText(result: any): string | undefined {
  const content = result?.output
  if (!Array.isArray(content)) return undefined
  const text = content
    .map((block: any) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('\n')
    .trim()
  return text === '' ? undefined : text.slice(0, 4000)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Fail the mount when the runtime cannot honour its own gates: a worker route
 * that could silently fall back to the lead's model, or a subagent backend that
 * cannot carry the explicit worker preset.
 * @param ctx - plugin context.
 * @param config - verified configuration.
 */
async function preflight(ctx: any, config: CodingConfig): Promise<void> {
  // Every worker route is parsed eagerly, so a malformed field fails the mount
  // instead of the first dispatch.
  const routes = WORKER_ROLES.map(role => resolveWorkerRoute(config, role))

  const provider = ctx.subagents?.getProvider?.('spawn')
  if (provider === undefined) {
    throw new Error(
      'dsh-coding: the "spawn" subagent provider is not registered; mount '
      + '@deepseek-ai/dsh-subagent-spawn-in-process in this composition',
    )
  }
  const capabilities = provider.capabilities ?? {}
  for (const capability of ['agentOptions', 'agentPreset', 'outputSchema'] as const) {
    if (capabilities[capability] !== true) {
      throw new Error(`dsh-coding: the "spawn" subagent provider does not support ${capability}, which the worker dispatch requires`)
    }
  }
  // Provider existence is checkable; the model catalog may need credentials, so
  // an empty or unavailable catalog defers model validation to the dispatch.
  const providers = describeProviders(ctx)
  if (providers.length > 0) {
    for (const route of routes) {
      if (!providers.includes(route.provider)) {
        const available = providers.join(', ')
        throw new Error(
          `dsh-coding: ${route.field} names LLM provider "${route.provider}", which is not registered; `
          + `available providers: ${available || '(none)'}`,
        )
      }
    }
  }
}
