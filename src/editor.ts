/**
 * The Codex `apply_patch` editor as a preset entry.
 *
 * It is mounted by the Coding preset (so the stage gate has an edit tool to
 * refuse, and so the `implement` table trim has something to remove) **and** by
 * the implement worker preset (where it is the core editing tool). The parser
 * and the expected-excerpt mismatch report are the original Codex dialect,
 * unchanged.
 *
 * @module dsh-coding/editor
 */
import { registerApplyPatch } from './apply-patch.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-coding-editor'

/** The editor needs the tool registry and the composed filesystem. */
export const inject = ['tools', 'fs']

/**
 * Register `apply_patch` in this preset's scope.
 * @param ctx - preset scope that owns the registration.
 */
export function apply(ctx: any): void {
  registerApplyPatch(ctx)
}
