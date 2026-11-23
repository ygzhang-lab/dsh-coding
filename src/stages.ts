/**
 * The enforced coding stages and the deterministic tool policy that belongs to
 * each one. This module is deliberately dependency-free: the Host preset, the
 * worker presets, and the Web client all import it, so it must never pull in a
 * Node-only or React-only module.
 *
 * @module dsh-coding/stages
 */

import { asFailure, type CodingFailure } from './failures.js'
import { asHandoff, type CodingHandoff } from './handoff.js'

/** Workflow mode selected for one Coding session. */
export type CodingMode = 'auto' | 'consult' | 'review' | 'codex'

/** One enforced phase of a Coding turn sequence. */
export type CodingStage = 'requirements' | 'plan' | 'implement' | 'verify' | 'deliver'

/** Every stage, in forward order. */
export const CODING_STAGES: readonly CodingStage[] = ['requirements', 'plan', 'implement', 'verify', 'deliver']

/** Every mode, in roster order. */
export const CODING_MODES: readonly CodingMode[] = ['auto', 'consult', 'review', 'codex']

/**
 * The stages a mode opens. A mode never gains a stage at runtime: the set is
 * fixed here and is the first thing `coding_stage` checks.
 */
export const STAGES_BY_MODE: Readonly<Record<CodingMode, readonly CodingStage[]>> = {
  // Auto opens only requirements because the requirements stage chooses a concrete workflow
  // with `coding_mode`; the chosen mode then supplies its own stage set.
  auto: ['requirements'],
  consult: ['requirements', 'plan', 'deliver'],
  review: ['requirements', 'verify', 'deliver'],
  codex: ['requirements', 'plan', 'implement', 'verify', 'deliver'],
}

/** Stage at which a session of this mode starts. */
export function entryStage(mode: CodingMode): CodingStage {
  return STAGES_BY_MODE[mode][0] as CodingStage
}

/** Whether `stage` belongs to `mode`. */
export function stageInMode(mode: CodingMode, stage: CodingStage): boolean {
  return STAGES_BY_MODE[mode].includes(stage)
}

/** Model-facing explanation of the mode's stage set, e.g. `requirements → plan → deliver`. */
export function stagePath(mode: CodingMode): string {
  return STAGES_BY_MODE[mode].join(' → ')
}

/** The workflow and control verbs this package registers by name. */
export const TOOL = {
  stage: 'coding_stage',
  mode: 'coding_mode',
  reasoning: 'coding_reasoning',
  handoff: 'coding_handoff',
  implement: 'delegate_implement',
  verify: 'delegate_verify',
  plan: 'delegate_plan',
  verification: 'run_verification',
} as const

/** Every tool name this package owns; the Web Definition matches on exactly these. */
export const CODING_TOOLS: readonly string[] = Object.values(TOOL)

/** Whether a model-facing tool name belongs to this package. */
export function isCodingTool(name: string): boolean {
  return (CODING_TOOLS as readonly string[]).includes(name)
}

/**
 * How the gate reads one tool. `read` and `exec` are non-mutating observation,
 * `write` mutates a file, `plan` owns the structured task list, `verify` runs a
 * check, `delegate` hands implementation to a worker, and `stage`/`mode`/
 * `reasoning` are the control verbs this plugin owns.
 */
export type ToolClass = 'read' | 'exec' | 'write' | 'plan' | 'verify' | 'delegate' | 'stage' | 'mode' | 'reasoning'

const TOOL_CLASSES: Readonly<Record<string, ToolClass>> = {
  read: 'read',
  read_image: 'read',
  glob: 'read',
  grep: 'read',
  web_search: 'read',
  web_fetch: 'read',
  job_output: 'read',
  job_list: 'read',
  skill: 'read',
  list_agents: 'read',
  list_subagent_models: 'read',
  todo_write: 'plan',
  write: 'write',
  edit: 'write',
  apply_patch: 'write',
  bash: 'exec',
  pwsh: 'exec',
  job_kill: 'exec',
  terminal_open: 'exec',
  terminal_read: 'exec',
  terminal_signal: 'exec',
  run_verification: 'verify',
  delegate_verify: 'verify',
  delegate_implement: 'delegate',
  delegate_plan: 'delegate',
  coding_stage: 'stage',
  coding_mode: 'mode',
  coding_reasoning: 'reasoning',
  coding_handoff: 'stage',
}

/**
 * Classify a tool. Unknown (third-party) tools stay `undefined`: the gate owns
 * the coding toolset it can reason about and never silently blocks an
 * extension whose semantics it does not know.
 */
export function toolClass(name: string): ToolClass | undefined {
  return TOOL_CLASSES[name]
}

