/**
 * Automatic, configured, and per-session reasoning-level policy.
 *
 * The level is chosen before every model call and written through the Agent's
 * own model selection (`agent.model.select()`), so the Provider receives the
 * effort on the next step. Three sources, in priority order:
 *
 * 1. the settings pin (`reasoning: low|high|max`) — the session is never
 *    classified and an in-session override is refused;
 * 2. an explicit per-session override — the chat box pick folded from a
 *    `model/selection` event, or the `coding_reasoning` tool;
 * 3. the deterministic classifier below, biased to Low and escalated by
 *    multi-file scope, module-level review/refactor, a long plan, and the rare
 *    project-level requests.
 *
 * The classifier spends no extra model request and exposes no transcript.
 *
 * @module dsh-coding/reasoning/reasoning
 */
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { CodingConfig } from '../config/config.js'
import { higher, levelForEffort, type ReasoningLevel } from './reasoning-levels.js'
import { REASONING_PROJECTION_KEY } from '../projections/reasoning-projection.js'

// Re-exported so callers keep importing the level vocabulary from this module.
export { higher, levelForEffort, rank, type ReasoningLevel } from './reasoning-levels.js'

/** One classification decision, kept for the tool and the status line. */
export interface ReasoningChoice {
  level: ReasoningLevel
  score: number
  reason: string
  /** Provider effort id picked in the chat box; overrides `level`. */
  effort?: string
}

/** Where the current level came from, for `coding_reasoning`. */
export interface ReasoningSummary {
  readonly source: 'auto' | 'manual'
  readonly level?: ReasoningLevel
  readonly reason?: string
}

/** What the controller needs from the session state machine. */
export interface ReasoningHooks {
  /** Latest observed turn number for one lead agent. */
  turnOf(agent: any): number
  /** Latest durable task list for one lead agent. */
  planOf(agent: any): readonly { status: string }[]
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const item = block as { type?: unknown; text?: unknown }
    if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text)
  }
  return parts.join('\n')
}

function directUserText(message: any): string {
  if (message?.role !== 'user') return ''
  if (message.source?.kind !== 'user') return ''
  return textOf(message.content)
}

/** Latest direct user message in a message batch, excluding injected context. */
export function latestUserTextIn(messages: unknown): string {
  if (!Array.isArray(messages)) return ''
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = directUserText(messages[index])
    if (text.trim() !== '') return text
  }
  return ''
}

/** Latest direct user message, excluding injected context and skill catalogs. */
export function latestUserText(session: any): string {
  let messages: unknown
  try {
    messages = session?.deriveMessages?.()
  } catch {
    return ''
  }
  return latestUserTextIn(messages)
}

const QUESTION_PATTERN = /[?？]\s*$|[吗呢]\s*$|\bdo\s+(?:you|we|i|they|it|this|that|these|those)\b|^(?:how|what|why|should|which|where|when|who|is|are|does|can|could|would|will)\b|^(?:怎么|如何|为什么|是否|哪|什么|要不要|该不该|能不能|可不可以)/i

/** A question that starts with an action verb asks for work, not advice. */
const ACTION_REQUEST_PATTERN = /^(?:can you|could you|would you|will you|can we|could we|would we|please|help me|review|audit|refactor|rewrite|implement|fix|add|update|modify|create|build|make|remove|delete|rename|move|migrate|redesign|scaffold|bootstrap|initialize|init|set up|handle|resolve|investigate|debug|analyze|optimize|optimise|improve|verify|check|test|document|simplify|clean|帮我|请|能|能否|可以|能不能|可不可以|给我|替我|麻烦|我要|我想|需要|是否(?:可以|能|要|需要)?帮我|审查|评审|重构|实现|开发|修复|修改|更新|新增|添加|删除|移除|替换|重写|翻译|调整|创建|搭建|初始化|迁移|检查|调查|排查|定位|优化|改进|验证|测试|处理|解决|分析)/i

