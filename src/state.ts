/**
 * Per-agent Coding session state: the stage machine, its gates, and the
 * deterministic tool policy derived from them.
 *
 * The state is a derived cache, never the source of truth: every transition is
 * also emitted as a whole-value checkpoint inside a Coding tool result, which
 * the Session log keeps. A Host restart loses this object, but a resumed
 * session reseeds it from the durable projection instead of restarting the run
 * at the entry stage, so the card and the stage machine stay in agreement.
 *
 * @module dsh-coding/state
 */
import type { CodingConfig } from './config.js'
import type { CodingFailure } from './failures.js'
import { hasDefinitionOfDone, hasGoal, type CodingHandoff } from './handoff.js'
import {
  IMPLEMENT_TABLE,
  STAGES_BY_MODE,
  entryStage,
  stageAdmits,
  stageInMode,
  stagePath,
  toolClass,
  type CodingCheckpoint,
  type CodingMode,
  type CodingStage,
  type PlannerAttempt,
  type StageTransition,
  type VerificationOutcome,
  type WorkerRecord,
} from './stages.js'

/** One structured task-list entry, as `todo_write` records it. */
export interface PlanItem {
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed'
}

/** Live state of one Coding session. */
export interface CodingState {
  /** Stable identity reported with every checkpoint. */
  runId: string
  readonly sessionId: string
  readonly startedAt: number
  mode: CodingMode
  stage: CodingStage
  updatedAt: number
  /** Latest observed turn/step, copied into every checkpoint. */
  turn: number
  step: number
  /** Successful read/executing observations during requirements. */
  requirementsObserved: number
  /** Latest `todo_write` snapshot, or undefined before the first write. */
  plan?: { readonly items: readonly PlanItem[]; readonly at: number }
  /** Files the implement worker reported writing. */
  edits: number
  /** Distinct paths the implement workers reported across this session. */
  files: Set<string>
  /** Edit count inherited from a checkpoint that carried no `files` list. */
  baseEdits: number
  worker?: WorkerRecord
  /** planner 派发尝试；有值即表示这个会话已经尝试过 planner（成功或失败）。 */
  planner?: PlannerAttempt
  verification?: VerificationOutcome
  refusal?: { readonly target: CodingStage; readonly reason: string; readonly at: number }
  /** Bounded handoff record: the only context the planner and implement workers receive. */
  handoff?: CodingHandoff
  /** Failed verifications this session spent against the retry budget. */
  verificationAttempts: number
  /** Consecutive failures whose signature matched the previous one. */
  sameFailureCount: number
  /** Signature of the last failed verification, for the repeat detector. */
  lastFailureSignature?: string
  /** Set once the retry budget is exhausted; cleared only by a passing verification. */
  verifyBlocked?: { attempts: number; reason: string; at: number }
  /** The most recent blocking exception this session has not recovered from. */
  failure?: CodingFailure
  /** A blocking exception the user has not been told about yet; cleared once shown. */
  failureNotice?: CodingFailure
  /** This delivery reports blocked work instead of a completed change. */
  deliveryBlocked: boolean
  /**
   * The last refusal already delivered to the model as a blocked step. It is
   * re-injected with the next step's contract, because a rejected step keeps
   * none of its own messages in the Inbox.
   */
  lastRefusal?: string
  readonly transitions: StageTransition[]
  /**
   * 已尝试过投影恢复（已应用，或确认本会话没有可恢复的状态）。非持久化字段：
   * 不写进 checkpoint，`asCheckpoint` / `restoreFromView` 也不读写它；仅用于让
   * 后续 pre-step 不再重复读投影。投影尚未就绪时不设置，留给下一步重试。
   */
  restored?: boolean
}

/** Outcome of one attempted stage advance. */
export interface AdvanceCheck {
  readonly ok: boolean
  /** A refusal that reports the next move without blocking the step (auto mode's workflow choice). */
  readonly soft?: boolean
  /** The move is granted, but the run must deliver a BLOCKED report. */
  readonly blocked?: boolean
  readonly reason?: string
}

/** A denial produced by the stage policy, with the guidance the model needs. */
export interface ToolVerdict {
  readonly deny?: string
}

