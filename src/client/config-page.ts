/**
 * The Coding runtime's configuration page on the bundle's plugin page.
 *
 * The plugin manager renders `plugins.bundle.config` between a bundle's
 * description and its rows, but hands a bundle page only `view` — the Host
 * `ConfigForm` is passed to row pages, not bundle pages. A bundle page obtains
 * the same form through `ctx.configForms.get(entryId)`, which owns the
 * revision-fenced write queue; the page therefore never touches
 * `ctx.remote.settings` itself and never edits the profile file.
 *
 * `entryId` is the Host plugin entry id of the bundle row, which is this
 * package's name and the row id declared in `cordis.patch.yml`.
 *
 * Controls follow the shipped DSH recipes (label 13px, 40px field with
 * `--dsw-radius-md`, secondary button); the classes live in `./styles.ts`.
 *
 * @module dsh-coding/client/config-page
 */
import { createElement as h, useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import { WORKER_AUTO, isWorkerAuto } from '../config/worker-auto.js'
import type { CodingKey } from './locales.js'

/** Settings namespace key: the bundle row id. */
export const SETTINGS_NAMESPACE = 'dsh-coding'

/** Modes this page offers, matching the Host's `defaultMode` enum. */
export const MODES = ['auto', 'consult', 'review', 'codex'] as const

/** Languages this package ships. */
export const LANGUAGES = ['auto', 'zh', 'en'] as const

/** Reasoning policies this page offers, matching the Host's `reasoning` enum. */
export const REASONING_MODES = ['auto', 'low', 'high', 'max'] as const

/**
 * Accepted values and the revision-fenced write queue the Host owns for one
 * plugin entry. Stated structurally so this package does not depend on the
 * settings client package at build time; the Host instance provides exactly
 * this face.
 */
export interface CodingConfigFormSnapshot {
  /** `loading` until the first Host section, `unavailable` when not served. */
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly value: Record<string, unknown> | undefined
  readonly revision: number | undefined
  readonly writable: boolean
}

/** One field write, addressed inside the namespace section. */
export interface CodingConfigOp {
  readonly op: 'set' | 'unset'
  readonly path: string[]
  readonly value?: unknown
}

/** The form face this page consumes. */
export interface CodingConfigForm {
  getSnapshot(): CodingConfigFormSnapshot
  subscribe(listener: () => void): () => void
  mutate(ops: readonly CodingConfigOp[], expectedRevision?: number): Promise<boolean>
}

/** Props the bundle page registration supplies. */
export interface CodingConfigPageProps {
  /** `summary` renders the one-liner the plugin manager shows first. */
  readonly view: 'summary' | 'page'
  /** Host-owned form for this bundle entry. */
  readonly form: CodingConfigForm
  /** Host session Remote the model fields read their catalog from. */
  readonly remote?: ModelCatalogRemote
  readonly t: (key: CodingKey) => string
}

/** `provider/model`; the Host applies the same rule (plus the `auto` sentinel) at activation. */
const ROUTE = /^[^/\s]+\/[^/\s]+$/u

/** 允许的取值：`auto`（派发时跟随主代理）或一条具体 `provider/model`。 */
const isSelectableRoute = (value: string): boolean => isWorkerAuto(value) || ROUTE.test(value.trim())

/** Read one string field from a settings value. */
export function fieldOf(value: Record<string, unknown> | undefined, key: string, fallback = ''): string {
  const raw = value?.[key]
  return typeof raw === 'string' ? raw : fallback
}

/** One editable draft, kept as strings so a half-typed route is not rejected. */
export interface Draft {
  readonly defaultMode: string
  readonly implementWorkerModel: string
  readonly plannerWorkerModel: string
  readonly verifyWorkerModel: string
  readonly language: string
  readonly reasoning: string
}

/**
 * The defaults the page restores, matching `cordis.patch.yml`.
 *
 * 三个 worker 默认跟随主代理当前模型；与 cordis.patch.yml 同步，用户可手动改成具体路由。
 */
export const DEFAULT_DRAFT: Draft = {
  defaultMode: 'auto',
  plannerWorkerModel: WORKER_AUTO,
  implementWorkerModel: WORKER_AUTO,
  verifyWorkerModel: WORKER_AUTO,
  language: 'auto',
  reasoning: 'auto',
}

/** One selectable `provider/model` route from the configured model catalog. */
export interface ModelOption {
  readonly value: string
  readonly provider: string
  readonly model: string
  readonly label: string
  /** The stored route is no longer advertised; still listed and kept as typed. */
  readonly missing?: boolean
}

/** One provider's catalog result, for the page's diagnostic line. */
export interface ProviderProbe {
  readonly provider: string
  /** Why the Host lookup failed, when it did. */
  readonly error?: string
}

/** The enumerated catalog plus what happened to each provider. */
export interface ModelCatalog {
  readonly options: readonly ModelOption[]
  readonly probes: readonly ProviderProbe[]
}

/** The result envelope every Host Remote method returns. */
export interface RemoteResultLike<T> {
  readonly ok: boolean
  readonly value?: T
  readonly error?: { readonly message?: string }
}

/** One provider group of the Host session model catalog. */
export interface ModelCatalogGroup {
  readonly id: string
  readonly name?: string
  readonly models: readonly { readonly id: string; readonly name?: string }[]
}

/** One provider whose catalog lookup failed on the Host. */
export interface ModelCatalogFailure {
  readonly id: string
  readonly name?: string
  readonly message: string
}

/** The Host session model catalog the composer model picker renders. */
export interface ModelCatalogValue {
  readonly groups: readonly ModelCatalogGroup[]
  readonly failures?: readonly ModelCatalogFailure[]
}

/** The slice of `ctx.remote.session` this page reads. */
export interface ModelCatalogRemote {
  modelCatalog?(): Promise<RemoteResultLike<ModelCatalogValue>>
}

/** Draft built from the accepted Host value. */
export function draftOf(value: Record<string, unknown> | undefined): Draft {
  return {
    defaultMode: fieldOf(value, 'defaultMode', 'auto'),
    implementWorkerModel: fieldOf(value, 'implementWorkerModel'),
    plannerWorkerModel: fieldOf(value, 'plannerWorkerModel'),
    verifyWorkerModel: fieldOf(value, 'verifyWorkerModel'),
    language: fieldOf(value, 'language', 'auto'),
    reasoning: fieldOf(value, 'reasoning', 'auto'),
  }
}

/** Whether every worker field is `auto` or names a `provider/model` pair. */
export function draftIsValid(draft: Draft): boolean {
  return isSelectableRoute(draft.implementWorkerModel)
    && isSelectableRoute(draft.plannerWorkerModel)
    && isSelectableRoute(draft.verifyWorkerModel)
}

/** The message of a thrown value, for the catalog error notice. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : 'Unknown error.'
}

/**
 * Load the `provider/model` list the Host session model catalog advertises.
 *
 * 这是 composer 模型选择器渲染的同一份目录，按 provider 分组。静态声明在 bundle
 * patch config 里的第三方 provider 也会出现在其中：它没有 settings profile 可供
 * model discovery 读取，但 adapter 仍通过 listModels 公布自己的模型。
 * 选项顺序沿用目录里 groups 与 models 的顺序（与 composer 一致），这里不再重排；
 * 失败 provider 转成 probe，页面据此给出诊断与重试入口。
 * @param remote - the Host session Remote, absent on an older Host.
 * @returns the options, one per advertised model, plus one probe per failed provider.
 */
export async function loadModelOptions(remote: ModelCatalogRemote | undefined): Promise<ModelCatalog> {
  // Keep the receiver: the Host's Remote methods may read `this`.
  const modelCatalog = remote?.modelCatalog?.bind(remote)
  if (modelCatalog === undefined) {
    throw new Error('The Host does not expose the session model catalog Remote.')
  }

  const result = await modelCatalog()
  const value = result.ok === true ? result.value : undefined
  if (typeof value !== 'object' || value === null) {
    throw new Error(result.error?.message || 'Could not read the configured model catalog.')
  }
  const groups = Array.isArray(value.groups) ? value.groups : []
  const failures = Array.isArray(value.failures) ? value.failures : []

  const byValue = new Map<string, ModelOption>()
  for (const group of groups) {
    const provider = typeof group?.id === 'string' ? group.id.trim() : ''
    if (provider === '') continue
    const groupName = typeof group.name === 'string' ? group.name.trim() : ''
    const providerLabel = groupName === '' ? provider : groupName
    const models = Array.isArray(group.models) ? group.models : []
    for (const model of models) {
      const id = typeof model?.id === 'string' ? model.id : ''
      if (id.trim() === '') continue
      const route = `${provider}/${id}`
      if (byValue.has(route)) continue
      const modelName = typeof model.name === 'string' ? model.name.trim() : ''
      byValue.set(route, {
        value: route,
        provider,
        model: id,
        label: `${providerLabel} · ${modelName === '' ? id : modelName}`,
      })
    }
  }

  const options = [...byValue.values()]
  if (options.length === 0) {
    throw new Error(failures[0]?.message || 'The Host advertised no models.')
  }
  const probes: ProviderProbe[] = failures.map(failure => ({
    provider: failure.id,
    error: failure.message,
  }))
  return { options, probes }
}

/**
 * Add the stored routes the catalog no longer advertises, marked `missing`, so
 * the suggestion list can still show what the settings hold instead of silently
 * dropping it. `auto` 由列表的固定首项提供，不进 missing 列表。
 * @param options - the loaded catalog.
 * @param current - the routes the draft currently holds.
 * @returns the options plus one entry per unknown stored route.
 */
export function mergeCurrentModels(options: readonly ModelOption[], current: readonly string[]): ModelOption[] {
  const merged = [...options]
  const values = new Set(options.map(option => option.value))
  for (const route of current) {
    const value = route.trim()
    if (value === '' || values.has(value) || isWorkerAuto(value)) continue
    values.add(value)
    const [provider = '', ...rest] = value.split('/')
    merged.push({ value, provider, model: rest.join('/'), label: value, missing: true })
  }
  return merged
}

/**
 * Whether one explicit route is present in the loaded catalog.
 * 仅用于提示：目录里没有的合法路由照样可以保存。
 */
export function routeInCatalog(route: string, options: readonly ModelOption[]): boolean {
  const value = route.trim()
  return isWorkerAuto(value) || options.some(option => option.value === value)
}

/**
 * The namespace mutation one save submits, revision fence owned by the caller.
 * A field the served schema does not advertise is left out: an older Host
 * would reject the whole mutation for an unknown property.
 * That guard also covers `reasoning`: a Host that does not declare it gets no
 * reasoning op, so the mutation is never rejected as a whole.
 * @param draft - edited values.
 * @param served - the accepted Host value the form was built from.
 * @returns the ordered operations.
 */
export function buildConfigOps(draft: Draft, served: Record<string, unknown> = { language: draft.language, reasoning: draft.reasoning }): CodingConfigOp[] {
  const ops: CodingConfigOp[] = [
    { op: 'set', path: ['defaultMode'], value: draft.defaultMode },
    { op: 'set', path: ['implementWorkerModel'], value: draft.implementWorkerModel.trim() },
    { op: 'set', path: ['plannerWorkerModel'], value: draft.plannerWorkerModel.trim() },
    { op: 'set', path: ['verifyWorkerModel'], value: draft.verifyWorkerModel.trim() },
  ]
  if ('language' in served) ops.push({ op: 'set', path: ['language'], value: draft.language })
  if ('reasoning' in served) ops.push({ op: 'set', path: ['reasoning'], value: draft.reasoning })
  return ops
}

/** Rendered command overrides, one `key = command` line each. */
function commandLines(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
  return Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([key, command]) => `${key} = ${command}`)
}

