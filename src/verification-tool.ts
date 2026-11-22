/**
 * The `run_verification` tool, shared by the lead preset and the verify worker.
 *
 * The lead wrapper records the outcome in the stage machine; the worker wrapper
 * reports it back through `structured_output`. Both call the same resolver and
 * the same `ctx.subprocess` execution, so a swap of the subprocess provider
 * changes neither contract.
 *
 * @module dsh-coding/verification-tool
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  VERIFICATION_KINDS,
  VERIFICATION_SCOPES,
  type CodingConfig,
  type VerificationKind,
  type VerificationScope,
} from './config.js'
import { TOOL } from './stages.js'
import {
  VerificationError,
  executeVerification,
  renderVerification,
  resolveVerification,
  type SubprocessLike,
  type VerificationRun,
} from './verification.js'

/** The tool's JSON value: the structured outcome the model and the gate read. */
export interface VerificationToolValue {
  readonly passed: boolean
  readonly kind: VerificationKind
  readonly scope: VerificationScope
  readonly command: string
  readonly exitCode: number | null
  readonly durationMs: number
  readonly ranAt: number
  readonly failedTests: readonly string[]
  readonly errors: readonly string[]
  readonly output: string
  /** Whole-value coding checkpoint, attached only by the lead wrapper. */
  readonly checkpoint?: unknown
}

/** Registration options for {@link registerVerificationTool}. */
export interface VerificationToolOptions {
  /** Read the live plugin configuration. */
  readonly config: () => CodingConfig
  /** Record a completed run (the lead's stage machine); the worker omits it. */
  readonly onRun?: (run: VerificationRun, exec: any) => void
  /** Attach the whole-value checkpoint to the tool value. */
  readonly decorate?: (exec: any) => unknown
}

/** Resolve the session's working directory, falling back to its header. */
async function sessionCwd(ctx: any, agent: any, signal: AbortSignal): Promise<string> {
  const workingDirectory = ctx.get?.('workingDirectory')
  if (typeof workingDirectory?.ensure === 'function') {
    try {
      const value = await workingDirectory.ensure(agent, signal)
      if (typeof value === 'string' && value !== '') return value
    } catch {
      // The session header remains the fallback.
    }
  }
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
}

/** The tool description, kept short enough to ride in every request. */
const DESCRIPTION = [
  'Run one verification through the project\'s own tooling and record the structured result.',
  'Resolve the command from the package scripts (or the plugin\'s verificationCommands override),',
  'execute it through the subprocess provider, and return pass/fail, failing tests, key errors, exit code, and duration.',
  'Use the narrowest scope that proves the change: targeted, then package, then full.',
  'A failing result blocks the deliver stage until a later run passes.',
  'Each command is bounded by the plugin\'s verificationTimeoutMs.',
].join(' ')

/** Author-facing output schema: requiredness is a per-property annotation here. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    passed: { type: 'boolean', required: true },
    kind: { type: 'string', required: true },
    scope: { type: 'string', required: true },
    command: { type: 'string', required: true },
    exitCode: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    durationMs: { type: 'number', required: true },
    ranAt: { type: 'number', required: true },
    failedTests: { type: 'array', items: { type: 'string' } },
    errors: { type: 'array', items: { type: 'string' } },
    output: { type: 'string', required: true },
    checkpoint: { type: 'json' },
  },
} as const

/**
 * Register `run_verification` in one scope.
 * @param ctx - scope that owns the registration (and therefore its disposal).
 * @param options - configuration access and the optional state recorder.
 */
export function registerVerificationTool(ctx: any, options: VerificationToolOptions): void {
  const tool = defineTool({
    name: TOOL.verification,
    description: DESCRIPTION,
    parameters: {
      kind: {
        type: 'string' as const,
        enum: [...VERIFICATION_KINDS],
        required: true,
        description: 'test | build | lint | typecheck',
      },
      scope: {
        type: 'string' as const,
        enum: [...VERIFICATION_SCOPES],
        required: true,
        description: 'targeted/package (nearest package root) | full (repository root)',
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args: unknown, value: any) => [{
        type: 'text',
        text: renderVerification({
          passed: value.passed,
          kind: value.kind,
          scope: value.scope,
          source: 'lead',
          command: value.command,
          exitCode: value.exitCode,
          durationMs: value.durationMs,
          failedTests: value.failedTests,
          errors: value.errors,
          ranAt: value.ranAt,
          output: value.output,
        }),
      }],
      ...options.decorate === undefined ? {} : {
        presentationMeta: (_args: unknown, value: any): any => (
          value.checkpoint === undefined ? null : value.checkpoint
        ),
      },
    },
    timeoutMs: 1_800_000,
    async execute(args: { kind?: VerificationKind; scope?: VerificationScope }, exec: any): Promise<any> {
      if (exec.agent === undefined) throw new Error('run_verification requires an owning agent session')
      const kind = args?.kind
      const scope = args?.scope
      if (kind === undefined || !(VERIFICATION_KINDS as readonly string[]).includes(kind)) {
        throw new VerificationError(`kind must be one of ${VERIFICATION_KINDS.join(', ')}`)
      }
      if (scope === undefined || !(VERIFICATION_SCOPES as readonly string[]).includes(scope)) {
        throw new VerificationError(`scope must be one of ${VERIFICATION_SCOPES.join(', ')}`)
      }
      const subprocess = ctx.get?.('subprocess') as SubprocessLike | undefined
      if (subprocess === undefined || typeof subprocess.spawn !== 'function') {
        throw new VerificationError('the `subprocess` service is unavailable in this deployment')
      }
      const cwd = await sessionCwd(ctx, exec.agent, exec.signal)
      const startedAt = Date.now()
      let resolved
      try {
        resolved = await resolveVerification(options.config(), cwd, kind, scope)
      } catch (error) {
        // A missing command is still evidence: record why the check could not
        // run, so a review-mode delivery can disclose it instead of dead-locking.
        options.onRun?.(unavailableRun(kind, scope, error, startedAt), exec)
        throw error
      }
      let run
      try {
        run = await executeVerification(
          subprocess,
          resolved,
          kind,
          scope,
          'lead',
          exec.signal,
          options.config().verificationTimeoutMs,
        )
      } catch (error) {
        options.onRun?.(unavailableRun(kind, scope, error, startedAt), exec)
        throw error
      }
      options.onRun?.(run, exec)
      const value: VerificationToolValue = {
        passed: run.passed,
        kind: run.kind,
        scope: run.scope,
        command: run.command,
        exitCode: run.exitCode,
        durationMs: run.durationMs,
        ranAt: run.ranAt,
        failedTests: run.failedTests,
        errors: run.errors,
        output: run.output,
        ...options.decorate === undefined ? {} : { checkpoint: options.decorate(exec) },
      }
      return value
    },
  })
  ctx.effect(() => ctx.tools.register(tool), 'dsh-coding: run_verification')
}

/** A recorded outcome for a check that could not even start or run. */
function unavailableRun(
  kind: VerificationKind,
  scope: VerificationScope,
  error: unknown,
  startedAt: number,
): VerificationRun {
  return {
    passed: false,
    kind,
    scope,
    source: 'lead',
    command: '',
    exitCode: null,
    durationMs: Date.now() - startedAt,
    failedTests: [],
    errors: [messageOf(error)],
    ranAt: startedAt,
    output: '',
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
