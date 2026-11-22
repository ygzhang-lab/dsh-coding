/**
 * The structured verifier as a preset entry.
 *
 * The verify worker holds no editing tool and no shell: `run_verification` is
 * its only way to execute anything, and that tool cannot write a file. It reads
 * the same bundle configuration as the lead, so both halves resolve a check with
 * the same command.
 *
 * @module dsh-coding/verifier
 */
import { registerVerificationTool } from './verification-tool.js'
import type { CodingConfig } from './config.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-coding-verifier'

/** The registry and the shared bundle settings are required; `subprocess` is awaited. */
export const inject = ['tools', 'dshCodingRuntime']

/**
 * Register `run_verification` in the verify worker's scope.
 * @param ctx - the worker preset's scope context.
 */
export function apply(ctx: any): void {
  const settings = ctx.dshCodingRuntime as { options: CodingConfig }
  ctx.inject(['subprocess'], (child: any) => {
    registerVerificationTool(child, { config: () => settings.options })
  })
}
