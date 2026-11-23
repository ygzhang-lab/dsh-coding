/**
 * Cross-stage handoff: the bounded record one stage gives the next.
 *
 * The record is a summary, never a transcript: every list and every free-text
 * value has a fixed cap, so a long run cannot flood the next worker's prompt. A
 * patch is merged into the previous record instead of replacing it, because the
 * planner, implementer, and verifier each contribute their own section.
 *
 * This module is pure and browser safe: no I/O, no dependencies, no clock other
 * than the timestamp default. The Host runtime, the worker presets, and the Web
 * client can therefore import it directly.
 *
 * 交付段的写入约定：`delivered` / `followUps` 只由 deliver 阶段经 coding_handoff 写入，
 * 记录本轮交付了什么与对应证据；它们随 checkpoint 的 handoff 持久化，由下一轮的 plan /
 * implement worker 读取（verify 分片不渲染该段以控制提示词体积），因此重开会话也能直接
 * 看到上一轮的交付结果，而不必回头翻对话正文。
 *
 * @module dsh-coding/handoff
 */

/** Version of the persisted {@link CodingHandoff} shape. */
export const HANDOFF_VERSION = 1

/** Longest single free-text value (goal, one list item, acceptance, avoid note). */
export const HANDOFF_TEXT_LIMIT = 600
/** Most entries kept per bullet section (`constraints`, `findings`, …). */
export const HANDOFF_ITEMS_LIMIT = 10
/** Most plan tasks the handoff carries. */
export const HANDOFF_TASKS_LIMIT = 8
/** Most changed-file entries the handoff carries. */
export const HANDOFF_CHANGES_LIMIT = 20
/** Default length of {@link handoffDigest}. */
export const HANDOFF_DIGEST_LIMIT = 1200
/** Longest worker-facing rendering of the handoff. */
export const HANDOFF_WORKER_LIMIT = 2000

/** One planned task of the run, as the planner worker reports it. */
export interface HandoffTask {
  readonly goal: string
  readonly files: readonly string[]
  readonly acceptance: string
  /** What the implementer must not do while touching these files. */
  readonly avoid?: string
}

/** One file this run changed, with the smallest useful summary. */
export interface HandoffChange {
  readonly file: string
  readonly summary: string
}

/** The bounded handoff record a stage persists for the stages after it. */
export interface CodingHandoff {
  readonly version: typeof HANDOFF_VERSION
  /** What the run is for; cleared by patching it with an empty string. */
  readonly goal?: string
  /** 一条紧凑的交付记录（本轮交付了什么 + 证据）；空串表示清除，由模型在 deliver 阶段写入。 */
  readonly delivered?: string
  readonly constraints: readonly string[]
  /** Acceptance criteria: the definition of done `verify` and `deliver` check. */
  readonly acceptance: readonly string[]
  readonly findings: readonly string[]
  readonly decisions: readonly string[]
  /** Questions still open; the next stage answers or escalates them. */
  readonly open: readonly string[]
  /** 残余风险与后续跟进项，下一轮的 plan / implement worker 会读到。 */
  readonly followUps: readonly string[]
  readonly tasks: readonly HandoffTask[]
  readonly changes: readonly HandoffChange[]
  readonly updatedAt: number
}

/** A partial update applied by {@link mergeHandoff}; absent fields are untouched. */
export interface HandoffPatch {
  readonly goal?: string
  /** 覆盖交付记录；传空串表示清除，不传则保留上一条。 */
  readonly delivered?: string
  readonly constraints?: readonly string[]
  readonly acceptance?: readonly string[]
  readonly findings?: readonly string[]
  readonly decisions?: readonly string[]
  readonly open?: readonly string[]
  /** 追加残余风险 / 跟进项（去重后保留下限内的最新条目）。 */
  readonly followUps?: readonly string[]
  /** Replaces the task list wholesale when present. */
  readonly tasks?: readonly HandoffTask[]
  /** Merged by `file` when present, so a later stage refines a summary. */
  readonly changes?: readonly HandoffChange[]
}

/** A role that receives the handoff, in dispatch order. */
type HandoffRole = 'plan' | 'implement' | 'verify'

/** One renderable section of a handoff. */
type HandoffSection =
  | 'goal'
  | 'delivered'
  | 'constraints'
  | 'done'
  | 'decisions'
  | 'findings'
  | 'open'
  | 'followUps'
  | 'tasks'
  | 'changes'

/**
 * Sections each role receives, in order. The planner needs the problem, the
 * implementer needs the decisions and the task list, and the verifier needs the
 * definition of done plus what already changed.
 *
 * 交付段只给 plan / implement：这两个角色需要知道上一轮交付了什么，才能接着规划与实现。
 * verify 只核对本次改动（goal / done / changes / decisions / findings），不读上一轮交付
 * 记录，以控制提示词体积。
 */