/** Build the initial state of a session in one mode. */
export function createState(sessionId: string, mode: CodingMode): CodingState {
  const now = Date.now()
  return {
    runId: `${sessionId}:${now.toString(36)}`,
    sessionId,
    startedAt: now,
    mode,
    stage: entryStage(mode),
    updatedAt: now,
    turn: 0,
    step: 0,
    requirementsObserved: 0,
    edits: 0,
    files: new Set<string>(),
    baseEdits: 0,
    verificationAttempts: 0,
    sameFailureCount: 0,
    deliveryBlocked: false,
    transitions: [],
  }
}

/** The durable projection slice a resume reads; structural so the client view can be passed directly. */
export interface RestoreView {
  readonly mode: CodingMode
  readonly stage: CodingStage
  readonly plan: readonly PlanItem[]
  readonly checkpoint?: CodingCheckpoint | null
  readonly updatedAt: number
}

/**
 * Seed the live state from the durable projection. A resumed session must keep
 * the stage, plan, verification, and edit evidence its Session log recorded,
 * or the runtime would silently restart the run while the card still shows it.
 * A refusal is deliberately not restored: an old gate rejection must not block
 * the first step after a restart. The verification retry budget is restored
 * from the checkpoint, while the repeat detector starts over: the signature of
 * the failure that exhausted it is not part of the checkpoint.
 * @param state - live state of the resumed agent (mutated).
 * @param view - validated projection value for the same session.
 */
export function restoreFromView(state: CodingState, view: RestoreView): void {
  state.mode = view.mode
  state.stage = stageInMode(view.mode, view.stage) ? view.stage : entryStage(view.mode)
  state.plan = view.plan.length === 0
    ? undefined
    : { items: view.plan.map(item => ({ content: item.content, status: item.status })), at: view.updatedAt }
  state.refusal = undefined
  state.lastRefusal = undefined
  // A restart cannot know which failure signature the live state last held, so
  // the repeat detector starts over: the next failure counts as its own first.
  state.sameFailureCount = 0
  state.lastFailureSignature = undefined
  state.deliveryBlocked = false
  const checkpoint = view.checkpoint ?? undefined
  if (checkpoint === undefined) {
    state.updatedAt = Math.max(state.updatedAt, view.updatedAt)
    return
  }
  state.runId = checkpoint.runId
  state.turn = checkpoint.turn
  state.step = checkpoint.step
  state.files = new Set(checkpoint.files ?? [])
  // A checkpoint written before `files` existed only knows the total; keep it
  // as a floor so a resumed session never reports fewer edits than it made.
  state.baseEdits = checkpoint.files === undefined ? checkpoint.edits : 0
  state.edits = checkpoint.edits
  // A checkpoint proves the session already inspected the workspace before it
  // progressed; do not make a resumed plan stage re-satisfy the requirements gate.
  state.requirementsObserved = Math.max(state.requirementsObserved, 1)
  if (checkpoint.verification !== undefined) state.verification = checkpoint.verification
  if (checkpoint.handoff !== undefined) state.handoff = checkpoint.handoff
  // The failure is restored without its notice: the user saw the reason before
  // the restart, so a resumed session must not report it a second time.
  if (checkpoint.failure !== undefined) state.failure = checkpoint.failure
  state.verificationAttempts = checkpoint.verifyAttempts ?? 0
  state.verifyBlocked = checkpoint.verifyBlocked
  if (checkpoint.worker !== undefined) state.worker = checkpoint.worker
  if (checkpoint.planner !== undefined) state.planner = checkpoint.planner
  state.updatedAt = Math.max(checkpoint.updatedAt, view.updatedAt)
}

/** Stage at which this mode's own gates can be satisfied, one line. */
export function stageGuidance(mode: CodingMode): string {
  return `stages: ${stagePath(mode)}`
}

/** 强制 planner 的任务单阈值：严格大于三条即为“复杂任务”。 */
export const PLANNER_TODO_THRESHOLD = 3

/** 调用方提供的运行时事实：纯函数拿不到主 Agent 的模型与配置。 */
export interface AdvanceOptions {
  /** 主 Agent 自身模型就是配置的 planner 路由，planner 因此是多余的。 */
  readonly leadIsPlanner?: boolean
  /** 配置 `requirePlanner: 'off'` 时整条门禁关闭。 */
  readonly plannerGate?: boolean
}

/**
 * 是否需要先派发 planner：仅 codex、任务单超过阈值、还没有尝试过、且主 Agent
 * 自身不是 planner 路由；配置关闭时永不要求。
 */