const EXPLANATION_PATTERN = /\b(?:explain|describe|summari[sz]e|tell me|walk me through|want to know|wondering|curious|what is|what does|why is|why does|how does|how do|should i|should we|is it worth|does it make sense|what should|which (?:is|should|approach))\b|(?:解释|说明|总结|介绍一下|讲讲|说说|为什么|怎么回事|什么是|如何理解|怎么理解|该怎么|应该怎么|分析一下|有什么建议|想知道)/i

const ADVICE_PATTERN = /\b(?:advice|opinion|recommend|recommendation|suggest|suggestion|best way|which approach|trade-?offs?|thoughts|worth|benefit|better|make sense|advisable)\b|(?:建议|意见|推荐|值得|看法|选型|怎么选|如何选择|该不该|要不要|你觉得|你认为)/i

const PATH_PATTERN_GLOBAL = /(?:^|[\s`"'(])(?:[\w.@-]+[\\/])+[\w.@-]+\b|[A-Za-z]:\\[^\s]+/g

/** Explicit single-file scope beats a project word elsewhere in the sentence. */
const SINGLE_FILE_PATTERN = /\b(?:single[- ]file|one file|this file)\b|(?:单文件|一个文件|这个文件)/i

/** Max is deliberately narrow: project-scale or genuinely unfixable work only. */
const PROJECT_SETUP_PATTERNS = [
  /\b(?:scaffold|greenfield)\b/i,
  /\bbootstrap\b.{0,30}\b(?:project|app|application|service|system)\b/i,
  /\b(?:create|start|build|make|set up|initialize|init|bootstrap|scaffold)\b.{0,30}\b(?:new )?project\b(?!\s+(?:file|setting|settings|config|configuration|field|option|property|section|entry|row)\b)/i,
  /\b(?:new )?project\b.{0,30}\b(?:from scratch|setup|template)\b/i,
  /\bfrom scratch\b.{0,40}\b(?:project|app|application|service|system|cli|website|backend|frontend)\b/i,
  /\b(?:project|app|application|service|system|cli|website|backend|frontend)\b.{0,40}\bfrom scratch\b/i,
  /(?:项目脚手架|项目模板|初始化项目|项目初始化|新建项目|项目搭建|搭建.{0,6}项目|起一个新项目|做一个新项目|搭一个项目|创建.{0,6}新?项目(?!配置|文件|设置|字段|选项|属性)|建.{0,4}新?项目(?!配置|文件|设置|字段|选项|属性)|(?:从零|从0|从 0).{0,20}(?:项目|应用|系统|服务|网站|后台|前端|后端|脚手架|框架|平台)|(?:项目|应用|系统).{0,6}(?:搭建|脚手架|初始化))/i,
]

const PROJECT_REFACTOR_PATTERNS = [
  /\b(?:refactor|restructure|rewrite|migrate|redesign)\b.{0,60}\b(?:project|codebase|repository|repo|architecture)\b/i,
  /\b(?:project|codebase|repository|repo|architecture)\b.{0,60}\b(?:refactor|restructure|rewrite|migrate|redesign)\b/i,
  /(?:项目重构|重构整个|重构项目|整体重构|全项目重构|架构重构|代码库重构|重写整个|迁移整个|项目级重构|重构.{0,12}(?:项目|架构|代码库)|(?:项目|代码库).{0,8}(?:架构)?重构)/i,
]

const PROJECT_REVIEW_PATTERNS = [
  /\b(?:review|audit)\b.{0,60}\b(?:project|codebase|repository|repo)\b(?!\s+(?:file|setting|settings|config|configuration|field|option|property|section|entry|row)\b)|\b(?:review|audit)\b.{0,60}\b(?:all files|every file)\b/i,
  /\b(?:project|codebase|repository|repo)\b(?!\s+(?:file|setting|settings|config|configuration|field|option|property|section|entry|row)\b).{0,60}\b(?:review|audit)\b/i,
  /(?:项目级审查|项目审查|全项目审查|整个项目审查|全局审查|代码库审查|审查整个|审查全部|全量审查|项目级代码审查|审查.{0,12}(?:项目|代码库|全部)|(?:项目|代码库)(?!配置|文件|设置|字段|选项|属性).{0,8}(?:代码)?审查)/i,
]

const UNFIXABLE_PATTERNS = [
  /\b(?:unfixable|cannot (?:be )?fix(?:ed)?|can'?t fix|unable to fix|persistent bug|intermittent bug|heisenbug|root cause unknown|cannot reproduce|can'?t reproduce|unable to reproduce)\b/i,
  /(?:无法修复|修不好|找不到原因|反复失败|反复出现|顽固|一次性无法|无法复现|始终无法|一直修不好|反复修复)/i,
]

/** High is for multi-file work and a feature-module review/refactor, not ordinary edits. */
const MULTI_FILE_PATTERNS = [
  /\b(?:multi[- ]?file|multiple files|several files|across files|across (?:the )?(?:repo|codebase|project|app|application|modules?|packages?)|whole feature|module[- ]wide|codebase[- ]wide|end[- ]to[- ]end|e2e)\b/i,
  /\b(?:[2-9]|\d{2,}|two|three|four|five|six|seven|eight|nine|ten)\s*(?:files|file changes|source files)\b/i,
  /\b(?:review|audit|refactor)\b.{0,40}\b(?:feature|module)\b/i,
  /\b(?:feature|module)\b.{0,40}\b(?:review|audit|refactor)\b/i,
  /(?:多文件|多个文件|跨文件|跨多个文件|模块级|整个模块|多个模块|跨模块|跨包|端到端)/i,
  /(?:审查|评审|重构).{0,8}(?:功能模块|模块)/i,
  /(?:功能模块|模块).{0,8}(?:审查|评审|重构)/i,
  /(?:[2-9]|\d{2,}|两|二|三|四|五|六|七|八|九|十)\s*个文件/,
]

function matches(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text))
}

function pathCount(text: string): number {
  const seen = new Set<string>()
  for (const match of text.matchAll(PATH_PATTERN_GLOBAL)) {
    seen.add(match[0].replace(/^[\s`"'(]+/, '').trim())
  }
  return seen.size
}

