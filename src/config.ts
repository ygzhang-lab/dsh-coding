/**
 * Configuration contract of the `dsh-coding` bundle.
 *
 * The same contract is stated three ways on purpose: {@link CodingConfig} for
 * TypeScript, {@link Config} (Schemastery) for the Loader's activation-time
 * validation, and {@link configJsonSchema} for non-Loader consumers such as the
 * plugin page and the tests. `normalizeConfig` adds the checks a schema cannot
 * state — in particular that a worker model names a real `provider/model`
 * route, because a silent fall-back to the lead's own model is the one outcome
 * this plugin must never allow.
 *
 * @module dsh-coding/config
 */
import z from '@deepseek-ai/schemastery'
import { CODING_MODES, type CodingMode } from './stages.js'
import { LANGUAGE_MODES, normalizeLanguageMode, type LanguageMode } from './language.js'
import { volatileValue } from './volatile.js'

export { volatileValue }

/** Reasoning-level policies the plugin accepts. */
export const REASONING_MODES = ['auto', 'low', 'high', 'max'] as const
/** One reasoning-level policy: auto classifies, the others pin. */
export type ReasoningMode = typeof REASONING_MODES[number]

/** planner 门禁策略：`complex` 对复杂 codex 任务强制 planner，`off` 关闭该门禁。 */
export const PLANNER_GATE_MODES = ['complex', 'off'] as const
/** 一条 planner 门禁策略。 */
export type PlannerGateMode = typeof PLANNER_GATE_MODES[number]

/** One resolved `provider/model` route for a worker subagent. */
export interface WorkerRoute {
  readonly provider: string
  readonly model: string
}

/**
 * Verified plugin configuration.
 *
 * Every field is required or defaulted by {@link Config}; the worker routes are
 * required strings because dispatch refuses to inherit the lead's model.
 */
export interface CodingConfig {
  /** Mode a new Coding session starts in. Defaults to `auto`. */
  readonly defaultMode: CodingMode
  /** `provider/model` route for the implement worker. Required. */
  readonly implementWorkerModel: string
  /** `provider/model` route for the verify worker. Required. */
  readonly verifyWorkerModel: string
  /**
   * `provider/model` route for the planner worker (pro model). Required.
   */
  readonly plannerWorkerModel: string
  /**
   * planner 门禁：`complex` 时 codex 任务单超过三条且未派发过 `delegate_plan`
   * 就不能进入 implement；`off` 关闭该门禁。
   */
  readonly requirePlanner: PlannerGateMode
  /**
   * Conversation language: `auto` follows the DSH interface, then the host
   * locale; `zh` / `en` pin it. The prompt fixes replies, todo items, and
   * delivery notes to it.
   */
  readonly language: LanguageMode
  /**
   * Reasoning-level policy: `auto` classifies each turn from the request, while
   * `low` / `high` / `max` pin every turn. A session override (chat box or
   * `coding_reasoning`) only applies while the policy is `auto`.
   */
  readonly reasoning: ReasoningMode
  /**
   * Verification-failure retry budget of one session: every failed verification
   * spends one attempt, and once the budget is gone the runtime delivers a
   * blocked result that names the failure instead of looping forever. `0` means
   * no limit.
   */
  readonly maxVerifyAttempts: number
  /**
   * How many times the identical failure may repeat before the runtime stops
   * retrying and delivers blocked. `0` means no limit.
   */
  readonly maxSameFailure: number
  /**
   * Longest running time of one verification command, in milliseconds. A check
   * that outlives it is terminated and counted as a failed verification, so a
   * test script that never exits cannot block the run. `0` means no limit.
   */
  readonly verificationTimeoutMs: number
  /**
   * Verification command overrides, keyed by `kind` (`test`, `build`, `lint`,
   * `typecheck`) or by `kind` plus scope (`test:targeted`, `test:full`, …).
   * An absent entry is detected from the project's own package manifest.
   */
  readonly verificationCommands: Readonly<Record<string, string>>
}

/**
 * Type face of the same-named {@link Config} schema, so an importer can write
 * `import { Config } from 'dsh-coding'` and use it as both the value schema and
 * the configuration type.
 */
export interface Config extends CodingConfig {}