function plannerGateOpen(state: CodingState, options: AdvanceOptions): boolean {
  if (state.mode !== 'codex') return false
  if (options.plannerGate === false) return false
  if (options.leadIsPlanner === true) return false
  if (state.planner !== undefined) return false
  return (state.plan?.items.length ?? 0) > PLANNER_TODO_THRESHOLD
}

/**
 * Decide whether the model may move to `target` now. Conditions are checked by
 * plugin code, never taken from the model's assertion.
 * @param state - live session state.
 * @param target - requested stage.
 * @param options - 调用方提供的运行时事实（主 Agent 是否即 planner 路由、门禁是否开启）。
 * @returns whether the move is allowed, and why not when it is refused.
 */
export function checkAdvance(state: CodingState, target: CodingStage, options: AdvanceOptions = {}): AdvanceCheck {
  if (!stageInMode(state.mode, target)) {
    if (state.mode === 'auto') {
      return {
        ok: false,
        soft: true,
        reason:
          'auto mode has not chosen a workflow yet: in the requirements stage call coding_mode with consult '
          + '(the fallback when the request is unclear), review, or codex, then follow that mode\'s stages. '
          + 'Do not skip the workflow choice by advancing a stage.',
      }
    }
    return {
      ok: false,
      reason:
        `stage "${target}" is not part of ${state.mode} mode (${stagePath(state.mode)}). `
        + 'Switch mode with coding_mode, or advance to a stage this mode opens.',
    }
  }
  if (target === 'plan' && state.requirementsObserved === 0) {
    return {
      ok: false,
      reason:
        'the requirements stage is not complete: inspect the workspace first (read, grep, glob, or one shell command), '
        + 'then advance to plan.',
    }
  }
  // The planner worker receives the handoff and nothing else of the lead's
  // conversation, so a run without a recorded goal would plan from guesswork.
  if (target === 'plan' && state.mode === 'codex' && !goalRecorded(state)) {
    return {
      ok: false,
      reason:
        'the requirements stage has no recorded goal: call coding_handoff({ goal, constraints, acceptance }) '
        + 'before advancing to plan. The handoff is the only context the planner and the implement workers receive.',
    }
  }
  if (target === 'implement' && (state.plan === undefined || state.plan.items.length === 0)) {
    return {
      ok: false,
      reason:
        'no structured task list yet: call todo_write with 1-3 verifiable steps for a small single-file change, '
        + 'or 4-6 for a multi-file change (exactly one in_progress), then advance to implement.',
    }
  }
  // 可机器验证的复杂度判据只有一条：任务单超过三条。这个规模在 codex 下必须
  // 先让 planner worker（pro 模型）勘探并拆分任务；派发失败也算尝试。
  if (target === 'implement' && plannerGateOpen(state, options)) {
    const items = state.plan?.items.length ?? 0
    return {
      ok: false,
      reason:
        `the task list has ${items} items, which is complex enough to plan with the planner worker: `
        + 'call delegate_plan in the plan stage (pro model) first, then write the task list from its sub-tasks. '
        + 'A dispatch that fails still opens this gate, so fix the route and retry once. '
        + 'A small single-file change needs three items or fewer and skips this gate.',
    }
  }
  // In codex mode verification follows an applied edit; in review mode the
  // verify stage checks existing behavior, so no edit is expected.
  if (target === 'verify' && state.mode === 'codex' && state.edits === 0) {
    return {
      ok: false,
      reason:
        'nothing has been implemented yet: advance to implement, run delegate_implement, and let the '
        + 'implement-worker report the files it changed before moving to verify.',
    }
  }
  // Verification is only evidence against a stated standard: without one the
  // verifier cannot tell a finished change from a modified file.
  if (target === 'verify' && state.mode === 'codex' && !doneRecorded(state)) {
    return {
      ok: false,
      reason:
        'no definition of done: call coding_handoff({ acceptance: [...] }) with the observable checks that prove '
        + 'this change (one per task), then advance to verify. A task without a verification standard cannot be delivered.',
    }
  }
  if (target === 'deliver') {
    if (state.mode === 'codex' && state.verification?.passed !== true) {
      // The retry budget turns an endless fix/verify loop into one blocked
      // delivery: report the failing check instead of repeating the same fix.
      if (state.verifyBlocked !== undefined) {
        return {
          ok: true,
          blocked: true,
          reason:
            'verification retry budget exhausted: deliver a BLOCKED report naming the failing check and the last '
            + 'error; do not retry the same failure.',
        }
      }
      return {
        ok: false,
        reason:
          'verification has not passed: run run_verification in the verify stage (or delegate_verify) and '
          + 'get a passing result before delivering. Fix the failure in implement first.'
          + (state.verificationAttempts > 0
            ? ` Attempt ${state.verificationAttempts} of the retry budget has been used.`
            : ''),
      }
    }
    if (state.mode === 'codex' && (!goalRecorded(state) || !doneRecorded(state))) {
      return {
        ok: false,
        reason:
          'the handoff is incomplete for delivery: call coding_handoff({ goal, acceptance: [...] }) so the delivery '
          + 'report can state what was asked and which acceptance checks prove it.',
      }
    }
    if (state.mode === 'review' && state.verification === undefined) {
      return {
        ok: false,
        reason:
          'review mode delivers findings: run run_verification (or delegate_verify) at least once so '
          + 'the report states what was checked.',
      }
    }
  }
  return { ok: true }
}

