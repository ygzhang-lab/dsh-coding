/**
 * 任务交接文档：把一轮 Coding 结束时的有界状态写成一篇 Markdown，落到
 * `<会话 cwd>/.agents/memory/<sessionId>-<YYYYMMDD-HHmmss>.md`。
 *
 * 文档只由状态机与 coding_handoff 记录（{@link CodingHandoff}）拼出，不回读对话正文，
 * 也不新增 Session 事件：它是本轮状态机与交接记录的存档快照，下一轮继续时仍以
 * coding_handoff 的实时记录为准。拼装部分是纯函数（{@link composeMemoryDocument}），
 * 便于单测；写盘只走注入的 fs 服务（`resolve` + `writeText`），从不使用 `node:fs`。
 *
 * 本模块只在 Host 侧使用（依赖 `node:path`），客户端不导入它。
 *
 * @module dsh-coding/memory
 */
import { join } from 'node:path'
import type { CodingHandoff, HandoffChange, HandoffTask } from './handoff.js'
import type { CodingState, PlanItem } from './state.js'
import type { VerificationOutcome } from './stages.js'

/** 文档最大字符数；超出后截断到最后一个完整行。 */
export const MEMORY_LIMIT = 20000

/** 交接文档在项目根下的目录。 */
export const MEMORY_DIR = join('.agents', 'memory')

/** 文件名里保留的 sessionId 字符；其余一律替换成 `-`。 */
const SAFE_ID = /[^A-Za-z0-9._-]/gu

/** 交接文档的输入：只取状态机与 handoff 的有界数据，不含 I/O 与对话正文。 */
export interface MemoryInput {
  readonly sessionId: string
  readonly cwd?: string
  readonly mode: string
  readonly stage: string
  readonly turn: number
  readonly blocked: boolean
  readonly handoff?: CodingHandoff
  readonly plan: readonly PlanItem[]
  readonly verification?: VerificationOutcome
  readonly files: readonly string[]
  readonly transitions: readonly { readonly from: string; readonly to: string; readonly at: number; readonly reason: string }[]
  readonly now: number
}

/** 写盘结果：成功给出文件名与展示路径；失败给出原因与处理办法，从不抛错。 */
export type MemoryWriteResult =
  | { readonly ok: true; readonly name: string; readonly displayPath: string }
  | { readonly ok: false; readonly reason: string; readonly action: string }

/** 注入的 fs 服务目标：本模块只需要展示路径。 */
interface MemoryTarget {
  readonly displayPath?: string
}

/** 注入的 fs 服务：本模块只调用 `resolve` 与 `writeText`。 */
interface MemoryFileSystem {
  resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<MemoryTarget>
  writeText(
    target: MemoryTarget,
    content: string,
    expected?: { kind: 'createIfAbsent' },
    signal?: AbortSignal,
    policy?: unknown,
  ): Promise<unknown>
}

/**
 * 生成一篇交接文档的文件名：`<清洗后的 sessionId>-<YYYYMMDD-HHmmss>.md`。
 *
 * sessionId 只保留 `[A-Za-z0-9._-]`，其余字符换成 `-`，清洗后为空则退回 `session`；
 * 时间戳取 UTC，非法 `at` 按 epoch 处理而不抛错。
 * @param sessionId - 会话 id。
 * @param at - 时间戳（毫秒）。
 * @returns 文件名，不含目录。
 */
export function memoryFileName(sessionId: string, at: number): string {
  const cleaned = sessionId.replace(SAFE_ID, '-')
  const stem = cleaned === '' ? 'session' : cleaned
  return `${stem}-${utcStamp(at)}.md`
}

/**
 * 组装整篇交接文档。
 *
 * 纯字符串拼接：不读文件、不取时钟（时间来自 {@link MemoryInput.now}），因此可以直接单测。
 * 空数组与缺失字段对应的整节省略，不输出「无」。
 * @param input - 状态机与 handoff 的有界快照。
 * @returns 文档正文，超过 {@link MEMORY_LIMIT} 时截断并标注。
 */
