/**
 * Structured failure reports: the reason a blocking step could not finish, and
 * what the operator can do about it.
 *
 * The runtime catches its own blocking exceptions at a small, fixed set of
 * dispatch points. Catching them silently would leave the user watching a card
 * that stopped moving, so each one becomes a {@link CodingFailure} that travels
 * with the checkpoint and reaches the next step as a one-shot notice. The note
 * never becomes a Turn and never adds a Session event: it rides the message
 * channel the Host already injects into.
 *
 * This module is pure and browser safe: no I/O, no dependencies, and no clock
 * other than the timestamp default, so the Host preset, the worker presets, and
 * the Web client can all import it.
 *
 * @module dsh-coding/failures
 */

import type { PromptLanguage } from './language.js'

/** Longest reason or action kept in a report. */
const FAILURE_TEXT_LIMIT = 600

/** The dispatch points whose blocking exceptions are reported. */
export type FailurePoint =
  | 'projection'
  | 'restore'
  | 'tool-table'
  | 'reasoning'
  | 'delegate'
  | 'verification'
  | 'handoff'
  | 'command'
  | 'stage'

/** Every failure point, in report order. */
export const FAILURE_POINTS: readonly FailurePoint[] = [
  'projection',
  'restore',
  'tool-table',
  'reasoning',
  'delegate',
  'verification',
  'handoff',
  'command',
  'stage',
]

/** One blocking exception, reduced to what a notice and a status line need. */
export interface CodingFailure {
  /** Which dispatch point threw. */
  readonly point: FailurePoint
  /** The exception message, trimmed and bounded. */
  readonly reason: string
  /** What the operator can do about it, in the conversation language. */
  readonly action: string
  readonly at: number
}

/** Human-readable name of each point, for the notice heading. */
const FAILURE_LABEL: Readonly<Record<FailurePoint, { readonly zh: string; readonly en: string }>> = {
  projection: { zh: '会话投影', en: 'Session projection' },
  restore: { zh: '会话恢复', en: 'Session restore' },
  'tool-table': { zh: '工具表裁剪', en: 'Tool table' },
  reasoning: { zh: '推理等级', en: 'Reasoning level' },
  delegate: { zh: '子代理派发', en: 'Worker dispatch' },
  verification: { zh: '验证执行', en: 'Verification' },
  handoff: { zh: '交接记录', en: 'Handoff' },
  command: { zh: '控制命令', en: 'Command' },
  stage: { zh: '阶段推进', en: 'Stage advance' },
}

/** The concrete next move for each point, so a notice never only reports. */
const FAILURE_ACTION: Readonly<Record<FailurePoint, { readonly zh: string; readonly en: string }>> = {
  projection: {
    zh: '会话仍可继续，但卡片和阶段胶囊可能缺失。确认 sessionProjections 服务可用后重启 DSH。',
    en: 'The session can continue, but the card and stage capsule may be missing. Confirm the sessionProjections service is available, then restart DSH.',
  },
  restore: {
    zh: '会话可能从 requirements 重新开始，已记录的阶段和任务单可能丢失。确认投影插件可用后重启 DSH；仍失败请新建会话并重新描述需求。',
    en: 'The session may restart at requirements and lose its recorded stage or task list. Confirm the projection plugin is available and restart DSH; if it still fails, start a new session and restate the request.',
  },
  'tool-table': {
    zh: '阶段工具表无法裁剪，编辑工具仍会被门禁拒绝。确认 delegate_implement 已注册并重启 DSH；必要时用 /coding stage 控制阶段。',
    en: 'The stage tool table could not be trimmed; edits are still denied by the gate. Confirm delegate_implement is registered and restart DSH; use /coding stage to control the stage if needed.',
  },
  reasoning: {
    zh: '本轮沿用当前推理等级。检查模型是否支持 reasoning effort，或在插件配置中把 reasoning 设为 auto。',
    en: 'This turn keeps the current reasoning level. Check that the model supports reasoning effort, or set reasoning to auto in the plugin configuration.',
  },
  delegate: {
    zh: '按错误中的字段检查 worker 模型路由和 provider，修好后重试同一派发。worker 不会回退主代理模型；必要时在插件页更换模型。',
    en: 'Check the worker model route and provider named in the error, fix them, then retry the same dispatch. A worker never falls back to the lead model; change the model on the plugin page if needed.',
  },
  verification: {
    zh: '检查 verificationCommands 与 verificationTimeoutMs，也可手动运行命令定位。启动失败或超时会计入验证预算。',
    en: 'Check verificationCommands and verificationTimeoutMs, or run the command manually to diagnose. A start failure or timeout counts against the verification budget.',
  },
  handoff: {
    zh: '重试 coding_handoff；仍失败用 /coding 查看状态，必要时新建会话。',
    en: 'Retry coding_handoff; if it still fails, inspect /coding and start a new session if needed.',
  },
  command: {
    zh: '按错误信息处理；命令持续失败时重启 DSH 后重试。',
    en: 'Follow the error message; if the command keeps failing, restart DSH and retry.',
  },
  stage: {
    zh: '本轮已中断。按上面的原因补齐推进条件（todo_write 任务单、coding_handoff 的 goal/acceptance、run_verification 通过），或用 /coding stage <name> 手动设置阶段后重试。',
    en: 'This turn was interrupted. Satisfy the condition named above (a todo_write task list, coding_handoff goal/acceptance, a passing run_verification), or set the stage with /coding stage <name> and retry.',
  },
}

