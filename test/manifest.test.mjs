/**
 * Packaging and contract tests: the manifest, the bundle patch, the built
 * artifacts, and the display resources the plugin page reads.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Read the bundle patch; `!!js` expressions are loader-only, so the tag is stripped. */
async function readPatch() {
  const text = (await readFile(join(root, 'cordis.patch.yml'), 'utf8')).replaceAll('!!js ', '')
  return yaml.load(text)
}

async function readJson(relative) {
  return JSON.parse(await readFile(join(root, relative), 'utf8'))
}

async function exists(relative) {
  try {
    await stat(join(root, relative))
    return true
  } catch {
    return false
  }
}

test('manifest advertises one bundle, one preset entry set, and a client half', async () => {
  const manifest = await readJson('package.json')
  assert.equal(manifest.name, 'dsh-coding')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  for (const subpath of ['.', './preset', './editor', './verifier', './client']) {
    const entry = manifest.exports[subpath]
    assert.ok(entry, `exports ${subpath}`)
    const target = typeof entry === 'string' ? entry : entry.default
    assert.equal(await exists(target.replace('./', '')), true, `built artifact for ${subpath}: ${target}`)
  }
  assert.equal(await exists('icon.svg'), true)
  assert.equal(await exists('locale/zh.json'), true)
  assert.equal(await exists('locale/en.json'), true)
})

test('display metadata is localized and names the delivered capability', async () => {
  for (const locale of ['zh', 'en']) {
    const file = await readJson(`locale/${locale}.json`)
    assert.equal(typeof file.meta.title, 'string')
    assert.ok(file.meta.title.length > 3, `${locale} title`)
    assert.ok(file.meta.description.length > 20, `${locale} description`)
    assert.equal(file.meta.detail, 'README.md')
    assert.equal(await exists(file.meta.detail), true)
  }
})

test('the patch declares the Coding preset and four explicit worker presets', async () => {
  const patch = await readPatch()
  const rows = patch[0].insert
  assert.deepEqual(rows.map((row) => row.id), [
    'dsh-coding',
    'preset-dsh-coding',
    'preset-dsh-coding-planner',
    'preset-dsh-coding-implement',
    'preset-dsh-coding-verify',
    'preset-dsh-coding-verify-instructions',
  ])

  const settings = rows[0]
  assert.equal(settings.name, 'dsh-coding')
  assert.equal(settings.config.defaultMode, 'auto')
  assert.equal(settings.config.reasoning, 'auto')
  assert.match(settings.config.implementWorkerModel, /^[^/\s]+\/[^/\s]+$/)
  assert.match(settings.config.plannerWorkerModel, /^[^/\s]+\/[^/\s]+$/)
  assert.equal(settings.config.plannerWorkerModel, 'deepseek-account/deepseek-v4-pro')
  assert.equal(settings.config.requirePlanner, 'complex', 'the codex planner gate ships switched on')
  assert.match(settings.config.verifyWorkerModel, /^[^/\s]+\/[^/\s]+$/)

  const coding = rows[1].config
  assert.equal(coding.id, 'dsh-coding')
  assert.equal(coding.name, 'Coding')
  const codingRows = coding.plugins.map((row) => row.id)
  assert.ok(codingRows.includes('dsh-coding-preset'), 'mounts the enforced runtime')
  assert.ok(codingRows.includes('dsh-coding-editor'), 'the gate has an edit tool to refuse')
  assert.ok(codingRows.includes('tool-todo'), 'todo_write is the plan gate')
  const fsRow = coding.plugins.find((row) => row.id === 'tool-fs')
  assert.equal(fsRow.config.applyPatch, false, 'the runtime registers apply_patch, not tool-fs')
})

test('the settings service activates from the patch row and keeps every worker route', async () => {
  // The bug this covers: the service re-mapped the row's fields by hand, so a
  // route added to the schema afterwards (`plannerWorkerModel`) never reached
  // `normalizeConfig`. Activation threw, `dshCodingRuntime` never appeared, and
  // the Coding preset stayed unmountable — no picker entry, no session resume.
  const { default: DshCodingSettings } = await import('../lib/index.js')
  const patch = await readPatch()
  const row = patch[0].insert.find((entry) => entry.id === 'dsh-coding')
  const provided = []
  const child = {
    settings: { configure() {} },
    agentPresets: { remoteExportList: async () => ({ presets: [] }) },
    effect(run) { return run() },
  }
  const ctx = {
    reflect: { provide(name) { provided.push(name) } },
    inject(_deps, callback) { callback(child) },
  }

  const service = new DshCodingSettings(ctx, row.config)
  assert.deepEqual(provided, ['dshCodingRuntime'], 'the service is registered under its documented name')
  // The retry budgets are new since this row was written, so the value comes
  // from the patch when it sets one and from the schema default otherwise.
  assert.deepEqual(service.options, {
    defaultMode: row.config.defaultMode,
    implementWorkerModel: row.config.implementWorkerModel,
    plannerWorkerModel: row.config.plannerWorkerModel,
    verifyWorkerModel: row.config.verifyWorkerModel,
    language: row.config.language,
    reasoning: row.config.reasoning,
    requirePlanner: row.config.requirePlanner ?? 'complex',
    maxVerifyAttempts: row.config.maxVerifyAttempts ?? 5,
    maxSameFailure: row.config.maxSameFailure ?? 2,
    verificationTimeoutMs: row.config.verificationTimeoutMs ?? 360000,
    verificationCommands: row.config.verificationCommands,
  })
})