/**
 * Apply one granted stage transition.
 * @param state - live session state (mutated).
 * @param target - granted stage.
 * @param reason - why the move happened, kept in the transition log.
 */
export function applyStage(state: CodingState, target: CodingStage, reason: string): void {
  if (state.stage === target) return
  // A granted move is a fresh attempt: an earlier blocked delivery is moot here.
  state.deliveryBlocked = false
  // A granted move satisfies whatever gate was last refused.
  state.refusal = undefined
  state.lastRefusal = undefined
  const from = state.stage
  state.stage = target
  state.updatedAt = Date.now()
  state.transitions.push({ from, to: target, at: state.updatedAt, reason })
  if (state.transitions.length > 40) state.transitions.splice(0, state.transitions.length - 40)
}

/** Whether the handoff already states a goal, which codex `plan` requires. */
function goalRecorded(state: CodingState): boolean {
  return state.handoff !== undefined && hasGoal(state.handoff)
}

/** Whether the handoff already states a definition of done, which `verify` and `deliver` require. */
function doneRecorded(state: CodingState): boolean {
  return state.handoff !== undefined && hasDefinitionOfDone(state.handoff)
}

/** How many failures one session may spend before it must deliver blocked. */
export interface VerificationBudget {
  /** Failed verifications allowed in total; `0` means no limit. */
  readonly maxAttempts: number
  /** Repeats of the identical failure allowed; `0` means no limit. */
  readonly maxSameFailure: number
}

/**
 * Reduce one failed verification to a comparable signature. The signature is
 * what decides whether the lead is fixing the failure or repeating the same
 * attempt, so it keeps only the stable parts: failing test names (sorted, the
 * order they were reported in means nothing), the first three error lines, and
 * the exit code.
 * @param outcome - the verification result to fingerprint.
 * @returns a deterministic signature string.
 */
export function failureSignature(outcome: VerificationOutcome): string {
  const errors = outcome.errors
    .map(error => error.trim())
    .filter(error => error !== '')
    .slice(0, 3)
  return JSON.stringify({
    failed: [...outcome.failedTests].sort(),
    errors,
    exit: outcome.exitCode,
  })
}

/**
 * Record one verification result and spend or refund the retry budget.
 *
 * A pass ends the loop: every counter is cleared, so the next edit starts from
 * a clean budget. A failure increments the attempt counter and the repeat
 * counter, and once either budget is spent it sets {@link CodingState.verifyBlocked},
 * which is the state `checkAdvance` reads to allow the blocked delivery. A
 * failure never clears that flag: only a passing verification does.
 * @param state - live session state (mutated).
 * @param outcome - the verification result.
 * @param budget - the configured retry budget.
 */
export function recordVerification(state: CodingState, outcome: VerificationOutcome, budget: VerificationBudget): void {
  state.verification = outcome
  state.updatedAt = outcome.ranAt
  if (outcome.passed) {
    clearBudget(state)
    return
  }
  state.verificationAttempts += 1
  const signature = failureSignature(outcome)
  state.sameFailureCount = state.lastFailureSignature === signature ? state.sameFailureCount + 1 : 1
  state.lastFailureSignature = signature
  const exhausted = (budget.maxAttempts > 0 && state.verificationAttempts >= budget.maxAttempts)
    || (budget.maxSameFailure > 0 && state.sameFailureCount >= budget.maxSameFailure)
  if (!exhausted) return
  const attempts = state.verificationAttempts
  state.verifyBlocked = {
    attempts,
    reason:
      `verification failed ${attempts} time(s) (${state.sameFailureCount} identical in a row); retry budget exhausted. `
      + 'Stop the fix/verify loop: change the approach with a materially different fix, or advance to deliver and '
      + 'report a BLOCKED delivery naming the failing check and the last error.',
    at: outcome.ranAt,
  }
}

