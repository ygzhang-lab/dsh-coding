/**
 * The Conversation projection of the Coding runtime.
 *
 * Durable data source: the Session events this plugin's own tools already
 * produce. `tool/call` starts a per-turn capsule; `tool/result` carries a
 * **whole-value checkpoint** in its durable `meta`, so a history page that
 * begins after the call still renders the complete stage and verification
 * state. `turn/end` closes the turn's capsule and carries the previous turn's
 * checkpoint forward through the strictly-backward Context reader.
 *
 * Every match reports `role: 'start'` on purpose. The Assembler adopts the
 * earliest loaded start as the Context start and folds later matches through
 * `update()`, so a window that starts mid-run initializes from the newest
 * checkpoint instead of retaining a pending Context with no State.
 *
 * @module dsh-coding/client/definition
 */
import type { ConversationMatchHandler, ConversationNodeDefinition, ConversationStartMatch } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionEventLike } from '@deepseek-ai/dsh-api-session-controller/client'
import {
  asCheckpoint,
  isCodingTool,
  type CodingCheckpoint,
  type CodingMode,
  type CodingStage,
} from '../stages.js'

/** Definition kind; also the renderer key in `conversation.chat.node`. */
export const CAPSULE_KIND = 'coding-stage'

/** Chat target this Definition publishes to. */
export const CAPSULE_TARGET = 'chat'

/** Business value of one turn's capsule. */
export interface CapsuleData {
  /** Stable coding-run identity, when a checkpoint has been seen. */
  readonly runId: string
  readonly turn: number
  readonly mode: CodingMode
  readonly stage: CodingStage
  /** Complete state from the newest `tool/result` checkpoint in this Context. */
  readonly checkpoint?: CodingCheckpoint
  /** Newest checkpoint from an earlier turn, used while this turn is still running. */
  readonly inherited?: CodingCheckpoint
  /** A Coding tool is running and its result has not arrived yet. */
  readonly pending?: { readonly tool: string; readonly requested?: string; readonly at: number }
  /** No checkpoint exists in the loaded window yet: the stage is inherited or unknown. */
  readonly partial: boolean
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** Read-only Coding stage capsule, one per Turn. */
    'coding-stage': CapsuleData
  }
}

/** Context identity: one capsule per Turn. */
function contextId(turn: number): string {
  return `coding-turn-${turn}`
}

/** Extract a durable checkpoint from a `tool/result` event. */
function checkpointOf(event: SessionEventLike): CodingCheckpoint | undefined {
  if (event.type !== 'tool/result') return undefined
  const meta = (event.data as { meta?: unknown }).meta
  const checkpoint = asCheckpoint(meta)
  if (checkpoint === undefined) return undefined
  // The turn in `meta` must agree with the event's own coordinates: a
  // checkpoint from a different turn would place the capsule on the wrong row.
  const turn = (event.data as { turn?: unknown }).turn
  if (typeof turn === 'number' && checkpoint.turn !== turn) return undefined
  return checkpoint
}

/** Extract the requested stage or mode from one Coding tool call's arguments. */
function requestedOf(event: SessionEventLike): { tool: string; requested?: string; turn: number } | undefined {
  if (event.type !== 'tool/call') return undefined
  const data = event.data as { name?: unknown; arguments?: unknown; turn?: unknown }
  if (typeof data.name !== 'string' || !isCodingTool(data.name)) return undefined
  if (typeof data.turn !== 'number') return undefined
  let requested: string | undefined
  if (typeof data.arguments === 'string') {
    try {
      const parsed = JSON.parse(data.arguments) as Record<string, unknown> | null
      if (typeof parsed === 'object' && parsed !== null) {
        if (typeof parsed['stage'] === 'string') requested = parsed['stage']
        else if (typeof parsed['mode'] === 'string') requested = parsed['mode']
        else if (typeof parsed['kind'] === 'string') requested = parsed['kind']
      }
    } catch {
      // Unparseable arguments still identify the call by tool name.
    }
  }
  return { tool: data.name, ...requested === undefined ? {} : { requested }, turn: data.turn }
}

