/**
 * The `auto` sentinel of the three worker model fields.
 *
 * `auto` is not a route: at dispatch time the worker follows the lead's
 * current (chat-box) model. Host and browser halves share this module so the
 * literal is written once, and so the browser bundle never pulls in the
 * configuration schema just to compare a string.
 *
 * @module dsh-coding/worker-auto
 */

/** The configured value meaning "follow the lead's current model". */
export const WORKER_AUTO = 'auto'

/**
 * Whether a configured worker field holds the `auto` sentinel.
 * @param raw - the configuration value, possibly absent or of another type.
 * @returns true only for a string that trims to exactly `auto`.
 */
export function isWorkerAuto(raw: unknown): boolean {
  return typeof raw === 'string' && raw.trim() === WORKER_AUTO
}
