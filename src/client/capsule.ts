/**
 * Stage capsule rendered in the Chat flow at each Coding tool call.
 *
 * It shows the state the runtime recorded — mode, stage path, verification,
 * plan, worker, pending call, refusal — and nothing else. There is no control
 * here: mode and stage changes re-enter the agent through `/coding`, which
 * delivers them with `agent.followup()` / `agent.steer()`.
 *
 * The capsule is one plain status line at DSH's caption size; it deliberately
 * avoids chips, pills, and custom colors, and uses only the shipped classes
 * from `./styles.ts`.
 *
 * @module dsh-coding/client/capsule
 */
import { createElement as h, memo } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CapsuleData } from './definition.js'
import type { CodingKey } from './locales.js'

/** Props the keyed Chat renderer receives from the Chat owner. */
type CapsuleProps = PropsRuntime<'conversation.chat.node', 'coding-stage'> & PropsLocale<'dsh-coding'>

/** The forward stage order every capsule renders against. */
const ALL_STAGES = ['requirements', 'plan', 'implement', 'verify', 'deliver'] as const

/**
 * One turn's Coding stage capsule.
 * @param props - Chat renderer props and the `dsh-coding` translate seat.
 */
export const CodingStageCapsule = memo(function CodingStageCapsule({ node, t }: CapsuleProps) {
  const data: CapsuleData = node.data
  const checkpoint = data.checkpoint
  const admitted = checkpoint?.allowedStages ?? ALL_STAGES
  const activeIndex = admitted.indexOf(data.stage)
  const children: ReturnType<typeof h>[] = [
    h('span', {
      key: 'mode',
      className: 'dsh-coding-faint',
      'data-mode': data.mode,
      // The card owns switching; the capsule only states the current mode.
      title: t('hint.mode'),
    }, t(`mode.${data.mode}` as CodingKey)),
    h('span', { key: 'mode-sep', className: 'dsh-coding-faint', 'aria-hidden': 'true' }, '·'),
  ]
  for (const [index, stage] of ALL_STAGES.entries()) {
    if (index > 0) {
      children.push(h('span', { key: `arrow-${stage}`, className: 'dsh-coding-arrow', 'aria-hidden': 'true' }, '→'))
    }
    const stageIndex = admitted.indexOf(stage)
    const isActive = stage === data.stage
    children.push(h('span', {
      key: stage,
      className: 'dsh-coding-stage',
      'data-stage': stage,
      ...isActive ? { 'data-active': 'true', 'data-current': 'true' } : {},
      ...stageIndex >= 0 && activeIndex >= 0 && stageIndex < activeIndex ? { 'data-done': 'true' } : {},
    }, t(`stage.${stage}` as CodingKey)))
  }

  const verification = checkpoint?.verification
  children.push(h('span', { key: 'verify-sep', className: 'dsh-coding-faint', 'aria-hidden': 'true' }, '·'))
  if (verification !== undefined) {
    children.push(h('span', {
      key: 'verification',
      className: verification.passed ? 'dsh-coding-success' : 'dsh-coding-warn',
      title: verification.command,
      'data-verification': verification.passed ? 'passed' : 'failed',
    }, t(verification.passed ? 'verification.passed' : 'verification.failed')))
  } else {
    children.push(h('span', {
      key: 'verification',
      className: 'dsh-coding-faint',
      'data-verification': 'none',
    }, t('verification.none')))
  }

  if (checkpoint !== undefined && checkpoint.planItems > 0) {
    const done = checkpoint.planItems - checkpoint.openPlanItems
    children.push(h('span', {
      key: 'plan',
      className: 'dsh-coding-muted',
      'data-plan': String(checkpoint.planItems),
    }, t('plan.progress', { done, total: checkpoint.planItems })))
  }

  if (checkpoint !== undefined && checkpoint.edits > 0) {
    children.push(h('span', {
      key: 'files',
      className: 'dsh-coding-muted',
    }, t('files', { count: checkpoint.edits })))
  }

  const worker = checkpoint?.worker
  if (worker !== undefined) {
    const label = worker.status === 'running'
      ? 'worker.running'
      : worker.status === 'completed' ? 'worker.completed' : 'worker.failed'
    children.push(h('span', {
      key: 'worker',
      className: worker.status === 'failed' ? 'dsh-coding-warn' : 'dsh-coding-muted',
      'data-worker': worker.status,
    }, t(label, { role: worker.role })))
  }

  if (data.pending !== undefined) {
    children.push(h('span', {
      key: 'pending',
      className: 'dsh-coding-muted',
      'data-pending': data.pending.tool,
    }, t('pending', { tool: data.pending.requested === undefined
      ? data.pending.tool
      : `${data.pending.tool} → ${data.pending.requested}` })))
  }

  const refusal = checkpoint?.refusal
  if (refusal !== undefined) {
    children.push(h('span', {
      key: 'refusal',
      className: 'dsh-coding-warn',
      title: refusal.reason,
      'data-refusal': refusal.target,
    }, `${t('refused')}: ${refusal.target}`))
  }

  return h('div', {
    className: 'dsh-coding-capsule',
    role: 'group',
    'aria-label': t('aria'),
    'data-coding-capsule': '',
    'data-stage': data.stage,
    'data-mode': data.mode,
    ...data.partial ? { 'data-partial': 'true' } : {},
  }, ...children)
})