/** The turn a `turn/end` event closes. */
function endedTurn(event: SessionEventLike): number | undefined {
  if (event.type !== 'turn/end') return undefined
  const turn = (event.data as { turn?: unknown }).turn
  return typeof turn === 'number' ? turn : undefined
}

/** Data built from one complete checkpoint. */
function fromCheckpoint(checkpoint: CodingCheckpoint, inherited?: CodingCheckpoint): CapsuleData {
  return {
    runId: checkpoint.runId,
    turn: checkpoint.turn,
    mode: checkpoint.mode,
    stage: checkpoint.stage,
    checkpoint,
    ...inherited === undefined ? {} : { inherited },
    partial: false,
  }
}

/** Data built from a call whose result is still outstanding. */
function fromCall(
  call: { tool: string; requested?: string; turn: number },
  at: number,
  previous?: CodingCheckpoint,
): CapsuleData {
  return {
    runId: previous?.runId ?? '',
    turn: call.turn,
    mode: previous?.mode ?? 'auto',
    stage: previous?.stage ?? 'requirements',
    ...previous === undefined ? {} : { inherited: previous },
    pending: { tool: call.tool, ...call.requested === undefined ? {} : { requested: call.requested }, at },
    partial: true,
  }
}

/** Turn-end data: keep what this Context knows, otherwise inherit the last checkpoint. */
function fromTurnEnd(turn: number, previous?: CodingCheckpoint, current?: CapsuleData): CapsuleData {
  if (current !== undefined) {
    // The turn is over: a call whose result never arrived is no longer pending.
    const { pending: _pending, ...rest } = current
    return { ...rest, partial: current.checkpoint === undefined && previous === undefined }
  }
  if (previous !== undefined) {
    return {
      ...fromCheckpoint(previous, previous),
      turn,
      partial: false,
    }
  }
  return { runId: '', turn, mode: 'auto', stage: 'requirements', partial: true }
}

/** Event router: the durable Coding events this plugin produces. */
const match: ConversationMatchHandler = (event) => {
  const checkpoint = checkpointOf(event)
  if (checkpoint !== undefined) return { id: contextId(checkpoint.turn), role: 'start' }
  const call = requestedOf(event)
  if (call !== undefined) return { id: contextId(call.turn), role: 'start' }
  const turn = endedTurn(event)
  if (turn !== undefined) return { id: contextId(turn), role: 'start' }
  return null
}

/** The Coding capsule Definition. */
export const capsuleDefinition: ConversationNodeDefinition<CapsuleData> = {
  kind: CAPSULE_KIND,
  target: CAPSULE_TARGET,
  match,
  start(context, matchResult, reader): CapsuleData {
    const event = matchResult.event
    const checkpoint = checkpointOf(event)
    if (checkpoint !== undefined) return fromCheckpoint(checkpoint)
    const call = requestedOf(event)
    if (call !== undefined) {
      const previous = reader.previous<CapsuleData>(CAPSULE_KIND)?.state.checkpoint
      return fromCall(call, event.time, previous)
    }
    const turn = endedTurn(event)
    const previous = reader.previous<CapsuleData>(CAPSULE_KIND)?.state.checkpoint
    return fromTurnEnd(turn ?? 0, previous)
  },
  update(context, updateMatch): CapsuleData {
    const event = updateMatch.event
    const current = context.state
    const checkpoint = checkpointOf(event)
    if (checkpoint !== undefined) return fromCheckpoint(checkpoint, current.inherited)
    const call = requestedOf(event)
    if (call !== undefined) {
      return { ...current, ...fromCall(call, event.time, current.checkpoint ?? current.inherited) }
    }
    const turn = endedTurn(event)
    if (turn !== undefined) {
      return fromTurnEnd(turn, current.checkpoint ?? current.inherited, current)
    }
    return current
  },
  buildViewNode(context): ChatNode<'coding-stage'> | null {
    const data = context.state
    const startMatch: ConversationStartMatch | undefined = context.start
    if (data === undefined || startMatch === undefined) return null
    return {
      key: context.key,
      kind: CAPSULE_KIND,
      id: context.id,
      target: CAPSULE_TARGET,
      anchorSeq: startMatch.event.seq,
      location: startMatch.location,
      visibility: 'visible',
      data,
    }
  },
}