/** Classes each stage admits for the lead agent. */
const STAGE_CLASSES: Readonly<Record<CodingStage, readonly ToolClass[]>> = {
  // Requirements is observation: no file mutation, no plan authoring, no verification.
  requirements: ['read', 'exec', 'stage', 'mode', 'reasoning'],
  // Planning may inspect and must author the structured task list.
  plan: ['read', 'exec', 'plan', 'delegate', 'stage', 'mode', 'reasoning'],
  // Implementation is delegated: the lead keeps the task list, the shell it needs
  // for installs and one-off commands, and the verbs. Editing stays the worker's.
  implement: ['delegate', 'plan', 'exec', 'stage', 'mode', 'reasoning'],
  // Verification is read + a structured check, plus ad-hoc commands to reproduce a
  // failure; delegation stays available and the task list must be closable.
  verify: ['read', 'verify', 'exec', 'plan', 'stage', 'mode', 'reasoning'],
  // Delivery reports and closes the task list; nothing may mutate source, run a
  // command, or start a fresh verification.
  deliver: ['read', 'plan', 'stage', 'mode', 'reasoning'],
}

/** Whether `stage` admits the tool class `kind`. */
export function stageAdmits(stage: CodingStage, kind: ToolClass): boolean {
  return STAGE_CLASSES[stage].includes(kind)
}

/** Human-readable list of the classes a stage admits, for a denial message. */
export function stageAdmissions(stage: CodingStage): string {
  return STAGE_CLASSES[stage].join(', ')
}

/**
 * The lead's tool table during `implement`: exactly these names remain visible.
 * Naming the allow-list (rather than denying individual tools) is what makes the
 * trim total, including tools a later plugin registers.
 * `bash` and `pwsh` are both listed because only one exists per platform;
 * `syncTable` drops the absent one, since `tools.restrict` rejects names the
 * scope does not register.
 */
export const IMPLEMENT_TABLE: readonly string[] = [
  TOOL.implement,
  TOOL.handoff,
  'todo_write',
  'bash',
  'pwsh',
  TOOL.stage,
  TOOL.mode,
  TOOL.reasoning,
]

/** The worker presets this package declares and dispatches to. */
export const WORKER_PRESETS = {
  planner: 'dsh-coding-planner',
  implement: 'dsh-coding-implement',
  verify: 'dsh-coding-verify',
  verifyWithInstructions: 'dsh-coding-verify-instructions',
} as const

/** 触发 verify 注入仓库指令的最小子任务数：多个子任务意味着跨任务依赖。 */
export const VERIFY_INSTRUCTION_TASK_THRESHOLD = 2
/** 触发 verify 注入仓库指令的最小改动文件数：改动面大时需要仓库规则。 */
export const VERIFY_INSTRUCTION_FILE_THRESHOLD = 3

/** 决定 verify worker 是否加载仓库指令的输入。 */
export interface WorkspaceInstructionDemand {
  readonly mode: CodingMode
  readonly taskCount: number
  readonly changedFiles: number
}

/**
 * verify 是否应加载仓库指令：仅 codex 模式，且（多子任务）或（改动文件多）。
 * 单任务单文件的核查不注入，避免为一次检查付出整份 AGENTS.md 的上下文。
 */
export function needsWorkspaceInstructions(demand: WorkspaceInstructionDemand): boolean {
  if (demand.mode !== 'codex') return false
  return demand.taskCount >= VERIFY_INSTRUCTION_TASK_THRESHOLD
    || demand.changedFiles >= VERIFY_INSTRUCTION_FILE_THRESHOLD
}

/** The stable route identity a session's coding run is checkpointed under. */
export const CHECKPOINT_VERSION = 1

/** One stage transition recorded by the state machine. */
export interface StageTransition {
  readonly from: CodingStage
  readonly to: CodingStage
  readonly at: number
  readonly reason: string
}

/** A verification outcome, reduced to what a gate and the UI need. */
export interface VerificationOutcome {
  readonly passed: boolean
  readonly kind: 'test' | 'build' | 'lint' | 'typecheck'
  readonly scope: 'targeted' | 'package' | 'full'
  /** `lead` ran it directly; `worker` came back through `delegate_verify`. */
  readonly source: 'lead' | 'worker'
  readonly command: string
  readonly exitCode: number | null
  readonly durationMs: number
  readonly failedTests: readonly string[]
  readonly errors: readonly string[]
  readonly ranAt: number
}

/** A worker delegation the lead has started or finished. */
export interface WorkerRecord {
  readonly role: 'plan' | 'implement' | 'verify'
  readonly status: 'running' | 'completed' | 'failed'
  readonly childId?: string
  readonly summary?: string
  readonly files?: readonly string[]
  readonly startedAt: number
  readonly finishedAt?: number
}

