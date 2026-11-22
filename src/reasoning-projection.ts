/**
 * Durable per-session reasoning choice.
 *
 * The Host's own `modelSelection` projection records what a model request used,
 * but it cannot say whether an effort came from the chat box or from this
 * plugin's automatic write: both call `agent.model.select()`. This unit keeps
 * the two decisions apart — an explicit session override and the effort the
 * user picked in the chat box — and suppresses the plugin's own writes while a
 * turn is running.
 *
 * It also freezes, per closed turn, the reasoning state that turn actually ran
 * under, so a history card never borrows a later turn's level.
 *
 * Host-only state would be enough for the controller, but the controller reads
 * projections through `sessionProjections.snapshot()`, which computes
 * client-visible units only, and the card reads this state directly, so the
 * unit keeps a pass-through wire view.
 *
 * @module dsh-coding/reasoning-projection
 */
import type { SessionProjectionSummaryExcluded } from '@deepseek-ai/dsh-session-projection/types'
import type { ReasoningLevel } from './reasoning-levels.js'

/** Projection key shared by the Host fold and the Web card. */
export const REASONING_PROJECTION_KEY = 'dshCodingReasoning' as const

/** The reasoning state one closed turn ran under, for its own card. */
export interface ReasoningTurn {
  readonly turn: number
  /** Level pinned via `coding_reasoning`; null when automatic. */
  readonly override: ReasoningLevel | null
  /** Effort the user picked in the chat box, verbatim. */
  readonly userEffort: string | null
  /** Provider effort id from the most recent request header, verbatim. */
  readonly effort: string | null
}

/** The durable reasoning choice of one session. */
export interface ReasoningProjectionState {
  /** Level pinned by `coding_reasoning`; null when automatic. */
  readonly override: ReasoningLevel | null
  /**
   * Effort the user picked in the chat box (`model/selection`), verbatim. It
   * wins over the automatic classifier until the user changes it again or a
   * `coding_reasoning` call replaces it.
   */
  readonly userEffort: string | null
  /** Provider effort id from the most recent request header, verbatim. */
  readonly effort: string | null
  /**
   * True while a turn is open. This plugin writes its automatic level through
   * `model/selection`, the same event the chat box uses; an effort-bearing
   * selection folded while a turn is running is that automatic write, not a
   * user pick. A selection without an effort is always an explicit hand-back
   * to automatic — this plugin never writes one — so it folds even mid-turn.
   */
  readonly running: boolean
  /** Highest turn the log has reached; its card reads the live state. */
  readonly latest: number
  /** Reasoning state as of each completed turn, oldest first. */
  readonly turns: readonly ReasoningTurn[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    dshCodingReasoning: SessionProjectionSummaryExcluded<ReasoningProjectionState>
  }
}

/** Bound the history the state carries; older cards fall back to pending. */
const MAX_TURNS = 100

function isLevel(value: unknown): value is ReasoningLevel {
  return value === 'low' || value === 'high' || value === 'max'
}