/**
 * Forget the retry budget of a run, keeping its last verification as evidence.
 * Used by an explicit reset: the counters belong to the current fix/verify loop,
 * not to the session's history.
 * @param state - live session state (mutated).
 */
export function resetVerification(state: CodingState): void {
  clearBudget(state)
  state.updatedAt = Date.now()
}

/** Clear every retry-budget field, leaving `verification` untouched. */
function clearBudget(state: CodingState): void {
  state.verificationAttempts = 0
  state.sameFailureCount = 0
  state.lastFailureSignature = undefined
  state.verifyBlocked = undefined
  state.deliveryBlocked = false
}

/**
 * Record a refused advance. The next `agent/pre-step` rejects once with this
 * reason, which is the documented penalty for skipping a gate.
 * @param state - live session state (mutated).
 * @param target - stage the model tried to enter.
 * @param reason - the gate that refused it.
 */
export function recordRefusal(state: CodingState, target: CodingStage, reason: string): void {
  state.refusal = { target, reason, at: Date.now() }
  state.lastRefusal = reason
  state.updatedAt = state.refusal.at
}

/** Clear the one-shot refusal after the blocking step has run. */
export function clearRefusal(state: CodingState): string | undefined {
  const refusal = state.refusal
  state.refusal = undefined
  return refusal?.reason
}

/**
 * Read and clear the refusal text that rides the next step's contract. The
 * blocked turn itself carries no messages, so this is the only way the model
 * learns why its step was rejected.
 * @param state - live session state.
 * @returns the refusal text, once.
 */
export function takeLastRefusal(state: CodingState): string | undefined {
  const value = state.lastRefusal
  state.lastRefusal = undefined
  return value
}

/**
 * Record one blocking exception. It becomes the session's current failure, and
 * is remembered as a notice the next step delivers once.
 * @param state - live session state (mutated).
 * @param failure - the report built at the failing dispatch point.
 */
export function recordFailure(state: CodingState, failure: CodingFailure): void {
  state.failure = failure
  state.failureNotice = failure
  state.updatedAt = failure.at
}

/**
 * Read and clear the notice that rides the next step's contract. A failure is
 * reported to the user exactly once, so the same mechanism cannot flood the
 * conversation with a repeated card.
 * @param state - live session state (mutated).
 * @returns the failure to announce, once.
 */
export function takeFailureNotice(state: CodingState): CodingFailure | undefined {
  const failure = state.failureNotice
  state.failureNotice = undefined
  return failure
}

/**
 * Forget a failure once its subsystem works again. Only the matching point is
 * cleared, so recovering one subsystem cannot hide a different, still-current
 * interruption.
 * @param state - live session state (mutated).
 * @param point - the dispatch point whose retry just succeeded.
 */
export function clearFailure(state: CodingState, point: CodingFailure['point']): void {
  if (state.failure?.point === point) state.failure = undefined
  if (state.failureNotice?.point === point) state.failureNotice = undefined
}

/**
 * Switch mode. A stage the new mode does not open resets to that mode's entry
 * stage, so a mode switch can never leave the session in a stage its mode
 * forbids.
 * @param state - live session state (mutated).
 * @param mode - requested mode.
 * @returns the resulting stage.
 */
export function applyMode(state: CodingState, mode: CodingMode): CodingStage {
  state.mode = mode
  state.updatedAt = Date.now()
  state.refusal = undefined
  state.lastRefusal = undefined
  if (!stageInMode(mode, state.stage)) {
    const from = state.stage
    state.stage = entryStage(mode)
    state.transitions.push({
      from,
      to: state.stage,
      at: state.updatedAt,
      reason: `mode switched to ${mode}`,
    })
  }
  return state.stage
}