test('the implement worker whitelist is stated in its composition', async () => {
  const patch = await readPatch()
  const preset = patch[0].insert.find((row) => row.id === 'preset-dsh-coding-implement').config
  assert.equal(preset.id, 'dsh-coding-implement')
  const ids = preset.plugins.map((row) => row.id)
  assert.deepEqual(ids, ['persona', 'tool-fs', 'tool-fs-search', 'agent-instructions', 'dsh-coding-editor'])
  assert.equal(ids.includes('tool-bash'), false, 'no shell in the implement worker')
  assert.equal(ids.includes('tool-web'), false)
  const fsRow = preset.plugins.find((row) => row.id === 'tool-fs')
  assert.equal(fsRow.config.write, true)
  assert.equal(fsRow.config.edit, true)
  assert.equal(fsRow.config.applyPatch, false)
  const instructions = preset.plugins.find((row) => row.id === 'agent-instructions')
  assert.equal(instructions.name, '@deepseek-ai/dsh-agent-instructions')
  assert.equal(instructions.config.maxBytes, 65536)
})

test('the verify worker is read-only apart from the structured verifier', async () => {
  const patch = await readPatch()
  const preset = patch[0].insert.find((row) => row.id === 'preset-dsh-coding-verify').config
  assert.equal(preset.id, 'dsh-coding-verify')
  const ids = preset.plugins.map((row) => row.id)
  assert.deepEqual(ids, ['persona', 'tool-fs', 'tool-fs-search', 'dsh-coding-verifier'])
  assert.equal(ids.includes('agent-instructions'), false, 'the lean verify preset injects no repository instructions')
  assert.equal(ids.includes('tool-bash'), false, 'verification runs through run_verification only')
  const fsRow = preset.plugins.find((row) => row.id === 'tool-fs')
  assert.equal(fsRow.config.write, false)
  assert.equal(fsRow.config.edit, false)
  assert.equal(fsRow.config.applyPatch, false)
})

test('the verify-instructions worker keeps the lean whitelist plus the injected instructions', async () => {
  const patch = await readPatch()
  const preset = patch[0].insert.find((row) => row.id === 'preset-dsh-coding-verify-instructions').config
  assert.equal(preset.id, 'dsh-coding-verify-instructions')
  assert.equal(preset.order, 92)
  const ids = preset.plugins.map((row) => row.id)
  assert.deepEqual(ids, ['persona', 'tool-fs', 'tool-fs-search', 'dsh-coding-verifier', 'agent-instructions'])
  const fsRow = preset.plugins.find((row) => row.id === 'tool-fs')
  assert.equal(fsRow.config.write, false, 'injecting instructions never widens the worker to writing')
  assert.equal(fsRow.config.edit, false)
  assert.equal(fsRow.config.applyPatch, false)
  const instructions = preset.plugins.find((row) => row.id === 'agent-instructions')
  assert.equal(instructions.name, '@deepseek-ai/dsh-agent-instructions')
  assert.equal(instructions.config.maxBytes, 65536, 'the cap matches the main preset so instructions are not truncated')
})

test('the planner worker is read-only and holds no edit or shell tool', async () => {
  const patch = await readPatch()
  const preset = patch[0].insert.find((row) => row.id === 'preset-dsh-coding-planner').config
  assert.equal(preset.id, 'dsh-coding-planner')
  const ids = preset.plugins.map((row) => row.id)
  assert.deepEqual(ids, ['persona', 'tool-fs', 'tool-fs-search', 'tool-web'])
  assert.equal(ids.includes('tool-bash'), false, 'the planner explores without a shell')
  assert.equal(ids.includes('dsh-coding-editor'), false, 'the planner never edits')
  const fsRow = preset.plugins.find((row) => row.id === 'tool-fs')
  assert.equal(fsRow.config.write, false)
  assert.equal(fsRow.config.edit, false)
  assert.equal(fsRow.config.applyPatch, false)
})

test('the client bundle is wrapped for the browser module table', async () => {
  const code = await readFile(join(root, 'lib', 'client.js'), 'utf8')
  assert.match(code, /window\.__ModuleLoader__\.load\(/)
  assert.match(code, /id: "dsh-coding"/)
  assert.match(code, /factory: \(require\)/)
  assert.ok(!code.includes('node:fs'), 'the browser half must not import Node built-ins')
})

test('the host build keeps DSH packages external instead of vendoring them', async () => {
  // Shared providers are resolved from the DSH installation at runtime, never
  // bundled: the profile links this package without a node_modules of its own.
  for (const [entry, dependency] of [
    ['lib/index.js', '@deepseek-ai/cordis'],
    ['lib/config.js', '@deepseek-ai/schemastery'],
    ['lib/apply-patch.js', '@deepseek-ai/dsh-tools'],
    ['lib/preset.js', '@deepseek-ai/dsh-tools'],
    ['lib/messages.js', '@deepseek-ai/dsh-llm'],
  ]) {
    const code = await readFile(join(root, entry), 'utf8')
    assert.match(code, new RegExp(dependency.replace('/', '\\/')), `${entry} imports ${dependency} at runtime`)
  }
  for (const entry of ['lib/index.js', 'lib/preset.js', 'lib/editor.js', 'lib/verifier.js', 'lib/client.js']) {
    const code = await readFile(join(root, entry), 'utf8')
    assert.ok(!code.includes('node_modules'), `${entry} does not vendor another package`)
  }
})
