/**
 * Small helper for reading Schemastery volatile values.
 *
 * It lives in its own module on purpose: a plugin reload after editing a shared
 * module can keep the old generation of that module cached, so a newly exported
 * symbol must come from a new file to be importable without a full restart.
 *
 * @module dsh-coding/config/volatile
 */

/**
 * Read one configured value through a Schemastery volatile accessor, or use it
 * directly when the caller passed a plain object (direct `apply()` in tests, or
 * a schema generation that did not mark the field volatile).
 * @param value - schema-resolved value or `Volatile` wrapper.
 * @returns the current raw value.
 */
export function volatileValue(value: unknown): unknown {
  const accessor = value as { get?: () => unknown } | null | undefined
  return typeof accessor?.get === 'function' ? accessor.get() : value
}