/** Guidance appended to a denial, chosen from the stage and the tool class. */
function remedy(stage: CodingStage, kind: string, mode: CodingMode): string {
  if (kind === 'write') {
    return stage === 'implement'
      ? 'File edits are delegated: call delegate_implement and let the implement-worker apply the patch.'
      : 'Implementation is delegated: advance to the implement stage with coding_stage, then call delegate_implement.'
  }
  if (kind === 'delegate') {
    return 'Delegation runs in its own stage: delegate_plan in plan, delegate_implement in implement; advance with coding_stage first.'
  }
  if (kind === 'plan') {
    return 'Author the task list in the plan stage with todo_write.'
  }
  if (kind === 'verify') {
    return 'Verification runs in the verify stage: advance with coding_stage, then call run_verification.'
  }
  if (kind === 'exec' && stage === 'deliver') {
    return 'Delivery reports the run; it does not execute commands. Run checks in the verify stage with run_verification.'
  }
  if (kind === 'read' && mode === 'consult') {
    return 'Consult mode answers from inspection only; keep reading, or advance to deliver.'
  }
  return `allowed tool classes here: ${stageInMode(mode, stage) ? stagePath(mode) : mode}.`
}

/**
 * The single policy decision shared by the friendly waterfall listener and the
 * monotonic guard. Both evaluate this function, so they can never disagree.
 * @param state - live session state of the calling agent.
 * @param toolName - tool being dispatched.
 * @returns a denial message, or an empty verdict when the call may proceed.
 */
export function checkTool(state: CodingState, toolName: string): ToolVerdict {
  const kind = toolClass(toolName)
  // Unknown tools belong to other plugins; this gate does not own their semantics.
  if (kind === undefined) return {}
  if (kind === 'stage' || kind === 'mode' || kind === 'reasoning') return {}
  if (stageAdmits(state.stage, kind)) return {}
  const reason =
    `dsh-coding: ${toolName} is not available in the ${state.stage} stage of ${state.mode} mode. `
    + `${remedy(state.stage, kind, state.mode)} `
    + `Current stages for this mode: ${stagePath(state.mode)}.`
  return { deny: reason }
}

/**
 * 某阶段对 lead 工具表的 allow-list。
 * requirements/plan 不裁剪（undefined=全表）；implement 用显式 IMPLEMENT_TABLE；
 * verify/deliver 由已知工具名 × 阶段准入类动态生成，绝不依赖“恢复全表”。
 * 类未知的第三方工具保留，避免误伤扩展；`delegate_implement` / `delegate_plan`
 * 属 delegate 类，而 verify/deliver 的准入类里没有 delegate，因此它们自然被排除，
 * 不需要（也不该）再加永不命中的按名字过滤。
 * @param stage - 当前阶段。
 * @param known - 本 agent scope 实际注册的工具名。
 * @returns 要应用的 allow-list；undefined 表示保持整表。
 */
export function stageToolTable(stage: CodingStage, known: readonly string[]): readonly string[] | undefined {
  if (stage === 'implement') return IMPLEMENT_TABLE
  if (stage !== 'verify' && stage !== 'deliver') return undefined
  return known.filter((name) => {
    const kind = toolClass(name)
    if (kind === undefined) return true
    return stageAdmits(stage, kind)
  })
}

/**
 * @deprecated 由 {@link stageToolTable} 取代：verify/deliver 不再表示“恢复全表”。
 * 保留这个兼容导出只为旧调用方与现有测试。
 * @param stage - 当前阶段。
 * @returns implement 阶段的显式表，其它阶段 undefined。
 */
export function tableTrim(stage: CodingStage): readonly string[] | undefined {
  return stage === 'implement' ? IMPLEMENT_TABLE : undefined
}

/**
 * The verification part of the status line: the last result, the attempt it
 * cost, and the blocked state once the retry budget is gone.
 */
function verificationStatus(state: CodingState): string {
  if (state.verifyBlocked !== undefined) return `BLOCKED after ${state.verifyBlocked.attempts} attempts`
  const outcome = state.verification
  if (outcome === undefined) return 'not run'
  if (outcome.passed) return `passed (${outcome.kind}/${outcome.scope}, ${outcome.durationMs}ms)`
  return `FAILED (${outcome.kind}/${outcome.scope}, exit ${String(outcome.exitCode)}, attempt ${state.verificationAttempts})`
}