/** Schemastery schema the Loader validates the bundle row's `config` with. */
export const Config: z<Config> = z.object({
  // Volatile: the plugin manager page edits these in place, and the runtime
  // reads the live value on every stage decision and dispatch.
  defaultMode: z.union(CODING_MODES as unknown as CodingMode[]).default('auto').volatile(),
  implementWorkerModel: z.string().required().volatile(),
  verifyWorkerModel: z.string().required().volatile(),
  plannerWorkerModel: z.string().required().volatile(),
  // planner 门禁：不可在插件页修改，改动写入 bundle 的 patch config。
  requirePlanner: z.union(PLANNER_GATE_MODES as unknown as PlannerGateMode[]).default('complex'),
  // Volatile: the plugin page switches the conversation language in place, and
  // the prompt reads the live value at assembly time.
  language: z.union(LANGUAGE_MODES as unknown as LanguageMode[]).default('auto').volatile(),
  // Volatile: the plugin page switches the level in place, and every stage's
  // reasoning decision reads the live value.
  reasoning: z.union(REASONING_MODES as unknown as ReasoningMode[]).default('auto').volatile(),
  // Retry budgets of the verify loop; a blocked delivery is the exit that keeps
  // a failing run from looping. Change them in the bundle's patch config.
  maxVerifyAttempts: z.natural().default(5),
  maxSameFailure: z.natural().default(2),
  // Hard deadline of one verification command (six minutes by default), so a
  // hanging test script is terminated instead of awaited forever.
  verificationTimeoutMs: z.natural().default(360000),
  // A record has no volatile form; change it in the bundle's patch config.
  verificationCommands: z.dict(z.string()).default({}),
}) as unknown as z<Config>

/** The same contract as plain JSON Schema, for consumers that never load the plugin. */
export const configJsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'dsh-coding configuration',
  type: 'object',
  additionalProperties: false,
  required: ['implementWorkerModel', 'verifyWorkerModel', 'plannerWorkerModel'],
  properties: {
    defaultMode: {
      type: 'string',
      enum: [...CODING_MODES],
      default: 'auto',
      description: 'Mode a new Coding session starts in.',
    },
    implementWorkerModel: {
      type: 'string',
      pattern: '^[^/\\s]+/[^/\\s]+$',
      description: 'provider/model route for the implement worker; never inherited from the lead.',
    },
    verifyWorkerModel: {
      type: 'string',
      pattern: '^[^/\\s]+/[^/\\s]+$',
      description: 'provider/model route for the verify worker; never inherited from the lead.',
    },
    plannerWorkerModel: {
      type: 'string',
      pattern: '^[^/\\s]+/[^/\\s]+$',
      description: 'provider/model route for the planner worker (pro model); never inherited from the lead.',
    },
    requirePlanner: {
      type: 'string',
      enum: [...PLANNER_GATE_MODES],
      default: 'complex',
      description: 'Require the planner worker for a complex codex run; complex or off.',
    },
    language: {
      type: 'string',
      enum: [...LANGUAGE_MODES],
      default: 'auto',
      description: 'Conversation language: auto follows the DSH interface, then the host locale.',
    },
    reasoning: {
      type: 'string',
      enum: [...REASONING_MODES],
      default: 'auto',
      description: 'Reasoning level: auto classifies each turn; low, high, and max pin every turn.',
    },
    maxVerifyAttempts: {
      type: 'integer',
      minimum: 0,
      default: 5,
      description: 'Failed verifications allowed before the run delivers blocked; 0 means no limit.',
    },
    maxSameFailure: {
      type: 'integer',
      minimum: 0,
      default: 2,
      description: 'Repeats of the identical failure allowed before delivering blocked; 0 means no limit.',
    },
    verificationTimeoutMs: {
      type: 'integer',
      minimum: 0,
      default: 360000,
      description: 'Longest running time of one verification command in ms; a timeout counts as a failed verification; 0 means no limit.',
    },
    verificationCommands: {
      type: 'object',
      additionalProperties: { type: 'string' },
      default: {},
      description: 'Verification command overrides keyed by kind or kind:scope.',
    },
  },
} as const

/** The verification kinds `run_verification` accepts. */
export const VERIFICATION_KINDS = ['test', 'build', 'lint', 'typecheck'] as const
/** The verification scopes `run_verification` accepts. */
export const VERIFICATION_SCOPES = ['targeted', 'package', 'full'] as const

/** One accepted verification kind. */
export type VerificationKind = typeof VERIFICATION_KINDS[number]
/** One accepted verification scope. */
export type VerificationScope = typeof VERIFICATION_SCOPES[number]

