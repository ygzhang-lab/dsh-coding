/**
 * Per-turn Coding control card, rendered at the tail of every closed Turn.
 *
 * This is the surface the old plugin had — one card per Turn showing the mode
 * that Turn ran under and letting the newest card switch it — extended with the
 * runtime's stage, plan, and verification state. It reads the durable
 * `dshCodingStage` projection, never the Host's in-memory machine, so a
 * reloaded session shows what actually happened.
 *
 * Only the newest Turn's card is a control. Older cards keep the mode and stage
 * they ran under, with their buttons disabled, so a later switch never rewrites
 * history. Mode buttons go back through the Host as the silent `/coding set`
 * verb, so pressing one applies the mode without starting a Turn or producing a
 * model reply.
 *
 * All visual styling lives in `./styles.ts` and follows DSH's own recipes; this
 * component only composes the shipped classes.
 *
 * @module dsh-coding/client/card
 */
import { createElement as h, memo, useState } from 'react'
import type { ReactElement } from 'react'
import {
  CODING_PROJECTION_KEY,
  type CodingStageView,
  type CodingVerificationView,
} from '../projections/coding-projection.js'
import {
  REASONING_PROJECTION_KEY,
  type ReasoningProjectionState,
  type ReasoningTurn,
} from '../projections/reasoning-projection.js'
import { levelForEffort, type ReasoningLevel } from '../reasoning/reasoning-levels.js'
import { STAGES_BY_MODE, type CodingMode, type CodingStage } from '../core/stages.js'
import { commandRejected } from './command-row.js'
import type { CodingKey } from './locales.js'

/** Modes the card can switch to, in roster order. */
const MODES: readonly CodingMode[] = ['auto', 'consult', 'review', 'codex']

/** Props the turn-tail slot hands this card. */
export interface CodingCardProps {
  /** Host-computed projection value for this session. */
  readonly useProjection: (
    key: typeof CODING_PROJECTION_KEY | typeof REASONING_PROJECTION_KEY,
  ) => unknown
  /** Owner props: `TurnLocation` (`{ kind, turn }`) or a plain number. */
  readonly turn?: unknown
  /** Injected by this plugin's registration: run one `/coding …` line. */
  readonly execute?: (line: string) => unknown
  /** Injected by this plugin's registration: the configured reasoning policy. */
  readonly settings?: () => unknown
  readonly t: (key: CodingKey) => string
}

/**
 * The state one card renders: the live projection for the newest closed Turn,
 * or the frozen snapshot that Turn ran under. Pure, so the split between a
 * control card and a history card is testable without React.
 * @param view - current projection value.
 * @param turn - Turn the card belongs to, when the owner declares one.
 * @returns the values rendered, plus whether this card may switch the mode
 *   (`live`) and whether it may write the handoff document (`canMemory`).
 */
export function cardState(
  view: CodingStageView,
  turn: number | undefined,
): {
  live: boolean
  mode: CodingMode
  stage: CodingStage
  verification: CodingVerificationView | null
  allowed: readonly CodingStage[]
  planItems: number
  openPlanItems: number
  edits: number
  canMemory: boolean
} {
  const turns = Array.isArray(view.turns) ? view.turns : []
  const frozen = turn === undefined ? undefined : turns.find(item => item.turn === turn)
  // A tail is published on `turn/end`, so a Turn that merely started has no
  // card; treating a newer Turn as live keeps the newest card switchable.
  const live = turn === undefined || turn >= view.latest
  const mode = (live ? view.mode : frozen?.mode ?? view.mode) as CodingMode
  const stage = (live ? view.stage : frozen?.stage ?? view.stage) as CodingStage
  const verification = (live ? view.verification : frozen?.verification ?? view.verification) ?? null
  // Freeze numbers with the rest of the turn: a history card must not show the
  // live session's plan progress or edit total.
  const numbers = live || frozen === undefined
    ? { planItems: view.planItems, openPlanItems: view.openPlanItems, edits: view.edits }
    : { planItems: frozen.planItems, openPlanItems: frozen.openPlanItems, edits: frozen.edits }
  // 只有「最新一轮 + codex + 该轮以 deliver 结束且验证通过」才提供交接文档按钮：
  // 正常完成的轮次，不是历史轮，也不是 BLOCKED 交付。
  const canMemory = live && mode === 'codex' && stage === 'deliver' && verification?.passed === true
  // A wire value from an older build may name a mode this build does not know;
  // fall back to the codex stage set instead of crashing the chat render.
  return {
    live,
    mode,
    stage,
    verification,
    allowed: STAGES_BY_MODE[mode] ?? STAGES_BY_MODE.codex,
    ...numbers,
    canMemory,
  }
}