const WORKER_SECTIONS: Readonly<Record<HandoffRole, readonly HandoffSection[]>> = {
  plan: ['goal', 'delivered', 'constraints', 'done', 'findings', 'open'],
  implement: ['goal', 'delivered', 'constraints', 'done', 'decisions', 'findings', 'tasks', 'open'],
  verify: ['goal', 'done', 'changes', 'decisions', 'findings'],
}

/** An empty handoff stamped at `at`, defaulting to now. */
export function emptyHandoff(at?: number): CodingHandoff {
  return {
    version: HANDOFF_VERSION,
    constraints: [],
    acceptance: [],
    findings: [],
    decisions: [],
    open: [],
    followUps: [],
    tasks: [],
    changes: [],
    updatedAt: at ?? Date.now(),
  }
}

/**
 * Merge one patch into a handoff. A list patch appends (dropping exact
 * duplicates, keeping the newest {@link HANDOFF_ITEMS_LIMIT} entries); a task
 * patch replaces the list; a change patch refines entries by `file`.
 *
 * `delivered` 与 goal 同语义：给值即覆盖，空串清除；`followUps` 与其余列表字段
 * 同语义：追加、去重，并保留最新的 {@link HANDOFF_ITEMS_LIMIT} 条。
 * @param base - the record being updated, or undefined to start empty.
 * @param patch - the sections this stage contributes.
 * @param at - timestamp to stamp, defaults to now.
 * @returns a new record; the inputs are not mutated.
 */
export function mergeHandoff(base: CodingHandoff | undefined, patch: HandoffPatch, at?: number): CodingHandoff {
  const previous = base ?? emptyHandoff(at)
  const goal = boundedText(patch.goal === undefined ? previous.goal : patch.goal, HANDOFF_TEXT_LIMIT)
  const delivered = boundedText(patch.delivered === undefined ? previous.delivered : patch.delivered, HANDOFF_TEXT_LIMIT)
  return {
    version: HANDOFF_VERSION,
    ...goal === '' ? {} : { goal },
    ...delivered === '' ? {} : { delivered },
    constraints: mergeItems(previous.constraints, listOf(patch.constraints)),
    acceptance: mergeItems(previous.acceptance, listOf(patch.acceptance)),
    findings: mergeItems(previous.findings, listOf(patch.findings)),
    decisions: mergeItems(previous.decisions, listOf(patch.decisions)),
    open: mergeItems(previous.open, listOf(patch.open)),
    // 旧数据与测试手工构造的记录可能没有 followUps，先兜底成空列表再合并。
    followUps: mergeItems(previous.followUps ?? [], listOf(patch.followUps)),
    tasks: patch.tasks === undefined ? cleanTasks(previous.tasks) : boundedTasks(listOf(patch.tasks)),
    changes: patch.changes === undefined ? cleanChanges(previous.changes) : mergeChanges(previous.changes, listOf(patch.changes)),
    updatedAt: at ?? Date.now(),
  }
}

/**
 * Validate one untyped value as a {@link CodingHandoff}. The record is persisted
 * in checkpoints and restored from durable JSON, so every field is re-checked
 * here rather than trusted from the writer's build.
 *
 * 旧 checkpoint 可能没有 `delivered` / `followUps`（与 `files` 字段先例一致，不 bump
 * {@link HANDOFF_VERSION}）：缺字段按空值处理，损坏值被丢弃，返回的记录始终可用。
 * @param value - decoded JSON or any other untyped value.
 * @returns the normalized record, or undefined when it is not version 1.
 */
export function asHandoff(value: unknown): CodingHandoff | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (raw['version'] !== HANDOFF_VERSION) return undefined
  const goal = boundedText(raw['goal'], HANDOFF_TEXT_LIMIT)
  const delivered = boundedText(raw['delivered'], HANDOFF_TEXT_LIMIT)
  const updatedAt = raw['updatedAt']
  return {
    version: HANDOFF_VERSION,
    ...goal === '' ? {} : { goal },
    ...delivered === '' ? {} : { delivered },
    constraints: mergeItems([], listOf(raw['constraints'])),
    acceptance: mergeItems([], listOf(raw['acceptance'])),
    findings: mergeItems([], listOf(raw['findings'])),
    decisions: mergeItems([], listOf(raw['decisions'])),
    open: mergeItems([], listOf(raw['open'])),
    followUps: mergeItems([], listOf(raw['followUps'])),
    tasks: boundedTasks(listOf(raw['tasks'])),
    changes: mergeChanges([], listOf(raw['changes'])),
    updatedAt: typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : Date.now(),
  }
}