export function composeMemoryDocument(input: MemoryInput): string {
  const handoff = input.handoff
  const cwd = textOf(input.cwd)
  const lines: string[] = [
    '# Coding 任务交接文档',
    '',
    `- 会话: ${input.sessionId}`,
    `- 生成时间: ${isoStamp(input.now)}（UTC）`,
    `- 工作目录: ${cwd === '' ? '(unknown)' : cwd}`,
    `- 模式 / 阶段: ${input.mode} / ${input.stage}`,
    `- 轮次: turn ${input.turn}`,
    `- 状态: ${input.blocked ? '阻塞交付（BLOCKED）' : '正常交付'}`,
  ]

  pushText(lines, '目标', handoff?.goal)
  pushList(lines, '约束', handoff?.constraints ?? [])
  pushList(lines, '验收标准', handoff?.acceptance ?? [])
  pushText(lines, '交付记录', handoff?.delivered)
  pushList(lines, '后续跟进', handoff?.followUps ?? [])
  pushList(lines, '决策', handoff?.decisions ?? [])
  pushList(lines, '发现', handoff?.findings ?? [])
  pushList(lines, '待答问题', handoff?.open ?? [])
  pushPlan(lines, input.plan)
  pushTasks(lines, handoff?.tasks ?? [])
  pushChanges(lines, handoff?.changes ?? [])
  pushUnlisted(lines, input.files, handoff?.changes ?? [])
  pushVerification(lines, input.verification)
  pushTransitions(lines, input.transitions)
  pushNextRound(lines)

  return truncateDocument(lines.join('\n'))
}

/**
 * 写出本轮的任务交接文档，返回一条可回报给用户的收据。
 *
 * 写盘只走注入的 fs 服务：`resolve` 解析 `.agents/memory` 下的目标，`writeText` 以
 * `createIfAbsent` 语义写入，因此重复点击生成新文件而不覆盖旧文档；目录缺失由 Host 的
 * 原子写入自动创建。任何一步抛错都收成 `{ ok:false, … }` 收据，绝不外泄异常。
 * @param ctx - 插件作用域。
 * @param agent - 触发写入的 lead agent（`agent.ctx` 的作用域优先级更高）。
 * @param state - 本轮结束时的状态机快照。
 * @param options - 取消信号。
 * @returns 成功时给出文件名与展示路径，失败时给出原因与处理办法。
 */
export async function writeMemoryDocument(
  ctx: any,
  agent: any,
  state: CodingState,
  options?: { signal?: AbortSignal },
): Promise<MemoryWriteResult> {
  const signal = options?.signal
  try {
    const fs: MemoryFileSystem | undefined = serviceOf(agent?.ctx, ctx, 'fs')
    if (fs === undefined) {
      return {
        ok: false,
        reason: 'this Host does not expose the fs service',
        action:
          'keep the Coding preset mounted in a DSH host that provides the filesystem service, '
          + 'then retry /coding memory',
      }
    }

    const cwd = agent?.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') {
      return {
        ok: false,
        reason: 'the session has no working directory',
        action: 'set a working directory for this session, then retry /coding memory',
      }
    }

    const policy = await sandboxPolicyOf(agent?.ctx, ctx, agent)
    const now = Date.now()
    const name = memoryFileName(state.sessionId, now)
    const display = join(MEMORY_DIR, name)
    const target = await fs.resolve(display, { cwd, signal })

    await fs.writeText(
      target,
      composeMemoryDocument({
        sessionId: state.sessionId,
        cwd,
        mode: state.mode,
        stage: state.stage,
        turn: state.turn,
        blocked: state.deliveryBlocked === true,
        ...(state.handoff === undefined ? {} : { handoff: state.handoff }),
        plan: state.plan?.items ?? [],
        ...(state.verification === undefined ? {} : { verification: state.verification }),
        files: [...state.files].sort(),
        transitions: state.transitions,
        now,
      }),
      { kind: 'createIfAbsent' },
      signal,
      policy,
    )

    const shown = target?.displayPath
    return {
      ok: true,
      name,
      displayPath: typeof shown === 'string' && shown !== '' ? shown : display,
    }
  } catch (error) {
    const raw = (error instanceof Error ? error.message : String(error)).trim()
    return {
      ok: false,
      reason: (raw === '' ? 'unknown error' : raw).slice(0, 600),
      action: 'fix the reported filesystem problem, then retry /coding memory',
    }
  }
}

