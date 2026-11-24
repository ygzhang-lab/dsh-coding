/**
 * Browser-half tests: the bundle must load through the module-table contract,
 * register the turn card, the stage capsule, the command row, and the
 * configuration page as effects, and wire every control back through the Host
 * — without a DOM.
 *
 * React hooks cannot run outside a renderer, so the components are exercised
 * through the pure helpers they are built from (card state, command line,
 * configuration operations) and through the hook-free wrapper each slot
 * receives.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

// Pure helpers of the built modules: building them into the browser bundle
// does not mean they can only be reached through it.
const { cardState, commandFor, memoryCommand, verificationText, reasoningDisplay } = await import('../lib/client/card.js')
const { en, zh } = await import('../lib/client/locales.js')
const { pickerState, pickerCommandFor } = await import('../lib/client/mode-picker.js')
const { commandRowOf, commandRejected } = await import('../lib/client/command-row.js')
const {
  DEFAULT_DRAFT,
  draftOf,
  buildConfigOps,
  draftIsValid,
  loadModelOptions,
  mergeCurrentModels,
  routeInCatalog,
} = await import('../lib/client/config-page.js')

/** Load the browser bundle the way `window.__ModuleLoader__` would. */
function loadClientBundle() {
  const instances = []
  const window = {
    __ModuleLoader__: {
      load(spec) {
        instances.push({ id: spec.id, exports: spec.factory((id) => require(id)) })
      },
    },
  }
  const code = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  // Evaluate as a plain browser script: the real loader is not a module system,
  // and re-evaluating per test keeps each registration set independent.
  new Function('window', code)(window)
  assert.equal(instances.length, 1, 'the bundle registers exactly one factory')
  return instances[0]
}

