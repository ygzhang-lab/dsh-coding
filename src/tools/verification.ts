/**
 * Project-aware verification execution.
 *
 * Resolution reads the project's own manifest (package scripts, lockfile
 * manager) and the plugin's configured overrides; execution goes through the
 * `ctx.subprocess` Service Definition, never through a hard-coded local
 * runner. A deployment that swaps the subprocess provider (a remote sandbox,
 * for example) keeps this tool's contract unchanged.
 *
 * @module dsh-coding/tools/verification
 */
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import {
  configuredCommand,
  type CodingConfig,
  type VerificationKind,
  type VerificationScope,
} from '../config/config.js'
import type { VerificationOutcome } from '../core/stages.js'

/** Package managers this resolver understands. */
export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun'

/** One resolved verification command and where it runs. */
export interface ResolvedCommand {
  readonly command: string
  readonly cwd: string
  readonly script?: string
  readonly packageManager?: PackageManager
}

/** Full result of one verification run: the gate outcome plus model-facing text. */
export interface VerificationRun extends VerificationOutcome {
  /** Bounded combined output, for the model-facing result. */
  readonly output: string
}

/** Failure raised before or during a verification run, with an actionable message. */
export class VerificationError extends Error {
  constructor(message: string) {
    super(`run_verification: ${message}`)
    this.name = 'VerificationError'
  }
}

const MAX_PACKAGE_JSON_BYTES = 512 * 1024
const OUT_MAX_BYTES = 256 * 1024
const ERR_MAX_BYTES = 128 * 1024
const OUTPUT_TAIL_CHARS = 4000
const MAX_FAILED_TESTS = 20
const MAX_ERROR_LINES = 15

/** Whether a path is a regular file. */
async function isFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile()
  } catch {
    return false
  }
}

