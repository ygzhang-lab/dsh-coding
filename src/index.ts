/**
 * Host-side settings service of the `dsh-coding` bundle.
 *
 * This row is the bundle's only Host contribution: it owns the verified
 * configuration the Coding preset and its four worker presets read, and it
 * performs no agent work by itself. Installing the bundle therefore changes no
 * existing session; only a session that selects the Coding preset runs the
 * enforced runtime.
 *
 * It also filters this bundle's four internal worker presets out of the exported
 * preset roster: no client offers them, while the Host roster keeps resolving
 * the compositions `delegate_implement` and `delegate_verify` dispatch to.
 *
 * The configuration is validated twice on purpose: {@link Config} (Schemastery)
 * rejects a malformed row at activation, and {@link normalizeConfig} parses both
 * worker routes so a missing model fails the mount instead of silently
 * inheriting the lead's own model at dispatch.
 *
 * @module dsh-coding
 */
import { Service } from '@deepseek-ai/cordis'
import {
  Config as CodingConfigSchema,
  configJsonSchema,
  normalizeConfig,
  type CodingConfig,
} from './config/config.js'
import { WORKER_PRESETS } from './core/stages.js'

// `Config` carries both meanings: the Schemastery schema (value) and the
// configuration type (interface) it validates.
export { Config, configJsonSchema, parseWorkerRoute } from './config/config.js'
export type { CodingConfig, WorkerRoute } from './config/config.js'

/** The same JSON Schema under the name non-Loader consumers expect. */
export const configSchema = configJsonSchema

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-coding'

/** Preset ids this bundle reserves for its subagents, never offered to a user. */
const WORKER_PRESET_IDS: readonly string[] = [
  WORKER_PRESETS.planner,
  WORKER_PRESETS.implement,
  WORKER_PRESETS.verify,
  WORKER_PRESETS.verifyWithInstructions,
]

/** One roster row as the preset registry exports it. */
interface RosterRow {
  readonly id: string
}

/**
 * The client-facing roster without this bundle's worker presets. The Host
 * roster keeps them: `delegate_implement` / `delegate_verify` resolve their
 * compositions from it, and only the exported list is a user-facing surface.
 * @param roster - `remoteExportList()` result.
 * @returns the same roster minus the worker rows.
 */
export function filterWorkerPresets<T extends { presets: readonly RosterRow[] }>(roster: T): T {
  return { ...roster, presets: roster.presets.filter(row => !WORKER_PRESET_IDS.includes(row.id)) } as T
}

/**
 * Filter the preset registry's client-facing export for this deployment.
 *
 * DSH has no hidden-preset flag, and a browser-side replacement of the shipped
 * picker costs the product's own chip, copy, and interaction. The registry
 * exports its roster through one Remote method, and the gateway resolves that
 * method per call, so wrapping it here hides the workers from every client
 * surface while the Host keeps dispatching to them.
 * @param ctx - owning host context.
 */
export function installWorkerPresetFilter(ctx: any): void {
  ctx.inject(['agentPresets'], (child: any) => {
    child.effect(() => {
      const registry = child.agentPresets as { remoteExportList?: (...args: any[]) => Promise<any> } | undefined
      const original = registry?.remoteExportList
      if (registry === undefined || typeof original !== 'function') return
      const wrapped = async (...args: any[]): Promise<any> => filterWorkerPresets(await original.apply(registry, args))
      registry.remoteExportList = wrapped
      return () => {
        // Only undo our own wrapper: a later generation may have re-wrapped it.
        if (registry.remoteExportList === wrapped) registry.remoteExportList = original
      }
    }, 'dsh-coding: preset roster filter')
  })
}

/**
 * Bundle settings surface (`ctx.dshCodingRuntime`).
 *
 * The service exposes only immutable, already-verified options: consumers never
 * re-validate, and no agent behavior depends on an unvalidated value.
 */
export default class DshCodingSettings extends Service {
  /** Schemastery schema the Loader validates the bundle row's `config` with. */
  static Config = CodingConfigSchema

  private readonly raw: Partial<CodingConfig>

  /**
   * @param ctx - owning host context.
   * @param config - Loader-validated row configuration. The page-editable fields
   *   arrive as Schemastery volatile accessors, so every read below observes the
   *   value currently saved on the plugin page.
   * @throws when a worker route is absent or not a `provider/model` pair.
   */
  constructor(ctx: any, config: CodingConfig) {
    super(ctx, 'dshCodingRuntime')
    this.raw = config
    // Validate once at activation so a bad row fails loudly; later edits are
    // validated again on every read. `normalizeConfig` reads every field through
    // `volatileValue`, so the row must be passed through unchanged: a hand-copied
    // field map drops any route added later (a missing `plannerWorkerModel` threw
    // here and took the whole bundle's presets down with it).
    normalizeConfig(this.raw)
    // The plugin manager page renders our own configuration form, so the
    // automatic settings page is switched off for this entry.
    ctx.inject(['settings'], (child: any) => {
      child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
    })
    // Hide this bundle's internal worker presets from the exported roster.
    installWorkerPresetFilter(ctx)
  }

  /**
   * Verified configuration, re-read from the volatile fields on every access.
   * @throws when a page-edited worker route is not a usable `provider/model` pair.
   */
  get options(): CodingConfig {
    return normalizeConfig(this.raw)
  }
}