/**
 * Build a report for one blocking exception.
 * @param point - dispatch point that threw.
 * @param error - the caught value, usually an `Error`.
 * @param language - conversation language of the session.
 * @param at - timestamp to stamp, defaults to now.
 * @returns the report; its action is drawn from {@link FAILURE_ACTION}.
 */
export function makeFailure(
  point: FailurePoint,
  error: unknown,
  language: PromptLanguage,
  at?: number,
): CodingFailure {
  const reason = (error instanceof Error ? error.message : String(error)).trim().slice(0, FAILURE_TEXT_LIMIT)
  return {
    point,
    reason: reason === '' ? 'unknown error' : reason,
    action: FAILURE_ACTION[point][language],
    at: at ?? Date.now(),
  }
}

/**
 * Validate one untyped value as a {@link CodingFailure}. The report is persisted
 * in checkpoints and restored from durable JSON written by an arbitrary earlier
 * build, so every field is re-checked here rather than trusted.
 * @param value - decoded JSON or any other untyped value.
 * @returns the normalized report, or undefined when it is not one.
 */
export function asFailure(value: unknown): CodingFailure | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const point = raw['point']
  if (typeof point !== 'string' || !(FAILURE_POINTS as readonly string[]).includes(point)) return undefined
  const reason = raw['reason']
  const action = raw['action']
  const at = raw['at']
  if (typeof reason !== 'string' || typeof action !== 'string') return undefined
  if (typeof at !== 'number' || !Number.isFinite(at)) return undefined
  return {
    point: point as FailurePoint,
    reason: reason.trim().slice(0, FAILURE_TEXT_LIMIT),
    action: action.trim().slice(0, FAILURE_TEXT_LIMIT),
    at,
  }
}

/**
 * Render the user-facing notice for one report: what broke and what to do.
 * @param failure - the report to render.
 * @param language - conversation language of the session.
 * @returns the notice as a short Markdown block.
 */
export function failureNotice(failure: CodingFailure, language: PromptLanguage): string {
  const label = FAILURE_LABEL[failure.point][language]
  if (language === 'zh') {
    return [`## dsh-coding 运行中断（${label}）`, `原因：${failure.reason}`, `处理：${failure.action}`].join('\n')
  }
  return [`## dsh-coding runtime failure (${label})`, `Reason: ${failure.reason}`, `What to do: ${failure.action}`].join('\n')
}

/**
 * Render the one-fragment form used by the status line.
 * @param failure - the report to render.
 * @returns `failure <point>`.
 */
export function failureStatus(failure: CodingFailure): string {
  return `failure ${failure.point}`
}