/** One text field row. */
function field(
  id: string,
  label: string,
  hint: string,
  input: ReturnType<typeof h>,
): ReturnType<typeof h> {
  return h(
    'div',
    { className: 'dsh-coding-field' },
    h('label', { htmlFor: id }, label),
    input,
    h('span', { className: 'dsh-coding-hint' }, hint),
  )
}

/**
 * One worker-model field: a native select over the Host's model catalog.
 *
 * `auto` is the first option and needs no catalog entry. A stored route the
 * catalog does not advertise keeps its own `missing` entry, so the control
 * shows what the settings hold instead of silently dropping it.
 */
function modelField(
  id: string,
  label: string,
  hint: string,
  value: string,
  options: readonly ModelOption[],
  invalid: boolean,
  readOnly: boolean,
  onChange: (next: string) => void,
  t: (key: CodingKey) => string,
): ReturnType<typeof h> {
  return field(
    id,
    label,
    hint,
    h(
      'select',
      {
        id,
        className: 'dsh-coding-input' + (invalid ? ' dsh-coding-input-warn' : ''),
        value,
        disabled: readOnly,
        'aria-invalid': invalid,
        onChange: (event: { target: { value: string } }) => { onChange(event.target.value) },
      },
      h('option', { key: WORKER_AUTO, value: WORKER_AUTO }, t('config.modelAuto')),
      ...options.map(option => h(
        'option',
        { key: option.value, value: option.value },
        option.missing ? `${option.label} — ${t('config.modelMissing')}` : option.label,
      )),
    ),
  )
}