/** A minimal Client context recording every registration. */
function createClientContext() {
  const registrations = {
    dictionaries: [], definitions: [], slots: [], effects: 0, commands: [], formId: null,
    localeBindings: [],
  }
  const form = { sentinel: 'form' }
  const ctx = {
    effect(effect) {
      registrations.effects += 1
      const disposer = effect()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    locale: {
      register(namespace, dicts) {
        registrations.dictionaries.push({ namespace, locales: Object.keys(dicts) })
        return () => {}
      },
      bind(namespace) {
        registrations.localeBindings.push(namespace)
        return (key) => key
      },
    },
    uiConversation: {
      events: {
        register(definition) {
          registrations.definitions.push(definition)
          return () => {}
        },
      },
    },
    configForms: {
      get(id) {
        registrations.formId = id
        return form
      },
    },
    remote: {
      session: {
        async modelCatalog() {
          return {
            ok: true,
            value: {
              groups: [
                {
                  id: 'deepseek-account',
                  name: 'DeepSeek Account',
                  models: [{ id: 'deepseek-v4-pro', name: 'V4 Pro' }, { id: 'deepseek-flash' }],
                },
                {
                  id: 'qianwen-token-plan',
                  name: 'Qianwen AI Platform',
                  models: [{ id: 'qwen3.8-max', name: 'Qwen 3.8 Max' }, { id: 'qwen3.8-flash' }],
                },
              ],
              failures: [],
            },
          }
        },
      },
      commands: {
        async execute(sessionId, line, args) {
          registrations.commands.push({ sessionId, line, args })
          return { ok: true }
        },
      },
    },
    slots: {
      inject(owner, callback) {
        const entry = { owner, callback }
        registrations.slots.push(entry)
        return () => {}
      },
      register(options, component) {
        // Attach to the entry whose callback is running, not merely the last one.
        const owner = registrations.slots.find(entry => entry.owner === options.name && entry.registered === undefined)
        if (owner === undefined) throw new Error(`register() for an undeclared owner ${options.name}`)
        owner.registered = { options, component }
        return () => {}
      },
    },
  }
  return { ctx, registrations, form }
}

/** Run one slot callback and return its registration. */
function slotOf(registrations, owner) {
  const entry = registrations.slots.find(item => item.owner === owner)
  assert.ok(entry, `${owner} is registered`)
  entry.callback()
  assert.ok(entry.registered, `${owner} callback registers an entry`)
  return entry.registered
}

test('the bundle registers the card, the capsule, the command row, and the configuration page as effects', () => {
  const { id, exports } = loadClientBundle()
  assert.equal(id, 'dsh-coding')
  assert.deepEqual(exports.inject, ['slots', 'locale', 'uiConversation', 'configForms', 'remote', 'remote.commands', 'remote.session'])

  const { ctx, registrations } = createClientContext()
  exports.apply(ctx)

  assert.deepEqual(registrations.dictionaries, [{ namespace: 'dsh-coding', locales: ['zh', 'en'] }])
  assert.deepEqual(registrations.localeBindings, ['dsh-coding'])
  assert.equal(registrations.definitions.length, 1)
  assert.equal(registrations.definitions[0].kind, 'coding-stage')
  assert.equal(registrations.definitions[0].target, 'chat')
  assert.equal(registrations.effects, 8, 'dictionary, stylesheet, Definition, turn card, mode picker, capsule node, command row, and page are effects')

  const turnCard = slotOf(registrations, 'conversation.chat.turnTail')
  assert.equal(turnCard.options.id, 'dsh-coding/turn-card')
  assert.equal(turnCard.options.locale, 'dsh-coding')

  const chatNode = slotOf(registrations, 'conversation.chat.node')
  assert.equal(chatNode.options.key, 'coding-stage')

  const commandRow = slotOf(registrations, 'conversation.chat.commandview')
  assert.equal(commandRow.options.key, 'coding')
  assert.equal(commandRow.options.locale, 'dsh-coding')

  const picker = slotOf(registrations, 'conversation.hero.options')
  assert.equal(picker.options.id, 'dsh-coding/mode-picker')
  assert.equal(picker.options.locale, 'dsh-coding')

  const page = slotOf(registrations, 'plugins.bundle.config')
  assert.equal(page.options.key, 'dsh-coding')
  assert.equal(registrations.formId, 'dsh-coding', 'the page takes the Host form by entry id')
})

test('the turn card sends a mode switch back through the Host commands Remote', () => {
  const { exports } = loadClientBundle()
  const { ctx, registrations } = createClientContext()
  exports.apply(ctx)
  const turnCard = slotOf(registrations, 'conversation.chat.turnTail')
  const element = turnCard.component({ sessionId: 'session-7', t: (key) => key })
  assert.equal(typeof element.props.execute, 'function')
  return element.props.execute('/coding set review').then(() => {
    assert.deepEqual(registrations.commands, [{ sessionId: 'session-7', line: '/coding set review', args: [] }])
  })
})

test('the first-message picker sends a silent set command', () => {
  const { exports } = loadClientBundle()
  const { ctx, registrations } = createClientContext()
  exports.apply(ctx)
  const picker = slotOf(registrations, 'conversation.hero.options')
  const element = picker.component({ sessionId: 'session-8', t: (key) => key })
  assert.equal(typeof element.props.execute, 'function')
  return element.props.execute(pickerCommandFor('review')).then(() => {
    assert.deepEqual(registrations.commands, [{ sessionId: 'session-8', line: '/coding set review', args: [] }])
  })
})

test('the picker renders only for a live Coding session', () => {
  assert.equal(pickerState(undefined), null)
  assert.equal(pickerState({ active: false, mode: 'codex' }), null)
  assert.deepEqual(pickerState({ active: true, mode: 'review' }), {
    mode: 'review',
    modes: ['auto', 'consult', 'review', 'codex'],
  })
  assert.equal(pickerState({ active: true, mode: 'unknown' }).mode, 'auto')
  assert.equal(pickerCommandFor('consult'), '/coding set consult')
  assert.equal(pickerCommandFor('auto'), '/coding set auto')
})

test('the configuration page receives the Host form', () => {
  const { exports } = loadClientBundle()
  const { ctx, registrations, form } = createClientContext()
  exports.apply(ctx)
  const page = slotOf(registrations, 'plugins.bundle.config')
  const element = page.component({ view: 'page', t: (key) => key })
  assert.equal(element.props.form, form, 'the page renders with the shared Host form')
  assert.equal(typeof element.props.remote.modelCatalog, 'function', 'the page receives a lazy catalog reader')
  assert.equal(typeof element.props.t, 'function')
})

test('the configuration page registers before the session Remote is ready', async () => {
  const { exports } = loadClientBundle()
  const { ctx, registrations } = createClientContext()
  let session
  Object.defineProperty(ctx.remote, 'session', {
    configurable: true,
    get() {
      if (session === undefined) throw new Error('the session Remote is not mounted yet')
      return session
    },
    set(value) { session = value },
  })
  // apply() must not read the namespace: the throwing getter would abort it.
  exports.apply(ctx)
  const page = slotOf(registrations, 'plugins.bundle.config')
  const element = page.component({ view: 'page', t: (key) => key })
  assert.equal(typeof element.props.remote.modelCatalog, 'function', 'the page receives a lazy catalog reader')
  // Without the namespace the page reports why it cannot list models.
  await assert.rejects(element.props.remote.modelCatalog(), /session model catalog Remote/u)

  session = {
    async modelCatalog() {
      return {
        ok: true,
        value: {
          groups: [{ id: 'qianwen-token-plan', name: 'Qianwen AI Platform', models: [{ id: 'qwen3.8-max' }] }],
          failures: [],
        },
      }
    },
  }
  const { options, probes } = await loadModelOptions(element.props.remote)
  assert.deepEqual(options.map(option => option.value), ['qianwen-token-plan/qwen3.8-max'])
  assert.deepEqual(probes, [])
})

test('the configuration page reports an unavailable form instead of crashing', () => {
  const { exports } = loadClientBundle()
  const { ctx, registrations } = createClientContext()
  ctx.configForms.get = () => undefined
  exports.apply(ctx)
  const page = slotOf(registrations, 'plugins.bundle.config')
  const element = page.component({ view: 'page', t: (key) => key })
  assert.equal(element.type, 'p', 'the page falls back to a notice')
  assert.equal(element.props.className, 'dsh-coding-hint')
  assert.deepEqual(element.props.children, 'config.unavailable')
})

test('the configuration page lists the Host session catalog in provider order', async () => {
  const { ctx } = createClientContext()
  const { options, probes } = await loadModelOptions(ctx.remote.session)
  assert.deepEqual(options.map(option => option.value), [
    'deepseek-account/deepseek-v4-pro',
    'deepseek-account/deepseek-flash',
    'qianwen-token-plan/qwen3.8-max',
    'qianwen-token-plan/qwen3.8-flash',
  ], 'options keep the catalog provider order')
  assert.deepEqual(options[0], {
    value: 'deepseek-account/deepseek-v4-pro',
    provider: 'deepseek-account',
    model: 'deepseek-v4-pro',
    label: 'DeepSeek Account · V4 Pro',
  })
  assert.equal(options[1].label, 'DeepSeek Account · deepseek-flash', 'an unnamed model falls back to its id')
  assert.equal(options[2].label, 'Qianwen AI Platform · Qwen 3.8 Max', 'a third-party provider keeps its display name')
  assert.deepEqual(probes, [])

  assert.deepEqual(DEFAULT_DRAFT, {
    defaultMode: 'auto',
    plannerWorkerModel: 'auto',
    implementWorkerModel: 'auto',
    verifyWorkerModel: 'auto',
    language: 'auto',
    reasoning: 'auto',
  })
  assert.equal(draftIsValid(DEFAULT_DRAFT), true, 'auto never needs the catalog')
  assert.equal(
    draftIsValid({ ...DEFAULT_DRAFT, plannerWorkerModel: 'deepseek-account/deepseek-chat' }),
    true,
    'an explicit route only has to be well formed',
  )
  assert.equal(draftIsValid({ ...DEFAULT_DRAFT, verifyWorkerModel: '  ' }), false, 'auto is exact: blank is still invalid')
  assert.equal(draftIsValid(DEFAULT_DRAFT), true, 'auto is valid before any catalog loads')
  assert.equal(
    draftIsValid({ ...DEFAULT_DRAFT, implementWorkerModel: 'deepseek-account/deepseek-flash' }),
    true,
    'a typed route is saveable even before the catalog loads',
  )

  const merged = mergeCurrentModels(options, ['deepseek-account/deepseek-chat'])
  assert.equal(merged.length, 5)
  assert.deepEqual(merged.at(-1), {
    value: 'deepseek-account/deepseek-chat',
    provider: 'deepseek-account',
    model: 'deepseek-chat',
    label: 'deepseek-account/deepseek-chat',
    missing: true,
  }, 'a stored route outside the catalog is kept and flagged')
  assert.equal(mergeCurrentModels(options, ['deepseek-account/deepseek-flash']).length, 4, 'a known route is not duplicated')
  assert.equal(mergeCurrentModels(options, ['auto']).length, 4, 'auto is not a missing route')

  assert.equal(routeInCatalog('auto', []), true, 'auto is never a catalog question')
  assert.equal(routeInCatalog('qianwen-token-plan/qwen3.8-flash', []), false, 'a route outside the catalog only loses its hint')
  assert.equal(routeInCatalog('deepseek-account/deepseek-flash', options), true)

  await assert.rejects(loadModelOptions(undefined), /model catalog Remote/u)
  await assert.rejects(loadModelOptions({}), /model catalog Remote/u)

  const offline = {
    async modelCatalog() { return { ok: false, error: { message: 'catalog offline' } } },
  }
  await assert.rejects(loadModelOptions(offline), /catalog offline/u)

  const empty = {
    async modelCatalog() {
      return {
        ok: true,
        value: { groups: [], failures: [{ id: 'qianwen-token-plan', name: 'Qianwen AI Platform', message: 'provider unreachable' }] },
      }
    },
  }
  await assert.rejects(loadModelOptions(empty), /provider unreachable/u)

  const silent = { async modelCatalog() { return { ok: true, value: { groups: [], failures: [] } } } }
  await assert.rejects(loadModelOptions(silent), /advertised no models/u)
})

test('a statically declared third-party provider is listed from the session catalog', async () => {
  // The bug this covers: a provider declared statically in a bundle's patch
  // config (qianwen-token-plan below) has no settings profile, so model
  // discovery cannot enumerate it; the Host session catalog still lists it
  // because the adapter advertises its configured models through listModels.
  const remote = {
    async modelCatalog() {
      return {
        ok: true,
        value: {
          groups: [{
            id: 'qianwen-token-plan',
            name: 'Qianwen AI Platform',
            models: [
              { id: 'deepseek-v4.1-flash-1017' },
              { id: 'deepseek-v4-pro-0813' },
              { id: 'qwen3.8-max', name: 'Qwen 3.8 Max' },
              { id: 'qwen3.8-flash' },
            ],
          }],
          failures: [],
        },
      }
    },
  }
  const { options, probes } = await loadModelOptions(remote)
  assert.deepEqual(options.map(option => option.value), [
    'qianwen-token-plan/deepseek-v4.1-flash-1017',
    'qianwen-token-plan/deepseek-v4-pro-0813',
    'qianwen-token-plan/qwen3.8-max',
    'qianwen-token-plan/qwen3.8-flash',
  ], 'the third-party provider models are visible')
  assert.equal(options[2].label, 'Qianwen AI Platform · Qwen 3.8 Max')
  assert.deepEqual(probes, [])
})

test('a provider the Host cannot list keeps its reason for the diagnostic line', async () => {
  const remote = {
    async modelCatalog() {
      return {
        ok: true,
        value: {
          groups: [{ id: 'deepseek-account', name: 'DeepSeek Account', models: [{ id: 'deepseek-flash' }] }],
          failures: [{ id: 'qianwen-token-plan', name: 'Qianwen AI Platform', message: 'endpoint unreachable' }],
        },
      }
    },
  }
  const { options, probes } = await loadModelOptions(remote)
  assert.deepEqual(options.map(option => option.value), ['deepseek-account/deepseek-flash'])
  assert.deepEqual(probes, [{ provider: 'qianwen-token-plan', error: 'endpoint unreachable' }])
})

test('the stylesheet uses only shipped DSH classes, tokens, and sizes', async () => {
  const { installStyles, STYLE_ID } = await import('../lib/client/styles.js')
  const appended = []
  const fake = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  }
  globalThis.document = {
    querySelector: fake.querySelector,
    createElement: fake.createElement,
    head: { append: (tag) => { appended.push(tag) } },
  }
  try {
    const dispose = installStyles()
    assert.equal(appended.length, 1)
    const tag = appended[0]
    assert.equal(tag.dataset.pluginCss, STYLE_ID)
    assert.equal(tag.dataset.plugin, 'dsh-coding')
    assert.match(tag.textContent, /--dsw-alias-card-fill/u)
    assert.match(tag.textContent, /--dsw-radius-lg/u)
    assert.match(tag.textContent, /font: inherit/u)
    // One base type for the card and for every color utility: a bare
    // verification span must not inherit the chat body size.
    assert.match(tag.textContent, /\.dsh-coding-card \{[^}]*font-size: 12px/su)
    assert.match(tag.textContent, /\.dsh-coding-label \{[^}]*font-size: 12px/su)
    assert.match(tag.textContent, /\.dsh-coding-success \{[^}]*color-mix/su, 'the success green is softened per theme')
    assert.match(tag.textContent, /\.dsh-coding-picker \{[^}]*font-size: 12px/su)
    assert.match(tag.textContent, /\.dsh-coding-value \{[^}]*font-size: 12px/su)
    assert.match(tag.textContent, /\.dsh-coding-success,\n\.dsh-coding-warn \{[^}]*font-size: 12px/su)
    // The capsule resets its children to the line's own size.
    assert.match(tag.textContent, /\.dsh-coding-capsule \.dsh-coding-success,[\s\S]*?font-size: inherit/su)
    // No invented palette, no bespoke typography scale.
    assert.doesNotMatch(tag.textContent, /#[0-9a-fA-F]{3,8}/u)
    assert.doesNotMatch(tag.textContent, /font-size:\s*11px/u)
    assert.doesNotMatch(tag.textContent, /border-radius:\s*999px/u)
    dispose()
  } finally {
    delete globalThis.document
  }
})

test('a mode switch leaves no command receipt in the transcript', () => {
  const set = commandRowOf({
    name: 'coding',
    args: ' set review',
    outcome: { kind: 'success', text: 'mode set to review; stages requirements, verify, deliver' },
  })
  assert.equal(set.hidden, true, 'the silent set command renders nothing')
  assert.equal(set.line, '/coding set review')
  assert.equal(set.text, null)

  assert.equal(commandRowOf({
    name: 'coding',
    args: ' review',
    outcome: { kind: 'error', text: 'unknown mode "review"' },
  }).hidden, true, 'a failing switch is silent too, never a red card')

  assert.deepEqual(commandRowOf({
    name: 'coding',
    args: ' stage verify',
    outcome: { kind: 'success', text: 'stage set to verify' },
  }), {
    hidden: false,
    line: '/coding stage verify',
    text: 'stage set to verify',
    failed: false,
  })

  assert.equal(commandRowOf({ name: 'coding', args: '', outcome: null }).hidden, true, 'an unsettled command has no body')

  assert.equal(commandRowOf({
    name: 'coding',
    args: ' stage implement',
    outcome: { kind: 'error', text: 'gate refused' },
  }).failed, true)
})

test('a command result is rejected when the Remote or the command handler fails', () => {
  assert.equal(commandRejected({ ok: true }), false)
  assert.equal(commandRejected({ ok: true, value: { commandId: 'c1', result: { kind: 'error', text: 'x' } } }), true)
  assert.equal(commandRejected({ ok: false, error: {} }), true)
  assert.equal(commandRejected(undefined), false)
})

test('the command row component renders the line and hides a mode switch', () => {
  const { exports } = loadClientBundle()
  const { ctx, registrations } = createClientContext()
  exports.apply(ctx)
  // The slot holds the memoized component; `type` is the renderer inside it,
  // which is callable without a renderer.
  const render = slotOf(registrations, 'conversation.chat.commandview').component.type
  assert.equal(
    render({ node: { name: 'coding', args: ' set review', outcome: { kind: 'success' } } }),
    null,
  )
  const element = render({
    node: { name: 'coding', args: '', outcome: { kind: 'success', text: 'stage requirements of session' } },
  })
  assert.notEqual(element, null)
  assert.equal(element.props.className, 'dsh-coding-command')
})

test('card state freezes a closed turn and keeps the newest one live', () => {
  const view = {
    active: true,
    mode: 'codex',
    stage: 'implement',
    allowedStages: ['requirements', 'plan', 'implement', 'verify', 'deliver'],
    planItems: 3,
    openPlanItems: 1,
    edits: 2,
    verification: null,
    pending: null,
    latest: 4,
    turns: [
      { turn: 3, mode: 'review', stage: 'verify', verification: { passed: true, kind: 'test', scope: 'targeted', command: 'pnpm test', failedTests: [], ranAt: 1 }, planItems: 2, openPlanItems: 0, edits: 5 },
      { turn: 4, mode: 'codex', stage: 'implement', verification: null, planItems: 3, openPlanItems: 1, edits: 2 },
    ],
    updatedAt: 10,
  }
  const newest = cardState(view, 4)
  assert.equal(newest.live, true)
  assert.equal(newest.mode, 'codex')
  assert.equal(newest.stage, 'implement')
  assert.deepEqual(newest.allowed, ['requirements', 'plan', 'implement', 'verify', 'deliver'])
  assert.deepEqual(
    { planItems: newest.planItems, openPlanItems: newest.openPlanItems, edits: newest.edits },
    { planItems: 3, openPlanItems: 1, edits: 2 },
    'the newest card reads the live projection',
  )

  const history = cardState(view, 3)
  assert.equal(history.live, false, 'an older card is history, not a control')
  assert.equal(history.mode, 'review', 'a switch never rewrites an older card')
  assert.equal(history.stage, 'verify')
  assert.equal(history.verification.passed, true)
  assert.deepEqual(history.allowed, ['requirements', 'verify', 'deliver'], 'the frozen turn keeps its own stage set')
  assert.deepEqual(
    { planItems: history.planItems, openPlanItems: history.openPlanItems, edits: history.edits },
    { planItems: 2, openPlanItems: 0, edits: 5 },
    'a history card keeps the numbers its turn ended with, not the live ones',
  )
  assert.equal(newest.canMemory, false, 'the implement stage has not finished a delivery')
  assert.equal(history.canMemory, false)

  assert.equal(commandFor('consult'), '/coding set consult')
  assert.equal(commandFor('review'), '/coding set review')

  const auto = cardState({ ...view, mode: 'auto', stage: 'requirements' }, 4)
  assert.deepEqual(auto.allowed, ['requirements'], 'auto mode exposes only the requirements stage before a choice')
})

test('the handoff button appears only on the newest completed codex delivery', () => {
  const view = {
    active: true,
    mode: 'codex',
    stage: 'implement',
    allowedStages: ['requirements', 'plan', 'implement', 'verify', 'deliver'],
    planItems: 3,
    openPlanItems: 1,
    edits: 2,
    verification: null,
    pending: null,
    latest: 4,
    turns: [
      { turn: 4, mode: 'codex', stage: 'implement', verification: null, planItems: 3, openPlanItems: 1, edits: 2 },
    ],
    updatedAt: 10,
  }
  // An implement-stage card is not a finished run, so it offers no document.
  assert.equal(cardState(view, 4).canMemory, false)

  const completed = {
    ...view,
    stage: 'deliver',
    verification: { passed: true, kind: 'test', scope: 'package', command: 'pnpm test', failedTests: [], ranAt: 2 },
    latest: 5,
    turns: [
      ...view.turns,
      {
        turn: 5,
        mode: 'codex',
        stage: 'deliver',
        verification: { passed: true, kind: 'test', scope: 'package', command: 'pnpm test', failedTests: [], ranAt: 2 },
        planItems: 3,
        openPlanItems: 0,
        edits: 2,
      },
    ],
  }
  assert.equal(cardState(completed, 5).canMemory, true, 'the newest, finished codex turn can write the document')
  assert.equal(cardState(completed, 4).canMemory, false, 'a history card gets no button')
  const failed = {
    ...completed,
    verification: { passed: false, kind: 'test', scope: 'package', command: 'pnpm test', failedTests: ['adds numbers'], ranAt: 2 },
  }
  assert.equal(cardState(failed, 5).canMemory, false, 'a failing verification is not a finished delivery')
  assert.equal(cardState({ ...completed, mode: 'review' }, 5).canMemory, false, 'only a codex run writes the document')
  assert.equal(memoryCommand(), '/coding memory')
})

test('the handoff copy exists in both dictionaries', () => {
  const keys = [
    'card.memory',
    'card.memoryHint',
    'card.memoryConfirm',
    'card.memoryCancel',
    'card.memoryBusy',
    'card.memoryDone',
    'card.memoryFailed',
  ]
  for (const key of keys) {
    assert.equal(typeof zh[key], 'string', `zh has ${key}`)
    assert.notEqual(zh[key].trim(), '', `zh ${key} is not empty`)
    assert.equal(typeof en[key], 'string', `en has ${key}`)
    assert.notEqual(en[key].trim(), '', `en ${key} is not empty`)
  }
})

test('the card shows only the verification status, with a readable color class', () => {
  const t = (key) => key
  assert.deepEqual(verificationText(null, t), {
    text: 'verification.none',
    className: 'dsh-coding-value',
  })
  assert.deepEqual(verificationText({ passed: true, command: 'pnpm test' }, t), {
    text: 'verification.passed',
    className: 'dsh-coding-success',
  }, 'the passing label never carries the command text')
  assert.deepEqual(verificationText({ passed: false, command: 'pnpm test' }, t), {
    text: 'verification.failed',
    className: 'dsh-coding-warn',
  })
})

test('the reasoning row freezes each turn and labels its source', () => {
  const state = {
    override: null,
    userEffort: null,
    effort: 'high',
    running: false,
    latest: 2,
    turns: [
      { turn: 1, override: null, userEffort: null, effort: 'low' },
      { turn: 2, override: null, userEffort: null, effort: 'high' },
    ],
  }
  assert.deepEqual(reasoningDisplay(state, 1, 'auto'), { level: 'low', source: 'auto' })
  assert.deepEqual(reasoningDisplay(state, 2, 'auto'), { level: 'high', source: 'auto' })
  // The newest, not-yet-closed turn reads the live state.
  assert.deepEqual(reasoningDisplay({ ...state, effort: 'max' }, 3, 'auto'), { level: 'max', source: 'auto' })
  // A pin labels a turn only when that turn actually ran at the pinned level.
  assert.deepEqual(reasoningDisplay(state, 3, 'max'), { level: 'max', source: 'settings' })
  assert.deepEqual(reasoningDisplay(state, 1, 'max'), { level: 'low', source: 'auto' })
  // An unknown history turn stays pending instead of borrowing the live level.
  assert.deepEqual(reasoningDisplay(state, 0, 'auto'), { level: null, source: 'pending' })
})

test('the reasoning row names overrides and chat-box picks', () => {
  const base = { override: null, userEffort: null, effort: null, running: false, latest: 1, turns: [] }
  assert.deepEqual(reasoningDisplay(base, 1, 'auto'), { level: null, source: 'pending' })
  assert.deepEqual(reasoningDisplay({ ...base, override: 'high' }, 1, 'auto'), { level: 'high', source: 'override' })
  assert.deepEqual(reasoningDisplay({ ...base, userEffort: 'medium' }, 1, 'auto'), { level: 'high', source: 'pick' })
  assert.deepEqual(reasoningDisplay(undefined, 1, 'auto'), { level: null, source: 'pending' })
  assert.deepEqual(reasoningDisplay(undefined, 1, 'high'), { level: 'high', source: 'settings' })
})

test('the configuration operations keep the revision fence and trim routes', () => {
  assert.equal(draftOf({}).defaultMode, 'auto')
  const draft = draftOf({
    defaultMode: 'review',
    implementWorkerModel: ' deepseek-account/deepseek-flash ',
    plannerWorkerModel: 'deepseek-account/deepseek-v4-pro',
    verifyWorkerModel: 'deepseek-account/deepseek-flash',
    language: 'zh',
    reasoning: 'high',
  })
  assert.equal(draft.defaultMode, 'review')
  assert.equal(draft.language, 'zh')
  assert.equal(draft.reasoning, 'high')
  assert.equal(draftIsValid(draft), true)
  assert.deepEqual(buildConfigOps(draft), [
    { op: 'set', path: ['defaultMode'], value: 'review' },
    { op: 'set', path: ['implementWorkerModel'], value: 'deepseek-account/deepseek-flash' },
    { op: 'set', path: ['plannerWorkerModel'], value: 'deepseek-account/deepseek-v4-pro' },
    { op: 'set', path: ['verifyWorkerModel'], value: 'deepseek-account/deepseek-flash' },
    { op: 'set', path: ['language'], value: 'zh' },
    { op: 'set', path: ['reasoning'], value: 'high' },
  ])
  assert.deepEqual(
    buildConfigOps(draft, { language: 'zh' }).map((op) => op.path.join('.')),
    ['defaultMode', 'implementWorkerModel', 'plannerWorkerModel', 'verifyWorkerModel', 'language'],
    'a Host that does not advertise reasoning gets no reasoning op',
  )

  assert.equal(draftIsValid(draftOf({ implementWorkerModel: 'x', verifyWorkerModel: 'a/b' })), false)

  const autoOps = buildConfigOps({ ...DEFAULT_DRAFT }, {})
  assert.deepEqual(autoOps, [
    { op: 'set', path: ['defaultMode'], value: 'auto' },
    { op: 'set', path: ['implementWorkerModel'], value: 'auto' },
    { op: 'set', path: ['plannerWorkerModel'], value: 'auto' },
    { op: 'set', path: ['verifyWorkerModel'], value: 'auto' },
  ], 'auto is saved verbatim; language and reasoning need a Host that declares them')
  assert.equal(draftIsValid({ ...DEFAULT_DRAFT }), true, 'auto is a valid draft value')
})