/**
 * 依次在 agent 作用域与插件作用域里找一个宿主服务。
 * agent 作用域在上：预设子作用域看到的服务比插件作用域更全。
 * @param primary - 优先作用域（通常是 `agent?.ctx`）。
 * @param fallback - 兜底作用域（插件 ctx）。
 * @param name - 服务名。
 * @returns 找到的服务，或 undefined。
 */
function serviceOf(primary: any, fallback: any, name: string): any {
  for (const scope of [primary, fallback]) {
    if (scope === undefined || scope === null) continue
    try {
      const service = scope.get?.(name) ?? scope[name]
      if (service !== undefined) return service
    } catch {
      // 这个作用域读不到，换下一个。
    }
  }
  return undefined
}

/**
 * 解析沙箱策略。沙箱是可选服务：没有它的宿主照常写盘，解析失败一律当作「没有策略」。
 * @param primary - 优先作用域（通常是 `agent?.ctx`）。
 * @param fallback - 兜底作用域（插件 ctx）。
 * @param agent - 触发写入的 lead agent。
 * @returns 策略值，或 undefined。
 */
async function sandboxPolicyOf(primary: any, fallback: any, agent: any): Promise<unknown> {
  const service = serviceOf(primary, fallback, 'sandboxPolicy')
  if (typeof service?.resolve !== 'function') return undefined
  try {
    return await service.resolve(agent === undefined ? {} : { session: agent.session })
  } catch {
    return undefined
  }
}

/** UTC 时间戳，格式 `YYYYMMDD-HHmmss`；非法数值按 epoch 处理。 */
function utcStamp(at: number): string {
  const iso = new Date(Number.isFinite(at) ? at : 0).toISOString()
  return `${iso.slice(0, 10).replace(/-/gu, '')}-${iso.slice(11, 19).replace(/:/gu, '')}`
}

/** 头部时间戳，ISO 8601（UTC）；非法数值按 epoch 处理。 */
function isoStamp(at: number): string {
  return new Date(Number.isFinite(at) ? at : 0).toISOString()
}

/** 把一个值修剪成单段文本；非字符串与空白读作空串。 */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 一组列表项：修剪、去空、去重（保序）。 */
function cleanItems(values: readonly unknown[]): string[] {
  const items: string[] = []
  for (const value of values) {
    const item = textOf(value)
    if (item !== '' && !items.includes(item)) items.push(item)
  }
  return items
}

/** 任务清单的状态标记：`[x]` 已完成、`[~]` 进行中、`[ ]` 待办。 */
function markOf(status: PlanItem['status']): string {
  if (status === 'completed') return '[x]'
  if (status === 'in_progress') return '[~]'
  return '[ ]'
}

/** 追加一个多行文本章节；空内容整节省略，不写「无」。 */
function pushText(lines: string[], title: string, body: string | undefined): void {
  const value = textOf(body)
  if (value === '') return
  lines.push('', `## ${title}`, value)
}

/** 追加一个列表章节；空列表整节省略。 */
function pushList(lines: string[], title: string, values: readonly unknown[]): void {
  const items = cleanItems(values)
  if (items.length === 0) return
  lines.push('', `## ${title}`, ...items.map(item => `- ${item}`))
}

/** 追加任务清单（来自 `todo_write` 的 plan 快照）。 */
function pushPlan(lines: string[], plan: readonly PlanItem[]): void {
  const rows: string[] = []
  for (const item of plan) {
    const content = textOf(item.content)
    if (content === '') continue
    rows.push(`- ${markOf(item.status)} ${content}`)
  }
  if (rows.length === 0) return
  lines.push('', '## 任务清单', ...rows)
}