/** The bundle configuration page. */
export function CodingConfigPage(props: CodingConfigPageProps): ReactElement {
  const { form, t } = props
  if (props.view === 'summary') return h('span', null, t('config.title'))

  // The form's methods are class methods: pass bound wrappers, or React calls
  // them with an undefined receiver and the controller's store lookup fails.
  const subscribe = useCallback((listener: () => void) => form.subscribe(listener), [form])
  const getSnapshot = useCallback(() => form.getSnapshot(), [form])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot)
  const [draft, setDraft] = useState<Draft>(() => draftOf(snapshot.value))
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [catalog, setCatalog] = useState<
    | { status: 'loading' }
    | { status: 'ready'; options: readonly ModelOption[]; probes: readonly ProviderProbe[] }
    | { status: 'error'; message: string }
  >({ status: 'loading' })
  const [catalogRevision, setCatalogRevision] = useState(0)

  // Adopt every accepted Host value: a save, or another page's write, replaces
  // the draft instead of silently diverging from what the Host now holds.
  useEffect(() => {
    setDraft(draftOf(snapshot.value))
  }, [snapshot.value])

  // The selectable routes come from the Host's configured model catalog. A
  // failure does not disable Save: `auto` needs no catalog entry, and the Host
  // validates a stored route at dispatch. The notice names every provider that
  // answered nothing, so a missing third-party model is diagnosable here.
  useEffect(() => {
    let cancelled = false
    setCatalog({ status: 'loading' })
    loadModelOptions(props.remote)
      .then(result => { if (!cancelled) setCatalog({ status: 'ready', options: result.options, probes: result.probes }) })
      .catch(error => { if (!cancelled) setCatalog({ status: 'error', message: messageOf(error) }) })
    return () => { cancelled = true }
  }, [props.remote, catalogRevision])

  if (snapshot.status === 'loading') {
    return h('p', { className: 'dsh-coding-hint' }, t('config.loading'))
  }
  if (snapshot.status === 'unavailable') {
    return h('p', { className: 'dsh-coding-hint' }, t('config.unavailable'))
  }

  const value = snapshot.value ?? {}
  const routesValid = draftIsValid(draft)
  const options: readonly ModelOption[] = catalog.status === 'ready' ? catalog.options : []
  const modelOptions = mergeCurrentModels(options, [
    draft.plannerWorkerModel,
    draft.implementWorkerModel,
    draft.verifyWorkerModel,
  ])
  const routeKnown = (route: string): boolean => routeInCatalog(route, options)
  const dirty = draft.defaultMode !== fieldOf(value, 'defaultMode', 'auto')
    || draft.implementWorkerModel !== fieldOf(value, 'implementWorkerModel')
    || draft.plannerWorkerModel !== fieldOf(value, 'plannerWorkerModel')
    || draft.verifyWorkerModel !== fieldOf(value, 'verifyWorkerModel')
    || draft.language !== fieldOf(value, 'language', 'auto')
    || draft.reasoning !== fieldOf(value, 'reasoning', 'auto')
  const commands = commandLines(value['verificationCommands'])
  const readOnly = snapshot.writable !== true
  const probeSummary: readonly ProviderProbe[] = catalog.status === 'ready'
    ? catalog.probes
    : []
  const probeNote = probeSummary.length === 0
    ? ''
    : ` ${t('config.modelProbeFailed')} ${probeSummary.slice(0, 3).map(probe => (probe.error === undefined ? probe.provider : `${probe.provider} (${probe.error})`)).join('; ')}`
  const modelNotice = catalog.status === 'ready'
    ? {
      text: `${t('config.modelWarning')}${probeNote}`,
      className: routesValid ? 'dsh-coding-hint dsh-coding-notice' : 'dsh-coding-warn dsh-coding-notice',
    }
    : catalog.status === 'error'
      ? {
        text: `${t('config.modelsUnavailable')} ${catalog.message}`,
        className: 'dsh-coding-warn dsh-coding-notice',
      }
      : { text: t('config.modelsLoading'), className: 'dsh-coding-hint dsh-coding-notice' }

  async function save(): Promise<void> {
    if (status === 'saving' || !routesValid || readOnly) return
    setStatus('saving')
    try {
      const accepted = await form.mutate(buildConfigOps(draft, value), snapshot.revision)
      setStatus(accepted ? 'saved' : 'error')
    } catch {
      setStatus('error')
    }
  }

  /** Put the shipped defaults back into the draft; saving stays explicit. */
  function resetDefaults(): void {
    setDraft(DEFAULT_DRAFT)
    setStatus('idle')
  }

  const statusText = status === 'saving'
    ? t('config.saving')
    : status === 'saved'
      ? t('config.saved')
      : status === 'error'
        ? t('config.saveFailed')
        : routesValid ? '' : t('config.invalidRoute')
  const statusClass = status === 'error'
    ? 'dsh-coding-error'
    : status === 'saved' ? 'dsh-coding-success' : 'dsh-coding-hint'

  return h(
    'div',
    { className: 'dsh-coding-form', 'data-dsh-coding-config': 'true' },
    h('p', { className: 'dsh-coding-warn dsh-coding-notice' }, t('config.presetWarning')),
    field(
      'dsh-coding-mode',
      t('config.mode'),
      t('config.modeHint'),
      h(
        'select',
        {
          id: 'dsh-coding-mode',
          className: 'dsh-coding-input',
          value: draft.defaultMode,
          disabled: readOnly,
          onChange: (event: { target: { value: string } }) => {
            setDraft(current => ({ ...current, defaultMode: event.target.value }))
            setStatus('idle')
          },
        },
        ...MODES.map(option => h('option', { key: option, value: option }, t(`mode.${option}` as CodingKey))),
      ),
    ),
    'language' in value
      ? field(
        'dsh-coding-language',
        t('config.language'),
        t('config.languageHint'),
        h(
          'select',
          {
            id: 'dsh-coding-language',
            className: 'dsh-coding-input',
            value: draft.language,
            disabled: readOnly,
            onChange: (event: { target: { value: string } }) => {
              setDraft(current => ({ ...current, language: event.target.value }))
              setStatus('idle')
            },
          },
          ...LANGUAGES.map((option) => {
            const label = option === 'auto'
              ? t('config.languageAuto')
              : option === 'zh' ? '中文' : 'English'
            return h('option', { key: option, value: option }, label)
          }),
        ),
      )
      : null,
    'reasoning' in value
      ? field(
        'dsh-coding-reasoning',
        t('config.reasoning'),
        t('config.reasoningHint'),
        h(
          'select',
          {
            id: 'dsh-coding-reasoning',
            className: 'dsh-coding-input',
            value: draft.reasoning,
            disabled: readOnly,
            onChange: (event: { target: { value: string } }) => {
              setDraft(current => ({ ...current, reasoning: event.target.value }))
              setStatus('idle')
            },
          },
          ...REASONING_MODES.map((option) => {
            const label = option === 'auto'
              ? t('config.reasoningAuto')
              : option === 'low' ? 'Low' : option === 'high' ? 'High' : 'Max'
            return h('option', { key: option, value: option }, label)
          }),
        ),
      )
      : null,
    h(
      'div',
      { className: 'dsh-coding-notice-row' },
      h('p', { className: modelNotice.className }, modelNotice.text),
      catalog.status === 'error'
        ? h(
          'button',
          {
            type: 'button',
            className: 'dsh-coding-button',
            onClick: () => { setCatalogRevision(current => current + 1) },
          },
          t('config.modelsRetry'),
        )
        : null,
    ),
    modelField(
      'dsh-coding-planner',
      t('config.plannerModel'),
      t('config.plannerModelHint'),
      draft.plannerWorkerModel,
      modelOptions,
      catalog.status === 'ready' && !routeKnown(draft.plannerWorkerModel),
      readOnly,
      (next) => {
        setDraft(current => ({ ...current, plannerWorkerModel: next }))
        setStatus('idle')
      },
      t,
    ),
    modelField(
      'dsh-coding-implement',
      t('config.implementModel'),
      t('config.implementModelHint'),
      draft.implementWorkerModel,
      modelOptions,
      catalog.status === 'ready' && !routeKnown(draft.implementWorkerModel),
      readOnly,
      (next) => {
        setDraft(current => ({ ...current, implementWorkerModel: next }))
        setStatus('idle')
      },
      t,
    ),
    modelField(
      'dsh-coding-verify',
      t('config.verifyModel'),
      t('config.verifyModelHint'),
      draft.verifyWorkerModel,
      modelOptions,
      catalog.status === 'ready' && !routeKnown(draft.verifyWorkerModel),
      readOnly,
      (next) => {
        setDraft(current => ({ ...current, verifyWorkerModel: next }))
        setStatus('idle')
      },
      t,
    ),
    h(
      'div',
      { className: 'dsh-coding-field' },
      h('label', null, t('config.commands')),
      h('span', { className: 'dsh-coding-mono' }, commands.length === 0
        ? t('config.verification')
        : commands.join('\n')),
      h('span', { className: 'dsh-coding-hint' }, t('config.commandsHint')),
    ),
    h(
      'div',
      { className: 'dsh-coding-footer' },
      h(
        'button',
        {
          type: 'button',
          className: 'dsh-coding-button dsh-coding-button-lg',
          disabled: readOnly || status === 'saving' || !routesValid || !dirty,
          onClick: () => { void save() },
        },
        status === 'saving' ? t('config.saving') : t('config.save'),
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'dsh-coding-button',
          disabled: readOnly || status === 'saving',
          onClick: () => { resetDefaults() },
        },
        t('config.reset'),
      ),
      statusText === '' ? null : h('span', { className: statusClass }, statusText),
      readOnly ? h('span', { className: 'dsh-coding-hint' }, t('config.readOnly')) : null,
    ),
  )
}
