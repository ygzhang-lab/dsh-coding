/**
 * Durable per-session view of the Coding runtime, folded from the Session log.
 *
 * The conversation card and any other client surface read this projection
 * instead of the Host's in-memory stage machine, so a reloaded session shows
 * the same mode, stage, plan, and verification the runtime used. Folding only
 * the events DSH already appends is deliberate: `Session.append()` refuses a
 * plugin-invented event type on reopen, so this module never writes.
 *
 * Events that move the state:
 * - `agent-preset/selected` — whether this is a Coding session at all;
 * - `tool/call` — a Coding verb started (shown as pending);
 * - `tool/result.meta` — the whole-value checkpoint every Coding tool attaches;
 * - `command/run` — `/coding <mode>` and `/coding stage <name>` from the UI;
 * - `todo/write` — the durable task list, restored with the checkpoint on resume;
 * - `turn/end` — freezes one turn's card so history never rewrites itself.
 *
 * The module is dependency-free and browser-safe: the client half imports the
 * key and the view type, the Host half registers the fold.
 *
 * @module dsh-coding/projections/coding-projection
 */
import type { SessionProjectionSummaryExcluded } from '@deepseek-ai/dsh-session-projection/types'
import {
  STAGES_BY_MODE,
  asCheckpoint,
  asStage,
  entryStage,
  isCodingTool,
  stageInMode,
  type CodingCheckpoint,
  type CodingMode,
  type CodingStage,
} from '../core/stages.js'

/** Projection key shared by the Host fold and every client reader. */
export const CODING_PROJECTION_KEY = 'dshCodingStage' as const

/** Preset id this bundle declares in `cordis.patch.yml`. */
export const CODING_PRESET_ID = 'dsh-coding'

/** How many closed turns one projection keeps; older cards fall back to live state. */
const MAX_TURNS = 60

/** Verification evidence reduced to what the card shows. */
export interface CodingVerificationView {
  readonly passed: boolean
  readonly kind: string
  readonly scope: string
  readonly command: string
  readonly failedTests: readonly string[]
  readonly ranAt: number
}

/** One closed turn, frozen so a later switch never rewrites history. */
export interface CodingTurnView {
  readonly turn: number
  readonly mode: CodingMode
  readonly stage: CodingStage
  readonly verification: CodingVerificationView | null
  /** Frozen plan progress at this turn's end. */
  readonly planItems: number
  readonly openPlanItems: number
  /** Frozen session edit total at this turn's end. */
  readonly edits: number
}

/** One durable task-list entry, as `todo_write` recorded it. */
export interface CodingPlanItemView {
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed'
}

/** The whole projection value: one session's current Coding state. */
export interface CodingStageView {
  /** True only for a user-facing session running the `dsh-coding` preset. */
  readonly active: boolean
  readonly mode: CodingMode
  readonly stage: CodingStage
  /** Stages this mode opens, in forward order. */
  readonly allowedStages: readonly CodingStage[]
  readonly planItems: number
  readonly openPlanItems: number
  readonly edits: number
  readonly verification: CodingVerificationView | null
  /** Newest whole-value checkpoint in the log, or null before the first Coding tool result. */
  readonly checkpoint: CodingCheckpoint | null
  /** Latest durable task list; restored with the checkpoint on a resume. */
  readonly plan: readonly CodingPlanItemView[]
  /** A Coding verb is running and its result has not arrived yet. */
  readonly pending: {
    readonly tool: string
    readonly requested: string | null
    /** Provider call id, so another tool's result cannot clear this label. */
    readonly callId: string | null
  } | null
  /** Newest closed turn; only that turn's card is a control. */
  readonly latest: number
  readonly turns: readonly CodingTurnView[]
  readonly updatedAt: number
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Coding stage, mode, plan, and verification of one session. */
    dshCodingStage: SessionProjectionSummaryExcluded<CodingStageView>
  }
}

/** The slice of a Session header this fold needs. */
interface HeaderLike {
  readonly agentPreset?: unknown
  readonly delegationDepth?: unknown
}

/** The slice of a Session event this fold needs. */
interface EventLike {
  readonly type?: unknown
  readonly time?: unknown
  readonly data?: any
}

