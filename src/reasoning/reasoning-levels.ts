/**
 * The three Coding reasoning levels and the pure mapping between a level and a
 * provider effort id.
 *
 * Dependency-free on purpose: the Host controller and the browser card both
 * import this module, so it must never pull in a Node-only package.
 *
 * @module dsh-coding/reasoning/reasoning-levels
 */

/** The three Coding levels a decision can name. */
export type ReasoningLevel = 'low' | 'high' | 'max'

/** Rank a level so plan growth can only escalate inside one turn. */
export function rank(level: ReasoningLevel): number {
  return level === 'low' ? 1 : level === 'high' ? 2 : 3
}

export function higher(a: ReasoningLevel, b: ReasoningLevel): ReasoningLevel {
  return rank(a) >= rank(b) ? a : b
}

/**
 * Map a provider effort id back to the Coding level it stands for. The chat
 * box reports provider ids (`minimal`, `medium`, `xhigh`), while this preset
 * reasons in `low`/`high`/`max`; unknown ids stay at the conservative default.
 */
export function levelForEffort(effort: string): ReasoningLevel {
  if (effort === 'max' || effort === 'xhigh') return 'max'
  if (effort === 'high' || effort === 'medium') return 'high'
  return 'low'
}