/** Numeric `turn/start` and `turn/end` payloads; anything else is ignored. */
function eventTurn(event: unknown): number | undefined {
  const value = (event as { data?: { turn?: unknown } })?.data?.turn
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Read a session override from a `coding_reasoning` tool call's JSON arguments. */
export function overrideFromToolArguments(
  raw: unknown,
): ReasoningLevel | 'auto' | undefined {
  if (typeof raw !== 'string') return undefined
  try {
    const parsed = JSON.parse(raw) as { effort?: unknown } | null
    const value = parsed?.effort
    if (value === 'auto') return 'auto'
    return isLevel(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** Effort id the user picked in the chat box; `model/selection` owns it. */
function effortFromSelection(event: unknown): string | null | undefined {
  const value = event as {
    type?: string
    data?: { reasoningEffort?: unknown }
  }
  if (value.type !== 'model/selection') return undefined
  const effort = value.data?.reasoningEffort
  if (typeof effort !== 'string') return null
  const trimmed = effort.trim()
  return trimmed === '' ? null : trimmed
}

/** Effort id written into the request header; absent or blank means none. */
function effortFromHeader(event: unknown): string | null | undefined {
  const value = event as {
    type?: string
    data?: { header?: { config?: { reasoningEffort?: unknown } } }
  }
  if (value.type !== 'request/header') return undefined
  const effort = value.data?.header?.config?.reasoningEffort
  if (typeof effort !== 'string') return null
  const trimmed = effort.trim()
  return trimmed === '' ? null : trimmed
}

/** Validate one persisted or wire value as {@link ReasoningProjectionState}. */
function parseState(value: unknown): ReasoningProjectionState {
  if (typeof value !== 'object' || value === null) {
    throw new Error('dsh-coding: reasoning projection state is not an object')
  }
  const v = value as Record<string, unknown>
  const override = v['override']
  if (override !== null && !isLevel(override)) {
    throw new Error('dsh-coding: reasoning projection override is not a level')
  }
  const userEffort = v['userEffort']
  if (userEffort !== null && typeof userEffort !== 'string') {
    throw new Error('dsh-coding: reasoning projection userEffort is not a string')
  }
  const effort = v['effort']
  if (effort !== null && typeof effort !== 'string') {
    throw new Error('dsh-coding: reasoning projection effort is not a string')
  }
  if (typeof v['running'] !== 'boolean') {
    throw new Error('dsh-coding: reasoning projection running is not a boolean')
  }
  const latest = v['latest']
  if (typeof latest !== 'number' || !Number.isFinite(latest)) {
    throw new Error('dsh-coding: reasoning projection latest is not a number')
  }
  const turns = v['turns']
  if (!Array.isArray(turns)) {
    throw new Error('dsh-coding: reasoning projection turns is not an array')
  }
  return {
    override,
    userEffort,
    effort,
    running: v['running'],
    latest,
    turns: turns.map((item) => {
      if (typeof item !== 'object' || item === null) {
        throw new Error('dsh-coding: reasoning projection turn is not an object')
      }
      const t = item as Record<string, unknown>
      const turn = t['turn']
      if (typeof turn !== 'number' || !Number.isFinite(turn)) {
        throw new Error('dsh-coding: reasoning projection turn.turn is not a number')
      }
      const tOverride = t['override']
      if (tOverride !== null && !isLevel(tOverride)) {
        throw new Error('dsh-coding: reasoning projection turn.override is not a level')
      }
      const tUserEffort = t['userEffort']
      if (tUserEffort !== null && typeof tUserEffort !== 'string') {
        throw new Error('dsh-coding: reasoning projection turn.userEffort is not a string')
      }
      const tEffort = t['effort']
      if (tEffort !== null && typeof tEffort !== 'string') {
        throw new Error('dsh-coding: reasoning projection turn.effort is not a string')
      }
      return { turn, override: tOverride, userEffort: tUserEffort, effort: tEffort }
    }),
  }
}

export const reasoningProjection = {
  key: REASONING_PROJECTION_KEY,
  // v2 adds the request-header effort and the per-turn snapshots the card
  // freezes; a cached v1 state must be discarded and rebuilt.
  stateVersion: 2,
  stateSchema: { parse: parseState },
  init: (): ReasoningProjectionState => ({
    override: null,
    userEffort: null,
    effort: null,
    running: false,
    latest: 0,
    turns: [],
  }),
  apply: (state: ReasoningProjectionState, event: unknown): ReasoningProjectionState => {
    const value = event as {
      type?: string
      data?: { name?: string; arguments?: unknown; args?: unknown }
    }
    if (value.type === 'tool/call' && value.data?.name === 'coding_reasoning') {
      const override = overrideFromToolArguments(value.data.arguments ?? value.data.args)
      if (override === undefined) return state
      const next = override === 'auto' ? null : override
      // An explicit tool decision replaces whatever the chat box picked.
      return next === state.override && state.userEffort === null
        ? state
        : { ...state, override: next, userEffort: null }
    }
    const picked = effortFromSelection(event)
    if (picked !== undefined) {
      // `agent.model.select()` writes `model/selection` too. Folding this
      // plugin's own automatic level as a chat-box pick would pin `auto`
      // forever, so an effort-bearing selection only counts while no turn is
      // open. An effort-less one is the explicit "back to automatic": this
      // plugin never produces it, so it stays meaningful mid-turn.
      if (state.running && picked !== null) return state
      return picked === state.userEffort && state.override === null
        ? state
        : { ...state, userEffort: picked, override: null }
    }
    const effort = effortFromHeader(event)
    if (effort !== undefined) {
      return effort === state.effort ? state : { ...state, effort }
    }
    const turn = eventTurn(event)
    if (turn !== undefined && (value.type === 'turn/start' || value.type === 'turn/end')) {
      if (value.type === 'turn/start') {
        return state.running ? state : { ...state, running: true }
      }
      // Snapshot the reasoning state when a turn closes: its card must keep
      // the level that turn actually used, while later turns move on.
      const latest = Math.max(state.latest, turn)
      const turns = [
        ...state.turns.filter((item) => item.turn !== turn),
        { turn, override: state.override, userEffort: state.userEffort, effort: state.effort },
      ].slice(-MAX_TURNS)
      return { ...state, latest, turns, running: false }
    }
    return state
  },
  wire: {
    // Every value must be lossless JSON: the Host forwards this block inside
    // `api-session/added`.
    viewSchema: { parse: parseState },
    view: (state: ReasoningProjectionState): ReasoningProjectionState => state,
    // Per-session detail; keeping it out of summaries avoids copying it into
    // every Session-list row.
    summary: false,
  },
}