/**
 * Parse a `provider/model` route. Both halves are required: an omitted provider
 * would let the request silently inherit the lead's route, which is exactly the
 * fall-back the plugin refuses.
 * @param raw - configured route text.
 * @param field - configuration field name, for an actionable failure.
 * @returns the split route.
 * @throws when the value is not exactly `provider/model`.
 */
export function parseWorkerRoute(raw: unknown, field: string): WorkerRoute {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') {
    throw new Error(
      `dsh-coding: ${field} is required and must be a "provider/model" route `
      + '(for example "deepseek-account/deepseek-flash"); the worker never inherits the lead\'s model',
    )
  }
  const match = /^([^/\s]+)\/([^/\s]+)$/u.exec(text)
  if (match === null) {
    throw new Error(
      `dsh-coding: ${field} must be "provider/model" (got ${JSON.stringify(text)}); `
      + 'the worker never inherits the lead\'s model',
    )
  }
  return { provider: match[1] as string, model: match[2] as string }
}

/**
 * Verify a decoded (or directly applied) configuration and fill the defaults a
 * direct `apply()` call would otherwise miss.
 * @param raw - Loader-validated config, or a hand-authored object in tests.
 * @returns the verified configuration.
 * @throws when a worker route is absent or malformed.
 */
export function normalizeConfig(raw: Partial<CodingConfig> | undefined): CodingConfig {
  const mode = volatileValue(raw?.defaultMode) as CodingMode | undefined
  const maxVerifyAttempts = volatileValue(raw?.maxVerifyAttempts)
  const maxSameFailure = volatileValue(raw?.maxSameFailure)
  const verificationTimeoutMs = volatileValue(raw?.verificationTimeoutMs)
  const commands = volatileValue(raw?.verificationCommands)
  const clean: Record<string, string> = {}
  if (typeof commands === 'object' && commands !== null) {
    for (const [key, value] of Object.entries(commands)) {
      if (typeof value === 'string' && value.trim() !== '') clean[key] = value
    }
  }
  const implementWorkerModel = volatileValue(raw?.implementWorkerModel)
  const verifyWorkerModel = volatileValue(raw?.verifyWorkerModel)
  const plannerWorkerModel = volatileValue(raw?.plannerWorkerModel)
  const requirePlanner = volatileValue(raw?.requirePlanner)
  const language = volatileValue(raw?.language)
  const reasoning = volatileValue(raw?.reasoning)
  // Parse eagerly so a malformed route fails activation, not the first dispatch.
  parseWorkerRoute(implementWorkerModel, 'implementWorkerModel')
  parseWorkerRoute(verifyWorkerModel, 'verifyWorkerModel')
  parseWorkerRoute(plannerWorkerModel, 'plannerWorkerModel')
  return {
    defaultMode: mode !== undefined && (CODING_MODES as readonly string[]).includes(mode) ? mode : 'auto',
    implementWorkerModel: String(implementWorkerModel).trim(),
    verifyWorkerModel: String(verifyWorkerModel).trim(),
    plannerWorkerModel: String(plannerWorkerModel).trim(),
    requirePlanner: (PLANNER_GATE_MODES as readonly string[]).includes(requirePlanner as string)
      ? requirePlanner as PlannerGateMode
      : 'complex',
    language: normalizeLanguageMode(language),
    reasoning: (REASONING_MODES as readonly string[]).includes(reasoning as string)
      ? reasoning as ReasoningMode
      : 'auto',
    maxVerifyAttempts: retryBudget(maxVerifyAttempts, 5),
    maxSameFailure: retryBudget(maxSameFailure, 2),
    verificationTimeoutMs: retryBudget(verificationTimeoutMs, 360000),
    verificationCommands: clean,
  }
}

/**
 * Read one non-negative integer setting (a retry budget or a timeout): the
 * value when it is a non-negative integer, the default otherwise.
 * @param value - decoded configuration value.
 * @param fallback - default used when the value is absent or out of range.
 * @returns the budget or timeout, where `0` means unlimited.
 */
function retryBudget(value: unknown, fallback: number): number {
  return Number.isInteger(value) && (value as number) >= 0 ? value as number : fallback
}

/**
 * Pick the configured command for a verification request.
 * @param config - verified configuration.
 * @param kind - requested kind.
 * @param scope - requested scope.
 * @returns the most specific configured command, when one exists.
 */
export function configuredCommand(
  config: CodingConfig,
  kind: VerificationKind,
  scope: VerificationScope,
): string | undefined {
  const scoped = config.verificationCommands[`${kind}:${scope}`]
  if (scoped !== undefined) return scoped
  return config.verificationCommands[kind]
}
