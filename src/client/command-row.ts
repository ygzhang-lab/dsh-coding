/**
 * One `/coding` command receipt in the Chat flow.
 *
 * Mode switching is already visible where it belongs: the blank-hero picker
 * highlights the chosen mode, the newest turn card shows it as `aria-pressed`,
 * and the next stage capsule records it. Repeating that as a command card in
 * the transcript adds nothing and — before this row existed — a failed switch
 * left a red error card behind. So `/coding set <mode>` and the bare
 * `/coding <mode>` switch render nothing here: the change reads off the
 * controls, not the transcript.
 *
 * Every other `/coding` line still renders one plain status line — the command
 * and its own text — because a status query or a stage move is worth keeping.
 *
 * @module dsh-coding/client/command-row
 */
import { createElement as h, memo } from 'react'

/** The `CommandNode` fields this row reads (owner props pass the whole node). */
export interface CodingCommandNode {
  readonly name?: string | null
  readonly args?: string | null
  readonly outcome?: { readonly kind: string; readonly text?: string } | null
}

/** The modes a bare `/coding <mode>` switches to, in roster order. */
const SWITCH_WORDS: readonly string[] = ['auto', 'consult', 'review', 'codex']

/** What one command receipt renders. */
export interface CodingCommandRowView {
  /** Whether this command leaves no trace in the transcript at all. */
  readonly hidden: boolean
  /** The command line as the user typed it. */
  readonly line: string
  /** The receipt text, or null when there is nothing to say. */
  readonly text: string | null
  /** Whether the receipt is an error. */
  readonly failed: boolean
}

/**
 * Decide what one command receipt renders. Pure, so the hiding rule — the whole
 * point of this module — is testable without a renderer.
 * @param node - the `CommandNode` the Chat owner passes down.
 * @returns the visible/absent split for this receipt.
 */
export function commandRowOf(node: CodingCommandNode): CodingCommandRowView {
  const line = `/${node.name ?? 'coding'}${node.args ?? ''}`
  const words = (node.args ?? '').trim().toLowerCase().split(/\s+/u).filter(Boolean)
  // A mode switch: either the silent `set <mode>` or the bare switch command.
  const switches = words[0] === 'set'
    || (words.length === 1 && SWITCH_WORDS.includes(words[0]))
  if (switches) return { hidden: true, line, text: null, failed: false }

  const outcome = node.outcome
  // A command that has not settled yet has no body worth a row.
  if (outcome == null) return { hidden: true, line, text: null, failed: false }

  const text = typeof outcome.text === 'string' && outcome.text.length > 0 ? outcome.text : null
  return { hidden: false, line, text, failed: outcome.kind === 'error' }
}

/**
 * Whether a commands Remote result is a command-level failure.
 *
 * Two shapes mean failure: the Remote itself failed (`{ ok: false }`), or the
 * Remote succeeded while the command handler rejected the line
 * (`{ ok: true, value: { result: { kind: 'error' } } }`). Only the first used to
 * be checked, so a rejected switch looked like a success.
 * @param result - whatever `remote.commands.execute()` returned.
 * @returns true when the command did not apply.
 */
export function commandRejected(result: unknown): boolean {
  if (result === null || typeof result !== 'object') return false
  if ((result as { ok?: unknown }).ok === false) return true
  const value = (result as { value?: unknown }).value
  if (value === null || typeof value !== 'object') return false
  const inner = (value as { result?: unknown }).result
  if (inner === null || typeof inner !== 'object') return false
  return (inner as { kind?: unknown }).kind === 'error'
}

/** One `/coding` command receipt, or nothing for a mode switch. */
export const CodingCommandRow = memo(function CodingCommandRow(
  props: { readonly node: CodingCommandNode },
) {
  const view = commandRowOf(props.node)
  if (view.hidden) return null
  return h('div', {
    className: 'dsh-coding-command',
    'data-command': props.node.name ?? 'coding',
    ...view.failed ? { 'data-error': 'true' } : {},
  },
  h('span', { className: 'dsh-coding-label' }, view.line),
  view.text === null
    ? null
    : h('span', { className: view.failed ? 'dsh-coding-error' : 'dsh-coding-value' }, view.text))
})