function cleanUserText(text: unknown): string {
  if (typeof text !== 'string') return ''
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
    .replace(/<skill_content[\s\S]*?<\/skill_content>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function planItems(value: unknown): readonly { status: string }[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is { status: string } => (
    typeof item === 'object'
    && item !== null
    && typeof (item as { status?: unknown }).status === 'string'
  ))
}

/**
 * Classify one user turn with a deliberately low-biased policy.
 *
 * Low is the default. Max is reserved for four rare cases: creative project
 * setup, project-wide refactor, project-level review, and a bug that cannot be
 * fixed in one pass. High exists for multi-file work and a feature-module
 * review/refactor. Questions, advice, simple fixes, and single-file reviews
 * stay Low.
 */
export function classifyTask(rawText: unknown, todos: unknown = []): ReasoningChoice {
  const text = cleanUserText(rawText)
  if (text.length === 0) {
    return { level: 'low', score: 1, reason: 'no direct user text; no complexity signal' }
  }

  const question = QUESTION_PATTERN.test(text)
  const actionRequest = ACTION_REQUEST_PATTERN.test(text)
  const guidance = EXPLANATION_PATTERN.test(text)
    || ADVICE_PATTERN.test(text)
    || (question && !actionRequest)
  if (guidance) {
    return { level: 'low', score: 1, reason: 'question, advice, or guidance request' }
  }

  const paths = pathCount(text)
  if (SINGLE_FILE_PATTERN.test(text) && paths < 2 && !matches(MULTI_FILE_PATTERNS, text)) {
    return { level: 'low', score: 1, reason: 'explicit single-file scope' }
  }

  if (matches(PROJECT_SETUP_PATTERNS, text)) {
    return { level: 'max', score: 5, reason: 'creative project setup' }
  }
  if (matches(PROJECT_REFACTOR_PATTERNS, text)) {
    return { level: 'max', score: 5, reason: 'project-wide refactor' }
  }
  if (matches(PROJECT_REVIEW_PATTERNS, text)) {
    return { level: 'max', score: 5, reason: 'project-level review' }
  }
  if (matches(UNFIXABLE_PATTERNS, text)) {
    return { level: 'max', score: 5, reason: 'one-shot unfixable bug' }
  }

  if (paths >= 2) {
    return { level: 'high', score: 3, reason: `${paths} repository files referenced` }
  }
  if (matches(MULTI_FILE_PATTERNS, text)) {
    return { level: 'high', score: 3, reason: 'multi-file or feature-module work' }
  }

  const plan = planItems(todos)
  const open = plan.filter((item) => item.status !== 'completed').length
  if (plan.length >= 6 || open >= 5) {
    return { level: 'high', score: 3, reason: `${plan.length}-step execution plan` }
  }

  return { level: 'low', score: 1, reason: 'default low; no multi-file or project-level signal' }
}

/**
 * Pick the closest supported provider effort. Providers differ in which effort
 * ids they accept, and a rejected id aborts the turn before any I/O.
 */
export function mapEffort(desired: ReasoningLevel, supported: readonly string[]): string | undefined {
  if (!Array.isArray(supported) || supported.length === 0) return undefined
  const available = new Set(supported.filter((id): id is string => typeof id === 'string'))
  const preferences: Record<ReasoningLevel, readonly string[]> = {
    low: ['low', 'minimal', 'medium', 'high', 'max'],
    high: ['high', 'medium', 'xhigh', 'max', 'low', 'minimal'],
    max: ['max', 'xhigh', 'high', 'medium', 'low'],
  }
  for (const id of preferences[desired]) {
    if (available.has(id)) return id
  }
  return undefined
}

interface AgentState {
  turn: number
  level: ReasoningLevel
  choice: ReasoningChoice
}

/**
 * Owns the per-session reasoning decision and applies it through the entry
 * point's model-selection reference. Exported for focused tests.
 */
export class ReasoningController {
  private readonly states = new WeakMap<object, AgentState>()
  private readonly overrides = new WeakMap<object, ReasoningLevel>()
  private readonly userChoices = new WeakMap<object, string>()
  private readonly applied = new WeakMap<object, string>()
  private readonly support = new Map<string, Promise<readonly string[] | null>>()
  /**
   * Resolved effort ids per route, readable synchronously. The inbox hook has
   * to choose an effort before the Host snapshots the step's selection and
   * cannot await `resolveModelInfo`, so the asynchronous lookup fills this map
   * ahead of time and a cold entry simply defers to the pre-step path.
   */
  private readonly resolved = new Map<string, readonly string[] | null>()
  /** Latest direct user text per turn; a continuation step reuses it. */
  private readonly latestTexts = new WeakMap<object, { turn: number; text: string }>()

  constructor(
    private readonly ctx: any,
    private readonly options: () => CodingConfig,
    private readonly hooks: ReasoningHooks,
  ) {}

  /**
   * Resolve a Host or Agent service from the Agent scope first. Preset child
   * plugins sit above the Agent scope, so Host-level services such as the
   * session controller and LLM registry are not always visible from `ctx`.
   */
  private service(agent: any, name: string): any {
    try {
      const scoped = agent?.ctx?.get?.(name)
      if (scoped !== undefined) return scoped
    } catch {
      // Fall through to the preset context.
    }
    try {
      return this.ctx.get(name)
    } catch {
      return undefined
    }
  }

  /** Durable reasoning state, folded from the Session log by this preset. */
  private projectionState(agent: any): { override?: unknown; userEffort?: unknown } | undefined {
    const session = agent?.session
    if (session === undefined) return undefined
    try {
      const projections = this.service(agent, 'sessionProjections')
      const value = projections?.snapshot?.(session, [REASONING_PROJECTION_KEY])
        ?.values?.[REASONING_PROJECTION_KEY]
      return typeof value === 'object' && value !== null
        ? value as { override?: unknown; userEffort?: unknown }
        : undefined
    } catch {
      return undefined
    }
  }

  /** Explicit override and chat-box pick, projection-first. */
  private effective(agent: any): { override?: ReasoningLevel; userEffort?: string } {
    const projected = this.projectionState(agent)
    const rawOverride = projected === undefined ? this.overrides.get(agent) : projected.override
    const override = rawOverride === 'low' || rawOverride === 'high' || rawOverride === 'max'
      ? rawOverride
      : undefined
    const rawEffort = projected === undefined ? this.userChoices.get(agent) : projected.userEffort
    const userEffort = typeof rawEffort === 'string' && rawEffort.trim() !== ''
      ? rawEffort.trim()
      : undefined
    return {
      ...override === undefined ? {} : { override },
      ...userEffort === undefined ? {} : { userEffort },
    }
  }

  /**
   * Fold the projection back into this controller. A chat-box pick lands as a
   * `model/selection` event, a `coding_reasoning` call as a tool event, and the
   * projection is what survives a Host restart.
   */
  syncProjection(agent: any): void {
    const session = agent?.session
    if (session === undefined) return
    const state = this.projectionState(agent)
    if (state === undefined) return
    const override = state.override
    if (override === 'low' || override === 'high' || override === 'max') {
      this.overrides.set(agent, override)
    } else {
      this.overrides.delete(agent)
    }
    const userEffort = typeof state.userEffort === 'string' && state.userEffort.trim() !== ''
      ? state.userEffort.trim()
      : undefined
    if (userEffort === undefined) this.userChoices.delete(agent)
    else this.userChoices.set(agent, userEffort)
    // The route may have moved since the last lookup; warm the synchronous
    // cache so the next inbox hook can choose an effort itself.
    void this.prewarm(agent).catch(() => {})
  }

  /**
   * The step's model selection. DSH 0.2.2 owns it on `agent.model`; every read
   * and write goes through that service.
   */
  private selection(agent: any): any {
    const model = agent?.model
    if (typeof model?.current !== 'function') return undefined
    try {
      return model.current()
    } catch {
      return undefined
    }
  }

  /** Resolve a route's supported efforts in the background; failures stay unknown. */
  async prewarm(agent: any): Promise<void> {
    const current = this.selection(agent)
    if (current === undefined) return
    const key = `${current.provider}/${current.model}`
    if (this.support.has(key)) return
    await this.effortsFor(agent, current.provider, current.model, undefined)
  }

  private async effortsFor(
    agent: any,
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<readonly string[] | null> {
    const llm = this.service(agent, 'llm')
    if (llm?.resolveModelInfo === undefined) return null
    const key = `${provider}/${model}`
    const cached = this.support.get(key)
    if (cached !== undefined) return cached
    const pending = (async () => {
      try {
        const info = await llm.resolveModelInfo(provider, model, signal)
        const efforts = Array.isArray(info?.reasoning?.efforts) ? info.reasoning.efforts : []
        const ids = efforts
          .map((effort: { id?: unknown }) => effort?.id)
          .filter((id: unknown): id is string => typeof id === 'string')
        this.resolved.set(key, ids)
        return ids
      } catch {
        // A transient capability lookup must not pin this route to "no
        // reasoning" for the rest of the process. Retry after a short pause.
        this.resolved.set(key, null)
        if (signal?.aborted === true) this.support.delete(key)
        else setTimeout(() => {
          this.support.delete(key)
          this.resolved.delete(key)
        }, 30_000).unref?.()
        return null
      }
    })()
    this.support.set(key, pending)
    return pending
  }

  /** Latest direct user message for one turn, derived at most once per turn. */
  private textFor(agent: any, turn: number): string {
    const cached = this.latestTexts.get(agent)
    if (cached !== undefined && cached.turn === turn) return cached.text
    const text = latestUserText(agent.session)
    this.latestTexts.set(agent, { turn, text })
    return text
  }

  private async supported(agent: any, signal?: AbortSignal): Promise<readonly string[] | null> {
    const current = this.selection(agent)
    if (current === undefined) return null
    return this.effortsFor(agent, current.provider, current.model, signal)
  }

  /**
   * Prefer the effort the user picked in the chat box, but only while the route
   * still accepts it; otherwise fall back to the level's closest effort.
   */
  private resolveEffort(choice: ReasoningChoice, supported: readonly string[]): string | undefined {
    const picked = choice.effort
    if (picked !== undefined && supported.includes(picked)) return picked
    return mapEffort(choice.level, supported)
  }

  /**
   * Record the effort as the session's model selection. The Host fixes a
   * step's selection before prompt assembly and refuses an `agent/request`
   * rewrite, so `agent.model.select()` is the only supported write; it applies
   * from the next step, which is why the inbox hook runs it before `preStep`
   * captures the selection for the incoming turn.
   */
  private selectEffort(agent: any, effort: string | undefined): boolean {
    const model = agent?.model
    if (typeof model?.select !== 'function') return false
    const current = this.selection(agent)
    if (current === undefined) return false
    if (effort === undefined) {
      this.applied.delete(agent)
      return true
    }
    if (String(current.reasoningEffort ?? '') === effort) {
      this.applied.set(agent, effort)
      return true
    }
    try {
      model.select({
        provider: current.provider,
        model: current.model,
        reasoningEffort: ReasoningEffortId(effort),
      })
    } catch {
      return false
    }
    this.applied.set(agent, effort)
    return true
  }

  /** Treat a malformed runtime value as the safe automatic mode. */
  private mode(value: unknown): CodingConfig['reasoning'] {
    return value === 'low' || value === 'high' || value === 'max' ? value : 'auto'
  }

  /** Classify one request; the caller decides when to write the selection. */
  private classify(agent: any, text: string, turn: number): ReasoningChoice {
    const options = this.options()
    const mode = this.mode(options.reasoning)
    const plan = this.hooks.planOf(agent)
    const classified: ReasoningChoice = mode === 'auto'
      ? classifyTask(text, plan)
      : {
          level: mode,
          score: 0,
          reason: `fixed by Coding settings (${mode})`,
        }

    let level = classified.level
    let effort: string | undefined
    if (mode === 'auto') {
      const previous = this.states.get(agent)
      if (previous !== undefined && previous.turn === turn) level = higher(previous.level, level)
      // The durable projection is the authority: a chat-box pick may have
      // landed since the last pre-step, and the inbox hook reads this before
      // `syncProjection` runs for the incoming turn.
      const { override, userEffort } = this.effective(agent)
      if (userEffort !== undefined) {
        // A pick in the chat box is the user's explicit decision for this
        // session: skip the classifier instead of overwriting it each step.
        level = levelForEffort(userEffort)
        effort = userEffort
        classified.reason = `picked ${userEffort} in the chat box`
      } else if (override !== undefined) {
        level = override
        classified.reason = `session override (${override})`
      }
    }

    const choice: ReasoningChoice = {
      ...classified,
      level,
      ...effort === undefined ? {} : { effort },
    }
    this.states.set(agent, { turn, level, choice })
    return choice
  }

  /**
   * Choose for a message claimed by the inbox. The Host emits this hook before
   * it snapshots the step's model selection, so a synchronous capability cache
   * lets the automatic level reach the turn's first step instead of the next
   * one. A cold cache writes nothing and leaves the pre-step path to catch up.
   */
  applySync(agent: any, message: unknown, turn?: number): ReasoningChoice | undefined {
    if (agent?.session === undefined) return undefined
    const text = directUserText(message)
    if (text.trim() === '') return undefined
    const choice = this.classify(agent, text, turn ?? this.hooks.turnOf(agent))
    const current = this.selection(agent)
    if (current !== undefined) {
      const supported = this.resolved.get(`${current.provider}/${current.model}`)
      if (supported !== undefined && supported !== null) {
        this.selectEffort(agent, this.resolveEffort(choice, supported))
      }
    }
    return choice
  }

  /**
   * Recompute the decision for the current step. When the caller supplies the
   * admitted message batch, classify the request itself; otherwise fall back
   * to the session's latest direct user message.
   */
  async apply(
    agent: any,
    signal?: AbortSignal,
    messages?: unknown,
    turn?: number,
  ): Promise<ReasoningChoice | undefined> {
    if (agent?.session === undefined) return undefined
    const admitted = messages === undefined ? '' : latestUserTextIn(messages)
    const at = turn ?? this.hooks.turnOf(agent)
    const text = admitted.trim() !== '' ? admitted : this.textFor(agent, at)
    if (admitted.trim() !== '') this.latestTexts.set(agent, { turn: at, text })
    const choice = this.classify(agent, text, at)
    const supported = await this.supported(agent, signal)
    if (supported !== null) this.selectEffort(agent, this.resolveEffort(choice, supported))
    return choice
  }

  /** Current selector value without resolving provider capabilities. */
  currentEffort(agent: any): string | undefined {
    const value = this.selection(agent)?.reasoningEffort
    return value === undefined ? undefined : String(value)
  }

  /** Explicit in-session override; `auto` clears it. */
  override(agent: any, value: ReasoningLevel | 'auto', turn?: number): ReasoningChoice {
    const requested = value === 'low' || value === 'high' || value === 'max' ? value : 'auto'
    // An explicit tool decision replaces a chat-box pick.
    this.userChoices.delete(agent)
    const at = turn ?? this.hooks.turnOf(agent)
    if (requested === 'auto') {
      this.overrides.delete(agent)
      const choice = classifyTask(this.textFor(agent, at), this.hooks.planOf(agent))
      this.states.set(agent, { turn: at, level: choice.level, choice })
      return choice
    }
    this.overrides.set(agent, requested)
    const choice: ReasoningChoice = {
      level: requested,
      score: 0,
      reason: `session override (${requested})`,
    }
    this.states.set(agent, { turn: at, level: requested, choice })
    return choice
  }

  describe(agent: any): {
    options: CodingConfig
    choice: ReasoningChoice | undefined
    effort: string | undefined
  } {
    return {
      options: this.options(),
      choice: this.states.get(agent)?.choice,
      effort: this.applied.get(agent) ?? this.currentEffort(agent),
    }
  }

  /**
   * Where the level comes from, for `coding_reasoning`. The settings pin wins
   * over an in-session override because it already suppresses the classifier.
   * Without an agent the answer falls back to the settings alone.
   */
  summary(agent?: any): ReasoningSummary {
    const mode = this.mode(this.options().reasoning)
    if (mode !== 'auto') {
      return { source: 'manual', level: mode, reason: 'pinned by Coding settings' }
    }
    if (agent === undefined) return { source: 'auto' }
    const { override, userEffort } = this.effective(agent)
    if (override !== undefined) {
      return { source: 'manual', level: override, reason: 'session override' }
    }
    if (userEffort !== undefined) {
      return {
        source: 'manual',
        level: levelForEffort(userEffort),
        reason: `picked ${userEffort} in the chat box`,
      }
    }
    const choice = this.states.get(agent)?.choice
    if (choice === undefined) return { source: 'auto' }
    return { source: 'auto', level: choice.level, reason: choice.reason }
  }
}