/** Render the model-facing status line injected before every step. */
export function statusLine(state: CodingState): string {
  const plan = state.plan === undefined
    ? 'none'
    : `${state.plan.items.filter(item => item.status === 'completed').length}/${state.plan.items.length} done`
  const verification = verificationStatus(state)
  const handoff = `handoff goal=${goalRecorded(state) ? 'set' : 'missing'}, `
    + `acceptance=${state.handoff?.acceptance.length ?? 0}`
  const worker = state.worker === undefined ? undefined : `${state.worker.role}-worker ${state.worker.status}`
  const planner = state.planner === undefined ? undefined : `planner ${state.planner.outcome}`
  return [
    `stage ${state.stage} of ${stagePath(state.mode)}; mode ${state.mode}`,
    `plan ${plan}`,
    `verification ${verification}`,
    handoff,
    `files changed ${state.edits}`,
    ...state.stage === 'deliver' && state.deliveryBlocked ? ['delivery BLOCKED'] : [],
    ...state.failure === undefined ? [] : [`failure ${state.failure.point}`],
    ...worker === undefined ? [] : [worker],
    ...planner === undefined ? [] : [planner],
  ].join(' | ')
}

/** Build the whole-value checkpoint published with a Coding tool result. */
export function checkpointOf(state: CodingState): CodingCheckpoint {
  const items = state.plan?.items ?? []
  return {
    v: 1,
    runId: state.runId,
    turn: state.turn,
    step: state.step,
    mode: state.mode,
    stage: state.stage,
    allowedStages: STAGES_BY_MODE[state.mode],
    planItems: items.length,
    openPlanItems: items.filter(item => item.status !== 'completed').length,
    edits: state.edits,
    files: [...state.files].sort(),
    ...state.verification === undefined ? {} : { verification: state.verification },
    ...state.handoff === undefined ? {} : { handoff: state.handoff },
    verifyAttempts: state.verificationAttempts,
    ...state.verifyBlocked === undefined ? {} : { verifyBlocked: state.verifyBlocked },
    ...state.worker === undefined ? {} : { worker: state.worker },
    ...state.planner === undefined ? {} : { planner: state.planner },
    ...state.refusal === undefined ? {} : { refusal: state.refusal },
    ...state.failure === undefined ? {} : { failure: state.failure },
    updatedAt: state.updatedAt,
  }
}

/** Per-session state store keyed by the live Agent, with a session-id index. */
export class CodingStateStore {
  private readonly byAgent = new WeakMap<object, CodingState>()
  private readonly bySession = new Map<string, CodingState>()

  constructor(private readonly config: () => CodingConfig) {}

  /** Read an agent's state without creating one. */
  peek(agent: object | undefined): CodingState | undefined {
    if (agent === undefined) return undefined
    const existing = this.byAgent.get(agent)
    if (existing !== undefined) return existing
    const sessionId = sessionIdOf(agent)
    return sessionId === undefined ? undefined : this.bySession.get(sessionId)
  }

  /** Read the live state for a session id, for `session/event` folds. */
  bySessionId(sessionId: string): CodingState | undefined {
    return this.bySession.get(sessionId)
  }

  /** Read or create the state of one lead agent. */
  ensure(agent: object, sessionId: string): CodingState {
    const existing = this.byAgent.get(agent) ?? this.bySession.get(sessionId)
    if (existing !== undefined) {
      this.byAgent.set(agent, existing)
      return existing
    }
    const created = createState(sessionId, this.config().defaultMode)
    this.byAgent.set(agent, created)
    this.bySession.set(sessionId, created)
    return created
  }

  /** Forget one agent's state. The tool-table restriction is released by the preset, per agent. */
  release(agent: object, sessionId: string | undefined): void {
    this.byAgent.delete(agent)
    if (sessionId !== undefined) this.bySession.delete(sessionId)
  }
}

/** Read a session id from a live Agent without importing the runtime class. */
export function sessionIdOf(agent: object | undefined): string | undefined {
  if (agent === undefined) return undefined
  const value = (agent as { session?: { header?: { id?: unknown } } }).session?.header?.id
  return typeof value === 'string' ? value : undefined
}

/** Whether the agent is the lead of its own conversation (never a delegated child). */
export function isLeadAgent(agent: object | undefined): boolean {
  if (agent === undefined) return false
  const depth = (agent as { session?: { header?: { delegationDepth?: unknown } } }).session?.header?.delegationDepth
  return typeof depth !== 'number' || depth === 0
}