/**
 * The command line one mode switch sends back through the Host. A card sits at
 * a closed turn's tail, and switching mode is a control action, not a prompt:
 * the silent `set` verb applies the mode and tool table without starting a
 * Turn, so the model never answers a button press. Typed `/coding <mode>` keeps
 * its "switch and open a turn" meaning.
 */
export function commandFor(mode: CodingMode): string {
  return `/coding set ${mode}`
}

/** 生成交接文档要回流 Host 的命令行。 */
export function memoryCommand(): string {
  return '/coding memory'
}

/** Read the Turn number out of the owner props. */
function turnOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const turn = (value as { turn?: unknown } | undefined)?.turn
  return typeof turn === 'number' && Number.isFinite(turn) ? turn : undefined
}

/** Verification text for one card. */
/**
 * The card's verification cell: status only, never the command. The command
 * still rides the capsule tooltip and the `run_verification` result, where a
 * reader can act on it; the 12px card row stays scannable.
 * @param verification - recorded outcome, or null before the first run.
 * @param t - locale lookup.
 * @returns the label and the color class that carries its meaning.
 */
export function verificationText(
  verification: CodingVerificationView | null,
  t: (key: CodingKey) => string,
): { text: string; className: string } {
  if (verification === null) {
    return { text: t('verification.none'), className: 'dsh-coding-value' }
  }
  return verification.passed
    ? { text: t('verification.passed'), className: 'dsh-coding-success' }
    : { text: t('verification.failed'), className: 'dsh-coding-warn' }
}

/** One card's reasoning cell, derived from the durable projection. */
export interface ReasoningDisplay {
  readonly level: ReasoningLevel | null
  readonly source: 'settings' | 'override' | 'pick' | 'auto' | 'pending'
}

/**
 * Read one override/effort slice. The state is read defensively because a wire
 * value from an older build may miss a field the current type declares.
 */
function sliceDisplay(slice: {
  override?: unknown
  userEffort?: unknown
  effort?: unknown
}): ReasoningDisplay {
  if (slice.override === 'low' || slice.override === 'high' || slice.override === 'max') {
    return { level: slice.override, source: 'override' }
  }
  if (typeof slice.userEffort === 'string' && slice.userEffort.trim() !== '') {
    return { level: levelForEffort(slice.userEffort.trim()), source: 'pick' }
  }
  if (typeof slice.effort === 'string' && slice.effort.trim() !== '') {
    return { level: levelForEffort(slice.effort.trim()), source: 'auto' }
  }
  return { level: null, source: 'pending' }
}

/**
 * The reasoning row one card renders. A closed turn keeps the state frozen at
 * its own `turn/end`, so history cards never borrow a later turn's level; an
 * unknown history turn stays pending instead of copying the live state.
 * @param state - durable reasoning projection, when the Host serves it.
 * @param turn - Turn the card belongs to.
 * @param settings - configured policy: `auto`, or a pinned level.
 */
export function reasoningDisplay(
  state: ReasoningProjectionState | undefined,
  turn: number | undefined,
  settings: unknown,
): ReasoningDisplay {
  const pinned = settings === 'low' || settings === 'high' || settings === 'max' ? settings : undefined
  if (state === undefined) {
    return pinned === undefined
      ? { level: null, source: 'pending' }
      : { level: pinned, source: 'settings' }
  }
  const turns: readonly ReasoningTurn[] = Array.isArray(state.turns) ? state.turns : []
  const frozen = turn === undefined ? undefined : turns.find(item => item.turn === turn)
  if (frozen !== undefined) {
    const display = sliceDisplay(frozen)
    // A pin labels the turn only when the turn actually ran at that level.
    return pinned !== undefined && display.level === pinned
      ? { level: pinned, source: 'settings' }
      : display
  }
  const latest = typeof state.latest === 'number' ? state.latest : 0
  if (turn !== undefined && turn < latest) return { level: null, source: 'pending' }
  if (pinned !== undefined) return { level: pinned, source: 'settings' }
  return sliceDisplay(state)
}

