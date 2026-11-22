/**
 * Message sources and constructors this plugin contributes to the model-visible
 * surface. Declaring the source kinds here (rather than inventing a user prompt)
 * is what keeps an injected stage fragment and a control notice distinguishable
 * from a real human message in derived history.
 *
 * @module dsh-coding/messages
 */
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, UserMessage } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Per-step stage contract injected by the Coding runtime. */
    'dsh-coding-stage': { kind: 'dsh-coding-stage' } & ContextFormed
    /** A control notice produced by `/coding` and by the stage machine. */
    'dsh-coding-control': { kind: 'dsh-coding-control' } & ContextFormed
  }
}

/** The one-line summary bound of a context notice. */
const SUMMARY_MAX = 120

/**
 * Build the per-step stage context message.
 * @param text - complete stage fragment.
 * @param summary - one-line account shown without expanding the row.
 * @returns an immutable user-role context message.
 */
export function stageMessage(text: string, summary: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'dsh-coding-stage',
      form: 'notice',
      summary: boundContextSummary(summary.slice(0, SUMMARY_MAX)),
    },
  })
}

/**
 * Build a control notice delivered by `agent.followup()` or `agent.steer()`.
 * @param text - what the runtime decided and what the model should do.
 * @param summary - one-line account for the conversation row.
 * @returns an immutable user-role context message.
 */
export function controlMessage(text: string, summary: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'dsh-coding-control',
      form: 'notice',
      summary: boundContextSummary(summary.slice(0, SUMMARY_MAX)),
    },
  })
}
