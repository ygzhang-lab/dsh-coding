/**
 * Pre-Turn Coding mode picker.
 *
 * A new Session shows the blank hero before its first Turn. This picker sits in
 * that hero row, next to the composer, so the user can choose auto, consult,
 * review, or codex while writing the first prompt. The choice goes back through
 * the Host as a silent `/coding set <mode>`: the mode applies to the first Turn
 * without starting one. Later switches stay on the per-Turn control card.
 *
 * It reads the durable `dshCodingStage` projection, so the highlighted mode is
 * the same value the card and the stage machine use. It renders nothing outside
 * a Coding session.
 *
 * @module dsh-coding/client/mode-picker
 */
import { createElement as h, memo, useState } from 'react'
import type { ReactElement } from 'react'
import { CODING_PROJECTION_KEY, type CodingStageView } from '../coding-projection.js'
import type { CodingMode } from '../stages.js'
import { commandRejected } from './command-row.js'
import type { CodingKey } from './locales.js'

/** Modes the picker offers, in roster order. */
const MODES: readonly CodingMode[] = ['auto', 'consult', 'review', 'codex']

/** Props the hero-options slot hands this picker. */
export interface CodingModePickerProps {
  /** Host-computed projection value for this session. */
  readonly useProjection: (key: typeof CODING_PROJECTION_KEY) => unknown
  /** Injected by this plugin's registration: run one `/coding …` line. */
  readonly execute?: (line: string) => unknown
  readonly t: (key: CodingKey) => string
}

/** The command line one pre-Turn choice sends; `set` never starts a Turn. */
export function pickerCommandFor(mode: CodingMode): string {
  return `/coding set ${mode}`
}

/**
 * The state the picker renders. Pure, so the visible/absent split is testable
 * without a renderer.
 * @param view - current projection value, if the session has one.
 * @returns the selected mode and the offered modes, or null outside a Coding session.
 */
export function pickerState(
  view: CodingStageView | undefined,
): { readonly mode: CodingMode; readonly modes: readonly CodingMode[] } | null {
  if (view === undefined || view.active !== true) return null
  return { mode: MODES.includes(view.mode) ? view.mode : 'auto', modes: MODES }
}

/** The first-message mode picker rendered in the blank-session hero. */
export const CodingModePicker = memo(function CodingModePicker(
  props: CodingModePickerProps,
): ReactElement | null {
  const raw = props.useProjection?.(CODING_PROJECTION_KEY)
  const view = raw === null || typeof raw !== 'object' ? undefined : raw as CodingStageView
  const state = pickerState(view)
  const [busy, setBusy] = useState<CodingMode | null>(null)
  const [failed, setFailed] = useState(false)
  if (state === null) return null

  async function choose(next: CodingMode): Promise<void> {
    if (busy !== null || next === state?.mode) return
    setBusy(next)
    setFailed(false)
    try {
      const result = await props.execute?.(pickerCommandFor(next))
      if (commandRejected(result)) setFailed(true)
    } catch {
      setFailed(true)
    } finally {
      setBusy(null)
    }
  }

  return h(
    'div',
    {
      className: 'dsh-coding-picker',
      'data-dsh-coding-picker': 'true',
      role: 'group',
      'aria-label': props.t('picker.aria'),
    },
    h('span', { className: 'dsh-coding-label' }, props.t('picker.label')),
    ...state.modes.map(option => h(
      'button',
      {
        key: option,
        type: 'button',
        className: 'dsh-coding-button',
        disabled: busy !== null,
        'aria-pressed': option === state.mode,
        onClick: () => { void choose(option) },
      },
      props.t(`mode.${option}` as CodingKey),
    )),
    failed
      ? h('span', { className: 'dsh-coding-error' }, props.t('card.switchFailed'))
      : null,
  )
})
