/**
 * Isolated mount probe: boot a throwaway profile (base + this bundle) in a
 * temporary DSH_HOME, read the preset roster, and mount the Coding preset the
 * way the session controller does.
 *
 * It never touches the user's profile and makes no model request, so it is the
 * fastest way to prove a composition change did not break the preset.
 *
 * Usage (from the package root):
 *   DSH_HOME=$PWD/.probe-home ELECTRON_RUN_AS_NODE=1 \
 *     "$DSH_NODE" "$DSH_CLI" plugin --profile probe add "$PWD"
 *   DSH_HOME=$PWD/.probe-home PROBE_OVERLAY=$PWD/scripts/probe-overlay.yml \
 *     ELECTRON_RUN_AS_NODE=1 "$DSH_NODE" scripts/mount-probe.mjs
 *   rm -rf .probe-home
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const installDir = process.env.DSH_INSTALL_DIR
  ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh'
const { runProfile } = await import(
  pathToFileURL(join(installDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'profile-boot.js')).href
)

/** Minimal launch-environment snapshot over this process's environment. */
const entry = name => (process.env[name] === undefined ? undefined : { name, value: process.env[name], source: 'process' })
const environment = { get: entry, getFrom: entry }

const { ctx, shutdown } = await runProfile({
  profile: process.env.PROBE_PROFILE ?? 'probe',
  patchFiles: [process.env.PROBE_OVERLAY ?? join(process.cwd(), 'scripts', 'probe-overlay.yml')],
  environment,
  args: [],
})

let failed = false
try {
  const presets = ctx.get('agentPresets')
  console.log('roster:')
  for (const preset of await presets.list()) {
    console.log(` - ${preset.id}${preset.name ? ` (${preset.name})` : ''}${preset.broken ? ` BROKEN: ${preset.broken}` : ''}`)
  }
  console.log('resolve:', (await presets.resolve('dsh-coding')).id)

  const agents = ctx.get('agents')
  const handle = await agents.create({
    sessionId: `probe-${Date.now()}`,
    meta: { cwd: process.cwd() },
    setup: async (agentCtx, agent) => {
      await presets.mount(agentCtx, 'dsh-coding')
      console.log('MOUNT OK')
      // The language section must be visible to prompt assembly, or replies
      // follow the persona's own language instead of the user's.
      const prompt = agentCtx.get('systemPrompt')
      try {
        // Assembly is scoped to the Agent; without the scope only global
        // contributions appear, which is not what a step sees.
        const assembly = await prompt.assemble({ agent, scope: agent })
        const language = assembly.contexts.find(entry => entry.name === 'coding:language')
        console.log('prompt context coding:language:', language === undefined
          ? 'MISSING'
          : JSON.stringify(language.text.split('\n')[0]))
      } catch (error) {
        console.log('prompt assembly:', `FAILED: ${error?.message ?? error}`)
      }
    },
  })
  console.log('tools:', (ctx.get('tools').schemas(handle.agent) ?? []).map(tool => tool.name).sort().join(', '))

  // The conversation card reads this projection; an unregistered key means the
  // card renders nothing even though the session runs.
  const projections = ctx.get('sessionProjections')
  const session = handle.agent?.session
  const projected = session === undefined
    ? undefined
    : projections?.snapshot?.(session, ['dshCodingStage'])?.values?.['dshCodingStage']
  if (projections === undefined) console.log('projection registry: MISSING')
  else if (projected === undefined) console.log('projection dshCodingStage: MISSING')
  else console.log('projection dshCodingStage:', JSON.stringify({ active: projected.active, mode: projected.mode, stage: projected.stage, latest: projected.latest }))

  // Activation proof: the card only renders once the log says this Session
  // selected the Coding preset, which is the same durable event a real
  // session records.
  if (session !== undefined) {
    session.append('agent-preset/selected', { agentPreset: 'dsh-coding' })
    const after = projections?.snapshot?.(session, ['dshCodingStage'])?.values?.['dshCodingStage']
    console.log('after agent-preset/selected:', JSON.stringify({ active: after?.active, mode: after?.mode, stage: after?.stage }))
  }

  const settings = ctx.get('settings')
  const described = settings?.describe({ redactSecrets: true }) ?? []
  const ours = described.find(view => view.ns === 'dsh-coding')
  console.log('settings namespace:', ours === undefined ? 'MISSING' : `${ours.ns} (auto=${ours.autoGenerate}) ${JSON.stringify(ours.value)}`)
  await handle.dispose?.()
} catch (error) {
  failed = true
  console.error('PROBE FAILED:', error?.message ?? error)
} finally {
  try { await shutdown.shutdown(failed ? 1 : 0) } catch { process.exit(failed ? 1 : 0) }
}