/** 一次 planner 派发尝试：失败也算尝试，避免 worker 路由不可用时把 codex 流程锁死。 */
export interface PlannerAttempt {
  /** 本次尝试使用的配置路由 `provider/model`。 */
  readonly route: string
  /** 只有 worker 完成并回报 ok 才是 `completed`；失败的尝试同样打开门禁。 */
  readonly outcome: 'completed' | 'failed'
  readonly at: number
}

/**
 * Whole-value checkpoint emitted with every Coding tool result. The Web
 * projection stores exactly this shape, so a history page that starts in the
 * middle of a run can still render the current stage: the newest checkpoint
 * carries the complete state and never depends on an earlier event.
 */
export interface CodingCheckpoint {
  readonly v: typeof CHECKPOINT_VERSION
  /** Stable identity of the session's coding run. */
  readonly runId: string
  readonly turn: number
  readonly step: number
  readonly mode: CodingMode
  readonly stage: CodingStage
  readonly allowedStages: readonly CodingStage[]
  readonly planItems: number
  readonly openPlanItems: number
  readonly edits: number
  /**
   * Distinct paths the implement workers reported, sorted. Absent on
   * checkpoints written before this field existed; `edits` stays the count.
   */
  readonly files?: readonly string[]
  readonly verification?: VerificationOutcome
  /** Bounded handoff record the stages pass forward; absent on checkpoints written before it existed. */
  readonly handoff?: CodingHandoff
  /** Failed verifications this session spent against the retry budget. */
  readonly verifyAttempts?: number
  /** Set once the retry budget is exhausted: the run must deliver blocked, not retry. */
  readonly verifyBlocked?: { readonly attempts: number; readonly reason: string; readonly at: number }
  readonly worker?: WorkerRecord
  /** planner 派发尝试；旧 checkpoint 没有该字段，读取时视为“未尝试”。 */
  readonly planner?: PlannerAttempt
  readonly refusal?: { readonly target: CodingStage; readonly reason: string; readonly at: number }
  /** The most recent blocking exception; absent on checkpoints written before it existed. */
  readonly failure?: CodingFailure
  readonly updatedAt: number
}

/**
 * Validate one untyped value as a {@link CodingCheckpoint}. The client reads
 * checkpoints out of `tool/result.meta`, which is durable JSON written by an
 * arbitrary earlier build of this plugin, so every field is re-checked here.
 */
export function asCheckpoint(value: unknown): CodingCheckpoint | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  if (v['v'] !== CHECKPOINT_VERSION) return undefined
  if (typeof v['runId'] !== 'string' || v['runId'] === '') return undefined
  if (!isFiniteNumber(v['turn']) || !isFiniteNumber(v['step'])) return undefined
  if (!isMode(v['mode'])) return undefined
  const stage = asStage(v['stage'])
  if (stage === undefined) return undefined
  const allowedStages = Array.isArray(v['allowedStages'])
    ? v['allowedStages'].map(asStage)
    : undefined
  if (allowedStages === undefined || allowedStages.some(item => item === undefined)) return undefined
  if (!isFiniteNumber(v['planItems']) || !isFiniteNumber(v['openPlanItems'])) return undefined
  if (!isFiniteNumber(v['edits']) || !isFiniteNumber(v['updatedAt'])) return undefined
  const files = v['files']
  if (files !== undefined && (!Array.isArray(files) || !files.every(item => typeof item === 'string' && item !== ''))) return undefined
  const verification = asVerification(v['verification'])
  const worker = asWorker(v['worker'])
  const refusal = asRefusal(v['refusal'])
  // A handoff that is missing, stale, or malformed reads as "no handoff": a
  // history page must not lose the whole card to junk from an earlier build.
  const handoff = asHandoff(v['handoff'])
  // A failure that is missing or malformed reads as "no failure", by the same
  // tolerance: one junk field must not drop the whole card.
  const failure = asFailure(v['failure'])
  // The retry counters are newer fields, so absent means an older checkpoint;
  // a present value that does not validate is a corrupt checkpoint.
  const attemptsValue = v['verifyAttempts']
  const verifyAttempts = isFiniteNumber(attemptsValue) && attemptsValue >= 0 ? attemptsValue : undefined
  if (attemptsValue !== undefined && verifyAttempts === undefined) return undefined
  const blockedValue = v['verifyBlocked']
  const verifyBlocked = asVerifyBlocked(blockedValue)
  if (blockedValue !== undefined && verifyBlocked === undefined) return undefined
  const plannerValue = v['planner']
  const planner = asPlanner(plannerValue)
  if (plannerValue !== undefined && planner === undefined) return undefined
  return {
    v: CHECKPOINT_VERSION,
    runId: v['runId'],
    turn: v['turn'],
    step: v['step'],
    mode: v['mode'],
    stage,
    allowedStages: allowedStages as readonly CodingStage[],
    planItems: v['planItems'],
    openPlanItems: v['openPlanItems'],
    edits: v['edits'],
    ...files === undefined ? {} : { files: files as readonly string[] },
    ...verification === undefined ? {} : { verification },
    ...handoff === undefined ? {} : { handoff },
    ...verifyAttempts === undefined ? {} : { verifyAttempts },
    ...verifyBlocked === undefined ? {} : { verifyBlocked },
    ...worker === undefined ? {} : { worker },
    ...planner === undefined ? {} : { planner },
    ...refusal === undefined ? {} : { refusal },
    ...failure === undefined ? {} : { failure },
    updatedAt: v['updatedAt'],
  }
}