/** Whether a session header names this bundle's user-facing preset. */
export function isCodingSession(header: HeaderLike | undefined): boolean {
  return header?.agentPreset === CODING_PRESET_ID
    && (typeof header.delegationDepth === 'number' ? header.delegationDepth : 0) === 0
}

/** Projection value before any event is folded. */
export function initialView(defaultMode: CodingMode): CodingStageView {
  return {
    active: false,
    mode: defaultMode,
    stage: entryStage(defaultMode),
    allowedStages: STAGES_BY_MODE[defaultMode],
    planItems: 0,
    openPlanItems: 0,
    edits: 0,
    verification: null,
    checkpoint: null,
    plan: [],
    pending: null,
    latest: 0,
    turns: [],
    updatedAt: 0,
  }
}

/** Reduced verification evidence, or null. */
function verificationOf(value: unknown): CodingVerificationView | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v['passed'] !== 'boolean') return null
  return {
    passed: v['passed'],
    kind: typeof v['kind'] === 'string' ? v['kind'] : '',
    scope: typeof v['scope'] === 'string' ? v['scope'] : '',
    command: typeof v['command'] === 'string' ? v['command'] : '',
    failedTests: Array.isArray(v['failedTests'])
      ? v['failedTests'].filter((item): item is string => typeof item === 'string')
      : [],
    ranAt: typeof v['ranAt'] === 'number' ? v['ranAt'] : 0,
  }
}