/**
 * Render the handoff as a compact multi-line digest for logs and status text.
 * Only the sections carrying content are rendered, one short line each.
 * @param handoff - record to render, or undefined.
 * @param limit - maximum length, whole lines preferred.
 * @returns the digest, or '' when the record is empty.
 */
export function handoffDigest(handoff: CodingHandoff | undefined, limit: number = HANDOFF_DIGEST_LIMIT): string {
  if (handoff === undefined) return ''
  const lines: string[] = []
  const goal = boundedText(handoff.goal, HANDOFF_TEXT_LIMIT)
  if (goal !== '') lines.push(`goal: ${goal}`)
  const delivered = boundedText(handoff.delivered, HANDOFF_TEXT_LIMIT)
  if (delivered !== '') lines.push(`delivered: ${delivered}`)
  pushItems(lines, 'constraints', handoff.constraints)
  pushItems(lines, 'done', handoff.acceptance)
  pushItems(lines, 'decisions', handoff.decisions)
  pushItems(lines, 'findings', handoff.findings)
  pushItems(lines, 'open', handoff.open)
  pushItems(lines, 'follow-ups', handoff.followUps)
  const tasks = cleanTasks(handoff.tasks)
  if (tasks.length > 0) {
    lines.push('tasks:')
    tasks.forEach((task, index) => {
      const files = task.files.length === 0 ? '(none)' : task.files.join(', ')
      const avoid = task.avoid === undefined ? '' : `; avoid: ${task.avoid}`
      lines.push(`${index + 1}. ${task.goal} — files: ${files}; done: ${task.acceptance}${avoid}`)
    })
  }
  const changes = cleanChanges(handoff.changes)
  if (changes.length > 0) {
    lines.push(`changes: ${changes.map(change => `${change.file}: ${change.summary}`).join('; ')}`)
  }
  return truncateText(lines.join('\n'), limit)
}

/**
 * Render the sections one worker role receives, as a prompt fragment.
 * 只有 plan / implement 分片包含 `Delivered:` 段，见 {@link WORKER_SECTIONS}。
 * @param handoff - record to render, or undefined.
 * @param role - worker about to run.
 * @returns the fragment, or '' when nothing applies to this role.
 */
export function handoffForWorker(handoff: CodingHandoff | undefined, role: HandoffRole): string {
  if (handoff === undefined) return ''
  const sections: Readonly<Record<HandoffSection, string | undefined>> = {
    goal: goalSection(handoff.goal),
    delivered: deliveredSection(handoff.delivered),
    constraints: bulletSection('Constraints:', cleanItems(handoff.constraints)),
    done: bulletSection('Definition of done:', cleanItems(handoff.acceptance)),
    decisions: bulletSection('Decisions:', cleanItems(handoff.decisions)),
    findings: bulletSection('Findings:', cleanItems(handoff.findings)),
    open: bulletSection('Open questions:', cleanItems(handoff.open)),
    followUps: bulletSection('Follow-ups:', cleanItems(handoff.followUps)),
    tasks: taskSection(cleanTasks(handoff.tasks)),
    changes: changeSection(cleanChanges(handoff.changes)),
  }
  const parts = WORKER_SECTIONS[role]
    .map(section => sections[section])
    .filter((part): part is string => part !== undefined)
  return parts.length === 0 ? '' : truncateText(parts.join('\n\n'), HANDOFF_WORKER_LIMIT)
}

/** Whether the handoff states a goal, which `plan` requires before planning. */
export function hasGoal(handoff: CodingHandoff): boolean {
  return boundedText(handoff.goal, HANDOFF_TEXT_LIMIT) !== ''
}

/** Whether the handoff states at least one acceptance criterion, which `verify` and `deliver` require. */
export function hasDefinitionOfDone(handoff: CodingHandoff): boolean {
  return cleanItems(handoff.acceptance).length > 0
}

/** Read one array-valued field, ignoring anything that is not an array. */
function listOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

/** Trim one value to `limit` characters; anything that is not a string becomes ''. */
function boundedText(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : ''
}

/** Cut `text` to `limit` characters, preferring the last whole line. */
function truncateText(text: string, limit: number): string {
  if (limit <= 0) return ''
  if (text.length <= limit) return text
  const cut = text.slice(0, limit)
  const lastBreak = cut.lastIndexOf('\n')
  return lastBreak > 0 ? cut.slice(0, lastBreak) : cut
}

/**
 * Cleaned items of one bullet section: trimmed, empty dropped, exact duplicates
 * collapsed in insertion order, oldest entries cut past the limit.
 */
function mergeItems(base: readonly unknown[], added: readonly unknown[]): readonly string[] {
  const seen = new Set<string>()
  for (const raw of [...base, ...added]) {
    const value = boundedText(raw, HANDOFF_TEXT_LIMIT)
    if (value !== '') seen.add(value)
  }
  const items = [...seen]
  return items.slice(Math.max(0, items.length - HANDOFF_ITEMS_LIMIT))
}