/** Stage ids persisted by earlier builds, read back as their renamed current value. */
const LEGACY_STAGES: Readonly<Record<string, CodingStage>> = { recon: 'requirements' }

/**
 * Read one stage value, accepting the ids an earlier build persisted. The
 * durable projection and checkpoints store stages as strings, so a rename must
 * keep old sessions readable.
 * @param value - raw persisted value.
 * @returns the current stage id, mapping legacy ids, or undefined when unknown.
 */
export function asStage(value: unknown): CodingStage | undefined {
  if (typeof value !== 'string') return undefined
  if ((CODING_STAGES as readonly string[]).includes(value)) return value as CodingStage
  return LEGACY_STAGES[value]
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isMode(value: unknown): value is CodingMode {
  return typeof value === 'string' && (CODING_MODES as readonly string[]).includes(value)
}

function isStage(value: unknown): value is CodingStage {
  return asStage(value) !== undefined
}

function asVerification(value: unknown): VerificationOutcome | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  if (typeof v['passed'] !== 'boolean') return undefined
  if (typeof v['kind'] !== 'string' || typeof v['scope'] !== 'string') return undefined
  if (v['source'] !== 'lead' && v['source'] !== 'worker') return undefined
  if (typeof v['command'] !== 'string' || typeof v['durationMs'] !== 'number') return undefined
  if (!isFiniteNumber(v['ranAt'])) return undefined
  const exitCode = v['exitCode']
  if (exitCode !== null && typeof exitCode !== 'number') return undefined
  return {
    passed: v['passed'],
    kind: v['kind'] as VerificationOutcome['kind'],
    scope: v['scope'] as VerificationOutcome['scope'],
    source: v['source'],
    command: v['command'],
    exitCode,
    durationMs: v['durationMs'],
    failedTests: stringArray(v['failedTests']),
    errors: stringArray(v['errors']),
    ranAt: v['ranAt'],
  }
}

function asWorker(value: unknown): WorkerRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  if (v['role'] !== 'plan' && v['role'] !== 'implement' && v['role'] !== 'verify') return undefined
  if (v['status'] !== 'running' && v['status'] !== 'completed' && v['status'] !== 'failed') return undefined
  if (!isFiniteNumber(v['startedAt'])) return undefined
  return {
    role: v['role'],
    status: v['status'],
    ...typeof v['childId'] === 'string' ? { childId: v['childId'] } : {},
    ...typeof v['summary'] === 'string' ? { summary: v['summary'] } : {},
    ...Array.isArray(v['files']) ? { files: stringArray(v['files']) } : {},
    startedAt: v['startedAt'],
    ...isFiniteNumber(v['finishedAt']) ? { finishedAt: v['finishedAt'] } : {},
  }
}

function asPlanner(value: unknown): PlannerAttempt | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  if (typeof v['route'] !== 'string' || v['route'] === '') return undefined
  if (v['outcome'] !== 'completed' && v['outcome'] !== 'failed') return undefined
  if (!isFiniteNumber(v['at'])) return undefined
  return { route: v['route'], outcome: v['outcome'], at: v['at'] }
}

function asRefusal(value: unknown): { target: CodingStage; reason: string; at: number } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  const target = asStage(v['target'])
  if (target === undefined || typeof v['reason'] !== 'string' || !isFiniteNumber(v['at'])) return undefined
  return { target, reason: v['reason'], at: v['at'] }
}

function asVerifyBlocked(value: unknown): { attempts: number; reason: string; at: number } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  if (!isFiniteNumber(v['attempts']) || typeof v['reason'] !== 'string' || !isFiniteNumber(v['at'])) return undefined
  return { attempts: v['attempts'], reason: v['reason'], at: v['at'] }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}