/** 追加 planner 交接任务：目标、涉及文件、验收标准与避让说明。 */
function pushTasks(lines: string[], tasks: readonly HandoffTask[]): void {
  const rows: string[] = []
  for (const task of tasks) {
    const goal = textOf(task.goal)
    if (goal === '') continue
    const files = cleanItems(task.files)
    const done = textOf(task.acceptance)
    const avoid = textOf(task.avoid)
    rows.push(
      `- ${goal} — files: ${files.length === 0 ? '(none)' : files.join(', ')}`
      + `；done: ${done === '' ? '(none)' : done}`
      + (avoid === '' ? '' : `；avoid: ${avoid}`),
    )
  }
  if (rows.length === 0) return
  lines.push('', '## 交接任务（planner）', ...rows)
}

/** 追加改动文件：每条 `- <path> — <summary>`，空摘要只留路径。 */
function pushChanges(lines: string[], changes: readonly HandoffChange[]): void {
  const rows: string[] = []
  for (const change of changes) {
    const file = textOf(change.file)
    if (file === '') continue
    const summary = textOf(change.summary)
    rows.push(summary === '' ? `- ${file}` : `- ${file} — ${summary}`)
  }
  if (rows.length === 0) return
  lines.push('', '## 改动文件', ...rows)
}

/** 追加未并表路径：implement worker 报过的文件里，handoff 的 changes 没覆盖到的部分。 */
function pushUnlisted(
  lines: string[],
  files: readonly string[],
  changes: readonly HandoffChange[],
): void {
  const listed = new Set<string>()
  for (const change of changes) {
    const file = textOf(change.file)
    if (file !== '') listed.add(file)
  }
  const rows: string[] = []
  for (const file of files) {
    const path = textOf(file)
    if (path === '' || listed.has(path)) continue
    rows.push(`- ${path}`)
  }
  if (rows.length === 0) return
  lines.push('', '## 未并表的改动路径', ...rows)
}

/** 追加验证结果：结论、类型/范围、命令、退出码、耗时，以及失败测试与错误。 */
function pushVerification(lines: string[], outcome: VerificationOutcome | undefined): void {
  if (outcome === undefined) return
  const section: string[] = [
    '',
    '## 验证',
    `- 结果: ${outcome.passed ? 'passed' : 'FAILED'}`,
    `- 类型 / 范围: ${outcome.kind} / ${outcome.scope}`,
    `- 命令: \`${outcome.command}\``,
    `- 退出码: ${outcome.exitCode === null ? '(none)' : outcome.exitCode}`,
    `- 耗时: ${outcome.durationMs}ms`,
  ]
  const failed = cleanItems(outcome.failedTests)
  if (failed.length > 0) section.push(`- 失败测试: ${failed.join(', ')}`)
  for (const error of cleanItems(outcome.errors)) section.push(`- 错误: ${error}`)
  lines.push(...section)
}

/** 追加阶段轨迹：每条 `- <from> → <to>（<reason>）`，无原因时省略括号。 */
function pushTransitions(lines: string[], transitions: MemoryInput['transitions']): void {
  const rows: string[] = []
  for (const transition of transitions) {
    const from = textOf(transition.from)
    const to = textOf(transition.to)
    if (from === '' || to === '') continue
    const reason = textOf(transition.reason)
    rows.push(reason === '' ? `- ${from} → ${to}` : `- ${from} → ${to}（${reason}）`)
  }
  if (rows.length === 0) return
  lines.push('', '## 阶段轨迹', ...rows)
}

/** 固定尾节：说明这份文档与 coding_handoff 实时记录的关系，以及续接顺序。 */
function pushNextRound(lines: string[]): void {
  lines.push(
    '',
    '## 下一轮怎么接',
    '- 这份文档是本轮状态机与 coding_handoff 记录的存档快照；下一轮继续时以 coding_handoff 的实时记录为准。',
    '- 续接轮请先读「目标 / 验收标准 / 交付记录 / 后续跟进」四节，再决定是否重做上一轮。',
  )
}

/** 截断到 {@link MEMORY_LIMIT}：优先切在最后一个完整行，并标注文档已截断。 */
function truncateDocument(text: string): string {
  if (text.length <= MEMORY_LIMIT) return text
  const cut = text.slice(0, MEMORY_LIMIT)
  const lastBreak = cut.lastIndexOf('\n')
  return `${lastBreak > 0 ? cut.slice(0, lastBreak) : cut}\n…（文档已截断）`
}