/** Clean every item of a bullet section, for rendering only. */
function cleanItems(values: readonly unknown[]): readonly string[] {
  return mergeItems([], values)
}

/** Clean one task, or undefined when it names no goal. */
function cleanTask(value: unknown): HandoffTask | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const goal = boundedText(raw['goal'], HANDOFF_TEXT_LIMIT)
  if (goal === '') return undefined
  const avoid = boundedText(raw['avoid'], HANDOFF_TEXT_LIMIT)
  return {
    goal,
    files: mergeItems([], listOf(raw['files'])),
    acceptance: boundedText(raw['acceptance'], HANDOFF_TEXT_LIMIT),
    ...avoid === '' ? {} : { avoid },
  }
}

/** Clean every task, dropping the ones without a goal. */
function cleanTasks(values: readonly unknown[]): readonly HandoffTask[] {
  const tasks: HandoffTask[] = []
  for (const value of values) {
    const task = cleanTask(value)
    if (task !== undefined) tasks.push(task)
  }
  return tasks
}

/** Clean a task list, keeping one task per goal in order, up to the limit. */
function boundedTasks(values: readonly unknown[]): readonly HandoffTask[] {
  const byGoal = new Map<string, HandoffTask>()
  for (const value of values) {
    const task = cleanTask(value)
    if (task !== undefined && !byGoal.has(task.goal)) byGoal.set(task.goal, task)
  }
  const tasks = [...byGoal.values()]
  return tasks.slice(Math.max(0, tasks.length - HANDOFF_TASKS_LIMIT))
}

/** Clean one change entry, or undefined when it names no file. */
function cleanChange(value: unknown): HandoffChange | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const file = boundedText(raw['file'], HANDOFF_TEXT_LIMIT)
  if (file === '') return undefined
  return { file, summary: boundedText(raw['summary'], HANDOFF_TEXT_LIMIT) }
}

/** Clean every change entry, dropping the ones without a file. */
function cleanChanges(values: readonly unknown[]): readonly HandoffChange[] {
  const changes: HandoffChange[] = []
  for (const value of values) {
    const change = cleanChange(value)
    if (change !== undefined) changes.push(change)
  }
  return changes
}

/** Merge change lists by file: the newest summary wins, in first-seen order. */
function mergeChanges(base: readonly unknown[], added: readonly unknown[]): readonly HandoffChange[] {
  const byFile = new Map<string, HandoffChange>()
  for (const raw of [...base, ...added]) {
    const change = cleanChange(raw)
    if (change !== undefined) byFile.set(change.file, change)
  }
  const changes = [...byFile.values()]
  return changes.slice(Math.max(0, changes.length - HANDOFF_CHANGES_LIMIT))
}

/** `label: a; b` for one non-empty bullet section, or nothing. */
function pushItems(lines: string[], label: string, values: readonly unknown[]): void {
  const items = cleanItems(values)
  if (items.length > 0) lines.push(`${label}: ${items.join('; ')}`)
}

/** The `Goal:` fragment, or nothing when no goal is stated. */
function goalSection(goal: string | undefined): string | undefined {
  const text = boundedText(goal, HANDOFF_TEXT_LIMIT)
  return text === '' ? undefined : `Goal:\n${text}`
}

/** The `Delivered:` fragment（上一轮交付了什么 + 证据），or nothing when absent. */
function deliveredSection(value: string | undefined): string | undefined {
  const text = boundedText(value, HANDOFF_TEXT_LIMIT)
  return text === '' ? undefined : `Delivered:\n${text}`
}

/** A titled list, one `- item` per line, or nothing when the list is empty. */
function bulletSection(title: string, values: readonly string[]): string | undefined {
  if (values.length === 0) return undefined
  return `${title}\n${values.map(value => `- ${value}`).join('\n')}`
}

/** The `Plan tasks:` fragment, three lines per task plus an avoid note. */
function taskSection(tasks: readonly HandoffTask[]): string | undefined {
  if (tasks.length === 0) return undefined
  const lines = ['Plan tasks:']
  tasks.forEach((task, index) => {
    lines.push(`${index + 1}. ${task.goal}`)
    lines.push(`   files: ${task.files.length === 0 ? '(none)' : task.files.join(', ')}`)
    lines.push(`   done: ${task.acceptance}`)
    if (task.avoid !== undefined) lines.push(`   avoid: ${task.avoid}`)
  })
  return lines.join('\n')
}

/** The `Changes:` fragment, one `- file — summary` line per entry. */
function changeSection(changes: readonly HandoffChange[]): string | undefined {
  if (changes.length === 0) return undefined
  return `Changes:\n${changes.map(change => `- ${change.file} — ${change.summary}`).join('\n')}`
}