/** Locale key per reasoning source. */
const REASONING_SOURCE_KEY: Record<ReasoningDisplay['source'], CodingKey> = {
  settings: 'reasoning.sourceSettings',
  override: 'reasoning.sourceOverride',
  pick: 'reasoning.sourcePick',
  auto: 'reasoning.sourceAuto',
  pending: 'reasoning.pending',
}

/** Display label for a level; `Low`/`High`/`Max` are provider-level names. */
function levelLabel(level: ReasoningLevel | null): string | null {
  return level === null ? null : level === 'low' ? 'Low' : level === 'high' ? 'High' : 'Max'
}

/** The per-turn Coding control card. */
export const CodingTurnCard = memo(function CodingTurnCard(props: CodingCardProps): ReactElement | null {
  const { t } = props
  const raw = props.useProjection?.(CODING_PROJECTION_KEY)
  const reasoningRaw = props.useProjection?.(REASONING_PROJECTION_KEY)
  const view = raw === null || typeof raw !== 'object' ? undefined : raw as CodingStageView
  const [busy, setBusy] = useState<CodingMode | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 交接文档的按键状态机：idle → confirm → busy → done；失败回到 idle 并给出原因。
  const [memory, setMemory] = useState<'idle' | 'confirm' | 'busy' | 'done'>('idle')
  const [memoryError, setMemoryError] = useState<string | null>(null)
  if (view === undefined || view.active !== true) return null

  const turn = turnOf(props.turn)
  const { live, mode, stage, verification, allowed, canMemory, ...numbers } = cardState(view, turn)
  const reasoningState = reasoningRaw === null || typeof reasoningRaw !== 'object'
    ? undefined
    : reasoningRaw as ReasoningProjectionState
  const reasoning = reasoningDisplay(reasoningState, turn, props.settings?.())
  const stageIndex = allowed.indexOf(stage)
  // A wire value from a partial or older build still renders numbers.
  const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  const planItems = number(numbers.planItems)
  const openPlanItems = number(numbers.openPlanItems)
  const state = verificationText(verification, t)
  const enabled = live && busy === null
  // 模式切换失败与交接文档失败共用一个错误段落，先出现的那个优先。
  const failure = error ?? memoryError

  async function choose(next: CodingMode): Promise<void> {
    if (next === mode || busy !== null || !live) return
    setBusy(next)
    setError(null)
    try {
      const result = await props.execute?.(commandFor(next))
      if (commandRejected(result)) setError(t('card.switchFailed'))
    } catch {
      setError(t('card.switchFailed'))
    } finally {
      setBusy(null)
    }
  }

  async function writeMemory(): Promise<void> {
    if (memory === 'busy') return
    setMemory('busy')
    setMemoryError(null)
    try {
      const result = await props.execute?.(memoryCommand())
      // 没有注入 execute 也算失败：这一轮不该悄悄什么都不发生。
      if (result === undefined || commandRejected(result)) {
        setMemory('idle')
        setMemoryError(t('card.memoryFailed'))
      } else {
        setMemory('done')
      }
    } catch {
      setMemory('idle')
      setMemoryError(t('card.memoryFailed'))
    }
  }

  /** 交接文档行；`canMemory` 为假时整行不渲染。 */
  function memoryRow(): ReactElement | null {
    if (!canMemory) return null
    let content: ReactElement[]
    if (memory === 'idle') {
      content = [h('button', {
        key: 'memory-idle',
        type: 'button',
        className: 'dsh-coding-button',
        onClick: () => setMemory('confirm'),
      }, t('card.memory'))]
    } else if (memory === 'confirm') {
      content = [
        h('span', { key: 'memory-hint', className: 'dsh-coding-hint' }, t('card.memoryHint')),
        h('button', {
          key: 'memory-confirm',
          type: 'button',
          className: 'dsh-coding-button',
          onClick: () => { void writeMemory() },
        }, t('card.memoryConfirm')),
        h('button', {
          key: 'memory-cancel',
          type: 'button',
          className: 'dsh-coding-button',
          onClick: () => {
            setMemory('idle')
            setMemoryError(null)
          },
        }, t('card.memoryCancel')),
      ]
    } else if (memory === 'busy') {
      content = [h('button', {
        key: 'memory-busy',
        type: 'button',
        className: 'dsh-coding-button',
        disabled: true,
      }, t('card.memoryBusy'))]
    } else {
      content = [h('span', { key: 'memory-done', className: 'dsh-coding-success' }, t('card.memoryDone'))]
    }
    return h(
      'div',
      { className: 'dsh-coding-row', 'data-dsh-coding-memory': 'true' },
      ...content,
    )
  }

  return h(
    'div',
    {
      className: 'dsh-coding-card',
      'data-dsh-coding-card': 'true',
      'data-live': live ? 'true' : 'false',
      'aria-label': t('aria'),
    },
    h(
      'div',
      { className: 'dsh-coding-row' },
      h('span', { className: 'dsh-coding-label' }, t('card.mode')),
      h(
        'div',
        { className: 'dsh-coding-actions' },
        ...MODES.map(option => h(
          'button',
          {
            key: option,
            type: 'button',
            className: 'dsh-coding-button',
            disabled: !enabled,
            'aria-pressed': option === mode,
            onClick: () => { void choose(option) },
          },
          t(`mode.${option}` as CodingKey),
        )),
      ),
      live ? null : h('span', { className: 'dsh-coding-hint' }, t('card.stale')),
    ),
    h(
      'div',
      { className: 'dsh-coding-row' },
      h('span', { className: 'dsh-coding-label' }, t('card.stage')),
      ...allowed.flatMap((item, index) => [
        ...index === 0 ? [] : [h('span', { key: `${item}-arrow`, className: 'dsh-coding-arrow', 'aria-hidden': 'true' }, '→')],
        h(
          'span',
          {
            key: item,
            className: 'dsh-coding-stage',
            'data-current': item === stage ? 'true' : undefined,
            'data-done': index < stageIndex ? 'true' : undefined,
            'data-stage': item,
          },
          t(`stage.${item}` as CodingKey),
        ),
      ]),
      h('span', { className: 'dsh-coding-hint' }, t('card.stageHint')),
    ),
    h(
      'div',
      { className: 'dsh-coding-row' },
      h('span', { className: 'dsh-coding-label' }, t('card.reasoning')),
      h(
        'span',
        {
          className: reasoning.level === null ? 'dsh-coding-hint' : 'dsh-coding-value',
          'data-reasoning-level': reasoning.level ?? 'pending',
          'data-reasoning-source': reasoning.source,
        },
        levelLabel(reasoning.level) ?? t('reasoning.pending'),
      ),
      h('span', { className: 'dsh-coding-faint', 'aria-hidden': 'true' }, '·'),
      h('span', { className: 'dsh-coding-hint' }, t(REASONING_SOURCE_KEY[reasoning.source])),
    ),
    h(
      'div',
      { className: 'dsh-coding-row' },
      h('span', { className: 'dsh-coding-label' }, t('card.verify')),
      h('span', { className: state.className }, state.text),
      h('span', { className: 'dsh-coding-faint', 'aria-hidden': 'true' }, '·'),
      h('span', { className: 'dsh-coding-value' }, planItems === 0
        ? t('plan.none')
        : t('plan.progress')
          .replace('{done}', String(Math.max(0, planItems - openPlanItems)))
          .replace('{total}', String(planItems))),
      h('span', { className: 'dsh-coding-faint', 'aria-hidden': 'true' }, '·'),
      h('span', { className: 'dsh-coding-value' }, t('files').replace('{count}', String(number(numbers.edits)))),
      view.pending === null
        ? null
        : h('span', { className: 'dsh-coding-value' }, t('pending').replace('{tool}', view.pending.tool)),
    ),
    memoryRow(),
    failure === null ? null : h('p', { className: 'dsh-coding-error' }, failure),
  )
})