/** The stage or mode a Coding tool call is asking for, for the pending label. */
function requestedOf(tool: string, raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let parsed: Record<string, unknown>
  try {
    const value = JSON.parse(raw) as unknown
    if (typeof value !== 'object' || value === null) return null
    parsed = value as Record<string, unknown>
  } catch {
    return null
  }
  for (const key of ['stage', 'mode', 'kind']) {
    const candidate = parsed[key]
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return null
}

/** A mode value, when the checkpoint or command args name one. */
function modeOf(value: unknown): CodingMode | undefined {
  return value === 'auto' || value === 'consult' || value === 'review' || value === 'codex' ? value : undefined
}

/** A stage value, when the command args name one. */
function stageOf(value: unknown): CodingStage | undefined {
  return asStage(value)
}

/** One task-list status value, or undefined when the event did not record one. */
function planStatusOf(item: unknown): CodingPlanItemView['status'] | undefined {
  const status = (item as { status?: unknown }).status
  return status === 'pending' || status === 'in_progress' || status === 'completed' ? status : undefined
}

/**
 * Fold one committed Session event into the projection.
 * @param state - value covering every earlier event.
 * @param event - next committed event.
 * @param defaultMode - configured mode, used when a session switches preset mid-flight.
 * @returns the next value; the same reference when the event is unrelated.
 */
export function applyEvent(
  state: CodingStageView,
  event: EventLike,
  defaultMode: CodingMode,
): CodingStageView {
  const data = event.data
  switch (event.type) {
    case 'agent-preset/selected': {
      if (typeof data?.agentPreset !== 'string') return state
      const active = data.agentPreset === CODING_PRESET_ID
      if (active === state.active) return state
      if (!active) return { ...state, active: false }
      // Joining the preset mid-session: reset to the configured entry state.
      return {
        ...state,
        active: true,
        mode: defaultMode,
        stage: entryStage(defaultMode),
        allowedStages: STAGES_BY_MODE[defaultMode],
        checkpoint: null,
        plan: [],
        planItems: 0,
        openPlanItems: 0,
        edits: 0,
        verification: null,
        pending: null,
      }
    }
    case 'tool/call': {
      const name = data?.name
      if (typeof name !== 'string' || !isCodingTool(name)) return state
      return {
        ...state,
        pending: {
          tool: name,
          requested: requestedOf(name, data?.arguments),
          callId: typeof data?.callId === 'string' ? data.callId : null,
        },
        updatedAt: typeof event.time === 'number' ? event.time : state.updatedAt,
      }
    }
    case 'tool/result': {
      // A checkpoint is whole-value, so it is adopted even when the matching
      // `tool/call` sits before the loaded window (history paging) or the fold
      // resumed from a persisted cache.
      const checkpoint = asCheckpoint(data?.meta)
      const sameCall = state.pending !== null
        && (state.pending.callId === null
          || state.pending.callId === data?.message?.toolCallId)
      if (checkpoint === undefined) {
        return sameCall ? { ...state, pending: null } : state
      }
      return {
        ...state,
        mode: checkpoint.mode,
        stage: checkpoint.stage,
        allowedStages: checkpoint.allowedStages,
        planItems: checkpoint.planItems,
        openPlanItems: checkpoint.openPlanItems,
        edits: checkpoint.edits,
        verification: verificationOf(checkpoint.verification),
        checkpoint,
        pending: sameCall || state.pending === null ? null : state.pending,
        updatedAt: checkpoint.updatedAt,
      }
    }
    case 'command/run': {
      if (data?.name !== 'coding') return state
      const args = typeof data?.args === 'string' ? data.args.trim().toLowerCase() : ''
      const [head, ...rest] = args.split(/\s+/u)
      if (head === 'stage') {
        const target = stageOf(rest.join(' '))
        // A stage the mode does not open was refused by the live gate; folding
        // the requested value would make the card show a stage that never ran.
        if (target === undefined || !stageInMode(state.mode, target)) return state
        return { ...state, stage: target }
      }
      // `/coding set <mode>` is the silent pre-Turn picker path; `/coding <mode>`
      // is the Turn-scoped switch. Both move the same card state.
      if (head === 'set') {
        const mode = modeOf(rest.join(' '))
        if (mode === undefined) return state
        return {
          ...state,
          mode,
          stage: stageInMode(mode, state.stage) ? state.stage : entryStage(mode),
          allowedStages: STAGES_BY_MODE[mode],
        }
      }
      const mode = modeOf(head)
      if (mode === undefined) return state
      return {
        ...state,
        mode,
        stage: stageInMode(mode, state.stage) ? state.stage : entryStage(mode),
        allowedStages: STAGES_BY_MODE[mode],
      }
    }
    case 'todo/write': {
      const todos = data?.todos
      if (!Array.isArray(todos)) return state
      const plan: CodingPlanItemView[] = []
      for (const item of todos) {
        if (typeof item !== 'object' || item === null) continue
        const content = (item as { content?: unknown }).content
        const status = planStatusOf(item)
        if (typeof content === 'string' && status !== undefined) plan.push({ content, status })
      }
      return {
        ...state,
        plan,
        planItems: plan.length,
        openPlanItems: plan.filter(item => item.status !== 'completed').length,
        updatedAt: typeof event.time === 'number' ? event.time : state.updatedAt,
      }
    }
    case 'turn/start': {
      // A new turn means no earlier call can still be running.
      return state.pending === null ? state : { ...state, pending: null }
    }
    case 'turn/end': {
      const turn = data?.turn
      if (typeof turn !== 'number' || !Number.isFinite(turn)) return state
      const latest = Math.max(state.latest, turn)
      const frozen: CodingTurnView = {
        turn,
        mode: state.mode,
        stage: state.stage,
        verification: state.verification,
        planItems: state.planItems,
        openPlanItems: state.openPlanItems,
        edits: state.edits,
      }
      const turns = [...state.turns.filter(item => item.turn !== turn), frozen].slice(-MAX_TURNS)
      return { ...state, latest, turns, pending: null }
    }
    default:
      return state
  }
}

/** Throw a helpful error for a value that cannot be a projection state. */
function invalid(what: string): never {
  throw new Error(`dsh-coding: ${what} is not a Coding stage projection value`)
}

/** Validate one persisted or wire value as {@link CodingStageView}. */
export function parseView(value: unknown): CodingStageView {
  if (typeof value !== 'object' || value === null) invalid('state')
  const v = value as Record<string, unknown>
  if (typeof v['active'] !== 'boolean') invalid('active')
  const mode = modeOf(v['mode']) ?? invalid('mode')
  const stage = stageOf(v['stage']) ?? invalid('stage')
  if (!Array.isArray(v['allowedStages'])) invalid('allowedStages')
  if (!Array.isArray(v['turns'])) invalid('turns')
  const numeric = ['planItems', 'openPlanItems', 'edits', 'latest', 'updatedAt'] as const
  for (const key of numeric) if (typeof v[key] !== 'number') invalid(key)
  return {
    active: v['active'],
    mode,
    stage,
    allowedStages: (v['allowedStages'] as unknown[]).map(item => stageOf(item) ?? invalid('allowedStages')),
    planItems: v['planItems'] as number,
    openPlanItems: v['openPlanItems'] as number,
    edits: v['edits'] as number,
    verification: verificationOf(v['verification']),
    checkpoint: asCheckpoint(v['checkpoint']) ?? null,
    plan: (Array.isArray(v['plan']) ? v['plan'] : []).map((item) => {
      if (typeof item !== 'object' || item === null) invalid('plan')
      const entry = item as Record<string, unknown>
      const status = planStatusOf(entry) ?? invalid('plan.status')
      const content = entry['content']
      if (typeof content !== 'string') invalid('plan.content')
      return { content, status }
    }),
    pending: pendingOf(v['pending']),
    latest: v['latest'] as number,
    updatedAt: v['updatedAt'] as number,
    turns: (v['turns'] as unknown[]).map((item) => {
      if (typeof item !== 'object' || item === null) invalid('turns')
      const turn = item as Record<string, unknown>
      return {
        turn: typeof turn['turn'] === 'number' ? turn['turn'] : invalid('turns.turn'),
        mode: modeOf(turn['mode']) ?? invalid('turns.mode'),
        stage: stageOf(turn['stage']) ?? invalid('turns.stage'),
        planItems: typeof turn['planItems'] === 'number' ? turn['planItems'] : invalid('turns.planItems'),
        openPlanItems: typeof turn['openPlanItems'] === 'number' ? turn['openPlanItems'] : invalid('turns.openPlanItems'),
        edits: typeof turn['edits'] === 'number' ? turn['edits'] : invalid('turns.edits'),
        verification: verificationOf(turn['verification']),
      }
    }),
  }
}

/** Validate a pending label, or null. */
function pendingOf(value: unknown): CodingStageView['pending'] {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') invalid('pending')
  const pending = value as Record<string, unknown>
  if (typeof pending['tool'] !== 'string') invalid('pending.tool')
  return {
    tool: pending['tool'],
    requested: typeof pending['requested'] === 'string' ? pending['requested'] : null,
    callId: typeof pending['callId'] === 'string' ? pending['callId'] : null,
  }
}

/** The tiny validator face the projection registry uses (`parse` only). */
interface ParseFace<T> {
  parse(value: unknown): T
}

/**
 * Build the registrable projection definition.
 *
 * `defaultMode` is read lazily: the projection is folded during Session opens
 * that can happen long after mount, and a page edit must apply to the next one.
 *
 * @param defaultMode - configured initial mode for a Coding session.
 * @returns definition object accepted by `ctx.sessionProjections.register`.
 */
export function codingProjection(defaultMode: () => CodingMode): {
  key: typeof CODING_PROJECTION_KEY
  stateVersion: number
  stateSchema: ParseFace<CodingStageView>
  init: (header: HeaderLike | undefined) => CodingStageView
  apply: (state: CodingStageView, event: EventLike) => CodingStageView
  wire: {
    viewSchema: ParseFace<CodingStageView>
    view: (state: CodingStageView) => CodingStageView
    summary: boolean
  }
} {
  const mode = (): CodingMode => modeOf(defaultMode()) ?? 'auto'
  return {
    key: CODING_PROJECTION_KEY,
    // Bump when the fold's meaning changes: the persisted cache replays the
    // suffix on top of a validated state, so an old checkpoint must be dropped.
    // v2 added the whole-value checkpoint and the task-list snapshot a resume reads.
    // v3 freezes plan progress and the edit total in every turn snapshot, so an
    // old cache must be rebuilt or a history card cannot read those fields.
    // v4 renames the first stage `recon` → `requirements`; legacy persisted values
    // still parse through asStage, but the cache is rebuilt to drop the old id.
    stateVersion: 4,
    stateSchema: { parse: parseView },
    init: (header) => ({
      ...initialView(mode()),
      active: isCodingSession(header),
    }),
    apply: (state, event) => applyEvent(state, event, mode()),
    wire: {
      viewSchema: { parse: parseView },
      view: state => state,
      // The tuple of closed turns is per-session detail; keeping it out of
      // summaries avoids copying it into every Session-list row.
      summary: false,
    },
  }
}
