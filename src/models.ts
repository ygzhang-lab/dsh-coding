/**
 * Worker model routing: one place that names the configured route of a worker
 * role, resolves it, and proves it usable before dispatch.
 *
 * A worker must never fall back to the lead's own model, so the route is read
 * from the configuration field named by the role, validated as `provider/model`,
 * and checked against the live provider registry and model catalog before the
 * subagent starts. Every lookup here goes to the live service: configuration is
 * volatile and may change between two dispatches, so nothing is cached.
 *
 * @module dsh-coding/models
 */
import { parseWorkerRoute, type CodingConfig, type WorkerRoute } from './config.js'
import { WORKER_PRESETS } from './stages.js'

/** The worker roles this package dispatches. */
export type WorkerRole = 'plan' | 'implement' | 'verify'

/** Every worker role, in dispatch order. */
export const WORKER_ROLES: readonly WorkerRole[] = ['plan', 'implement', 'verify']

/** One worker route with the configuration field and role it came from. */
export interface ResolvedWorkerRoute extends WorkerRoute {
  readonly role: WorkerRole
  /** Configuration field the route was read from, for an actionable failure. */
  readonly field: string
  /** The route as `provider/model`, safe to quote in a message. */
  readonly text: string
}

/** Why a worker route cannot be dispatched. */
export type WorkerModelErrorCode = 'PROVIDER_MISSING' | 'MODEL_UNAVAILABLE'

/** The configuration field each role's route is read from. */
const WORKER_FIELDS: Readonly<
  Record<WorkerRole, 'plannerWorkerModel' | 'implementWorkerModel' | 'verifyWorkerModel'>
> = {
  plan: 'plannerWorkerModel',
  implement: 'implementWorkerModel',
  verify: 'verifyWorkerModel',
}

/** The preset id each role is dispatched with. */
const WORKER_PRESET_BY_ROLE: Readonly<Record<WorkerRole, string>> = {
  plan: WORKER_PRESETS.planner,
  implement: WORKER_PRESETS.implement,
  verify: WORKER_PRESETS.verify,
}

/** The configuration field holding one role's route. */
export function workerField(role: WorkerRole): 'plannerWorkerModel' | 'implementWorkerModel' | 'verifyWorkerModel' {
  return WORKER_FIELDS[role]
}

/** The preset id a worker role is dispatched with. */
export function workerPreset(role: WorkerRole): string {
  return WORKER_PRESET_BY_ROLE[role]
}

/**
 * Read, validate, and describe one role's configured route.
 * @param config - verified configuration.
 * @param role - worker about to be dispatched.
 * @returns the parsed route plus its role, field, and rendered text.
 * @throws when the field is not exactly `provider/model`.
 */
export function resolveWorkerRoute(config: CodingConfig, role: WorkerRole): ResolvedWorkerRoute {
  const field = workerField(role)
  const route = parseWorkerRoute(config[field], field)
  return { role, field, provider: route.provider, model: route.model, text: `${route.provider}/${route.model}` }
}

/** A refused worker route: the configured value, and what the runtime offers instead. */
export class WorkerModelError extends Error {
  readonly code: WorkerModelErrorCode
  readonly role: WorkerRole
  readonly field: string
  readonly route: string
  readonly available: readonly string[]

  constructor(
    message: string,
    details: {
      code: WorkerModelErrorCode
      role: WorkerRole
      field: string
      route: string
      available: readonly string[]
    },
  ) {
    super(message)
    this.name = 'WorkerModelError'
    this.code = details.code
    this.role = details.role
    this.field = details.field
    this.route = details.route
    this.available = details.available
  }
}

/**
 * The provider ids the runtime currently registers, sorted.
 * @param ctx - plugin context (or any object exposing the `llm` service).
 * @returns the ids, or [] when the registry cannot be read.
 */
export function describeProviders(ctx: any): string[] {
  try {
    const llm = ctx?.llm ?? ctx?.get?.('llm')
    if (typeof llm?.listProviders !== 'function') return []
    const providers = llm.listProviders()
    if (!Array.isArray(providers)) return []
    const ids = providers
      .map((provider: any) => provider?.id)
      .filter((id: unknown): id is string => typeof id === 'string' && id !== '')
    return [...new Set(ids)].sort()
  } catch {
    return []
  }
}

/**
 * The model ids one provider advertises, deduplicated and sorted.
 * @param ctx - plugin context (or any object exposing the `llm` service).
 * @param provider - provider id being inspected.
 * @param signal - caller's abort signal; an aborted call lists nothing.
 * @returns the ids, or [] when the catalog is unavailable.
 */
export async function listModelIds(ctx: any, provider: string, signal?: AbortSignal): Promise<string[]> {
  if (signal?.aborted === true) return []
  try {
    const llm = ctx?.llm ?? ctx?.get?.('llm')
    if (typeof llm?.listModels !== 'function') return []
    const models = await llm.listModels(provider)
    if (!Array.isArray(models)) return []
    const ids = models
      .map((model: any) => model?.id)
      .filter((id: unknown): id is string => typeof id === 'string' && id !== '')
    return [...new Set(ids)].sort()
  } catch {
    return []
  }
}

/**
 * Refuse a worker dispatch whose configured route cannot be honoured.
 *
 * The check is deliberately narrow: an unreachable catalog defers to the
 * dispatch instead of blocking it, because listing models may need credentials
 * that the worker itself will supply. A registered-provider mismatch and a
 * failing `resolveModelInfo` are both refusals, with the available alternatives
 * named in the message.
 * @param ctx - plugin context (or any object exposing the `llm` service).
 * @param route - resolved route of the worker about to run.
 * @param signal - caller's abort signal; an abort is rethrown untouched.
 * @throws {WorkerModelError} when the provider is missing or the model unusable.
 */
export async function assertWorkerModel(
  ctx: any,
  route: ResolvedWorkerRoute,
  signal?: AbortSignal,
): Promise<void> {
  const providers = describeProviders(ctx)
  if (providers.length > 0 && !providers.includes(route.provider)) {
    const available = providers.slice(0, 10).join(', ') + (providers.length > 10 ? ', …' : '')
    throw new WorkerModelError(
      `delegate_${route.role}: ${route.field} names LLM provider "${route.provider}", which is not registered; `
      + `available providers: ${available || '(none)'}. Fix ${route.field} in the plugin page or cordis.patch.yml; `
      + 'a worker never falls back to the lead\'s model.',
      { code: 'PROVIDER_MISSING', role: route.role, field: route.field, route: route.text, available: providers },
    )
  }
  const llm = ctx?.llm ?? ctx?.get?.('llm')
  if (typeof llm?.resolveModelInfo !== 'function') return
  try {
    await llm.resolveModelInfo(route.provider, route.model, signal)
  } catch (error) {
    if (signal?.aborted === true) throw error
    const ids = await listModelIds(ctx, route.provider, signal).catch(() => [])
    const available = ids.slice(0, 10).join(', ') + (ids.length > 10 ? ', …' : '')
    throw new WorkerModelError(
      `delegate_${route.role}: ${route.field} = "${route.text}" is not a usable model route: ${messageOf(error)}. `
      + `Available models for provider "${route.provider}": ${available || '(none advertised)'}. `
      + `Fix ${route.field} in the plugin page or cordis.patch.yml; the worker never falls back to the lead's model.`,
      { code: 'MODEL_UNAVAILABLE', role: route.role, field: route.field, route: route.text, available: ids },
    )
  }
}

/** Read an error's message, for a failure that may be any thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