/** Walk up from `start` to the first directory holding a regular file named `name`. */
async function nearestWith(start: string, name: string, limit = 24): Promise<string | undefined> {
  let current = resolve(start)
  for (let depth = 0; depth < limit; depth += 1) {
    if (await isFile(join(current, name))) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

/** Whether a path is a directory. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isDirectory()
  } catch {
    return false
  }
}

/** Walk up from `start` to the first directory holding `.git` (a file or a directory). */
async function nearestRepoRoot(start: string, limit = 24): Promise<string | undefined> {
  let current = resolve(start)
  for (let depth = 0; depth < limit; depth += 1) {
    if (await isFile(join(current, '.git')) || await isDirectory(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

/** Detect the package manager from the lockfile nearest the package root. */
async function detectManager(packageRoot: string): Promise<PackageManager> {
  let current = packageRoot
  for (let depth = 0; depth < 24; depth += 1) {
    if (await isFile(join(current, 'pnpm-lock.yaml'))) return 'pnpm'
    if (await isFile(join(current, 'bun.lockb')) || await isFile(join(current, 'bun.lock'))) return 'bun'
    if (await isFile(join(current, 'yarn.lock'))) return 'yarn'
    if (await isFile(join(current, 'package-lock.json'))) return 'npm'
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return 'npm'
}

/** Read the `scripts` map of one package.json, tolerating a missing or oversized file. */
async function readScripts(packageRoot: string): Promise<Record<string, string>> {
  try {
    const path = join(packageRoot, 'package.json')
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_PACKAGE_JSON_BYTES) return {}
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    const scripts = (parsed as { scripts?: unknown } | null)?.scripts
    if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) return {}
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(scripts)) {
      if (typeof value === 'string' && value.trim() !== '') result[key] = value
    }
    return result
  } catch {
    return {}
  }
}

/** Candidate script names per verification kind, most specific first. */
const SCRIPT_CANDIDATES: Readonly<Record<VerificationKind, readonly string[]>> = {
  test: ['test', 'test:unit', 'unit'],
  build: ['build', 'compile'],
  lint: ['lint', 'eslint', 'check:lint'],
  typecheck: ['typecheck', 'type-check', 'check:types', 'tsc'],
}

/** Render a package-manager invocation for one script. */
function scriptCommand(manager: PackageManager, script: string): string {
  return manager === 'npm' ? `npm run ${script}` : `${manager} run ${script}`
}

/** Render the shell invocation for one configured command. */
function shellArgv(command: string): readonly string[] {
  return process.platform === 'win32'
    ? ['cmd.exe', '/d', '/s', '/c', command]
    : ['/bin/sh', '-c', command]
}

/**
 * Resolve the concrete command for a verification request.
 * @param config - plugin configuration, whose overrides win over detection.
 * @param cwd - session working directory.
 * @param kind - requested verification kind.
 * @param scope - requested scope; `full` runs from the repository root.
 * @returns the resolved command and directory.
 * @throws {VerificationError} when neither configuration nor the project can supply a command.
 */
export async function resolveVerification(
  config: CodingConfig,
  cwd: string,
  kind: VerificationKind,
  scope: VerificationScope,
): Promise<ResolvedCommand> {
  const repoRoot = await nearestRepoRoot(cwd)
  const packageRoot = await nearestWith(cwd, 'package.json')
  // `full` proves the change at repository scale: resolve the script from the
  // repository root and run it there. `targeted` / `package` stay on the
  // nearest package root.
  const manifestRoot = scope === 'full' ? repoRoot ?? packageRoot : packageRoot
  const runDir = manifestRoot ?? cwd
  const configured = configuredCommand(config, kind, scope)
  if (configured !== undefined) {
    return { command: configured, cwd: runDir }
  }
  if (manifestRoot === undefined) {
    throw new VerificationError(
      `no package.json was found from ${cwd} upward; configure verificationCommands.${kind} `
      + 'in the dsh-coding bundle config to name the command',
    )
  }
  const scripts = await readScripts(manifestRoot)
  const manager = await detectManager(manifestRoot)
  const found = SCRIPT_CANDIDATES[kind].find(name => scripts[name] !== undefined)
  if (found === undefined) {
    const available = Object.keys(scripts).sort().join(', ') || '(none)'
    throw new VerificationError(
      `package.json at ${relative(cwd, manifestRoot) || '.'} has no ${kind} script; `
      + `available scripts: ${available}. Configure verificationCommands.${kind} to override.`,
    )
  }
  return { command: scriptCommand(manager, found), cwd: runDir, script: found, packageManager: manager }
}

/** Parse runner output into failing test names and the most useful error lines. */
export function parseFailure(kind: VerificationKind, stdout: string, stderr: string): {
  failedTests: string[]
  errors: string[]
} {
  const lines = [...stdout.split('\n'), ...stderr.split('\n')]
  const failed = new Set<string>()
  const errors: string[] = []
  const failPatterns: readonly RegExp[] = [
    /^\s*(?:×|✕|✗|✖)\s+(.{1,160})$/u,
    // TAP: "not ok 1 - name"; the plan number and dash are runner bookkeeping.
    /^\s*not ok\s+(?:\d+\s+)?-?\s*(.{1,160})$/u,
    /^\s*FAIL\s+(?:\S+\s+)?-?\s*(.{1,160})$/u,
    /^--- FAIL:\s+(\S+)/u,
    /^\s*(?:●|○)\s+(.{1,160})$/u,
    /^\s*\d+\)\s+(.{1,160})$/u,
  ]
  const errorPatterns: readonly RegExp[] = [
    /\berror\b[: ]/iu,
    /\bexpected\b.*\bbut\b/iu,
    /\bcannot find\b/iu,
    /\b(?:TS\d{4})\b/u,
    /\bfailed\b/iu,
  ]
  for (const line of lines) {
    const text = line.trimEnd()
    if (text.trim() === '') continue
    for (const pattern of failPatterns) {
      const match = pattern.exec(text)
      if (match !== null) {
        failed.add(match[1]!.trim())
        break
      }
    }
    if (errors.length < MAX_ERROR_LINES && errorPatterns.some(pattern => pattern.test(text))) {
      const trimmed = text.trim()
      if (!errors.includes(trimmed)) errors.push(trimmed.slice(0, 300))
    }
    if (failed.size >= MAX_FAILED_TESTS && errors.length >= MAX_ERROR_LINES) break
  }
  return {
    failedTests: [...failed].slice(0, MAX_FAILED_TESTS),
    errors,
  }
}

/** Read one collected stream after the process settled. */
function collectedText(reader: { readFrom(offset: number): { text: string } } | undefined): string {
  if (reader === undefined) return ''
  try {
    return reader.readFrom(0).text
  } catch {
    return ''
  }
}

/** Narrow a service-shaped value to the subprocess surface this module needs. */
export interface SubprocessLike {
  spawn(spec: unknown): {
    readonly done: Promise<{ exitCode: number | null; signal: string | null }>
    readonly collected: {
      readonly stdout?: { readFrom(offset: number): { text: string } }
      readonly stderr?: { readFrom(offset: number): { text: string } }
    }
    /**
     * The seam's termination verb (synchronous, idempotent). Optional here so a
     * narrow fake or an older provider still satisfies the contract.
     */
    terminate?(): void
  }
}

/**
 * Run one verification through the mounted subprocess provider.
 * @param subprocess - the `ctx.subprocess` Service Definition.
 * @param resolved - resolved command and directory.
 * @param kind - requested kind, recorded in the outcome and used for parsing.
 * @param scope - requested scope, recorded in the outcome.
 * @param source - which agent asked for the check, recorded in the outcome.
 * @param signal - caller cancellation; aborts the managed process range.
 * @param timeoutMs - hard deadline of the command in milliseconds; once it
 * elapses the managed range is terminated and the run is reported as a failed
 * verification. `0` disables the deadline.
 * @returns the structured outcome.
 */
export async function executeVerification(
  subprocess: SubprocessLike,
  resolved: ResolvedCommand,
  kind: VerificationKind,
  scope: VerificationScope,
  source: 'lead' | 'worker',
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<VerificationRun> {
  const startedAt = Date.now()
  let handle: ReturnType<SubprocessLike['spawn']>
  try {
    handle = subprocess.spawn({
      argv: [...shellArgv(resolved.command)],
      cwd: resolved.cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: OUT_MAX_BYTES },
        stderr: { maxBytes: ERR_MAX_BYTES },
      },
      graceMs: 5000,
      ...signal === undefined ? {} : { signal },
    })
  } catch (error) {
    throw new VerificationError(
      `could not start ${JSON.stringify(resolved.command)} in ${resolved.cwd}: ${messageOf(error)}`,
    )
  }
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let outcome: { exitCode: number | null; signal: string | null }
  try {
    // A timeout abandons `handle.done`, so a later provider rejection is
    // expected here; keep it from surfacing as an unhandled rejection.
    void handle.done.catch(() => {})
    if (timeoutMs > 0) {
      const timed = new Promise<{ exitCode: null; signal: string | null }>((settle) => {
        timer = setTimeout(() => {
          timedOut = true
          try {
            void Promise.resolve(handle.terminate?.()).catch(() => {})
          } catch {
            // A provider that throws on termination must not mask the timeout.
          }
          settle({ exitCode: null, signal: 'SIGTERM' })
        }, timeoutMs)
      })
      outcome = await Promise.race([handle.done, timed])
    } else {
      outcome = await handle.done
    }
  } catch (error) {
    throw new VerificationError(
      `the subprocess provider failed while running ${JSON.stringify(resolved.command)}: ${messageOf(error)}`,
    )
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }
  const durationMs = Date.now() - startedAt
  const stdout = collectedText(handle.collected.stdout)
  const stderr = collectedText(handle.collected.stderr)
  const passed = outcome.exitCode === 0 && !timedOut
  const parsed: { failedTests: string[]; errors: string[] } = passed
    ? { failedTests: [], errors: [] }
    : parseFailure(kind, stdout, stderr)
  if (timedOut) {
    const note = `the check exceeded verificationTimeoutMs (${timeoutMs} ms) and was terminated`
    if (!parsed.errors.includes(note)) parsed.errors.unshift(note)
  }
  const output = `${stdout}${stderr === '' ? '' : `\n${stderr}`}`.slice(-OUTPUT_TAIL_CHARS)
  return {
    passed,
    kind,
    scope,
    source,
    command: resolved.command,
    exitCode: outcome.exitCode,
    durationMs,
    failedTests: parsed.failedTests,
    errors: parsed.errors,
    ranAt: startedAt,
    output,
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Render the model-facing result of one verification. */
export function renderVerification(run: VerificationRun): string {
  const head = run.passed
    ? `Verification passed: ${run.kind} (${run.scope}) in ${run.durationMs}ms — ${run.command}`
    : `Verification FAILED: ${run.kind} (${run.scope}) exit ${String(run.exitCode)} after ${run.durationMs}ms — ${run.command}`
  const lines = [head]
  if (!run.passed && run.failedTests.length > 0) {
    lines.push(`Failing tests: ${run.failedTests.join('; ')}`)
  }
  if (!run.passed && run.errors.length > 0) {
    lines.push(`Errors:\n${run.errors.map(line => `  ${line}`).join('\n')}`)
  }
  lines.push(`Output tail:\n${run.output === '' ? '  (empty)' : run.output}`)
  if (!run.passed) {
    lines.push('Next: return to the implement stage, fix the failure, then verify again. Do not deliver yet.')
  }
  return lines.join('\n')
}
