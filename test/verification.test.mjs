/**
 * Verification seam tests: command resolution reads the project's own manifest,
 * and the parser reduces runner output to the facts a gate and a report need.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configuredCommand } from '../lib/config/config.js'
import {
  VerificationError,
  executeVerification,
  parseFailure,
  resolveVerification,
} from '../lib/tools/verification.js'

const CONFIG = {
  defaultMode: 'codex',
  implementWorkerModel: 'p/model',
  verifyWorkerModel: 'p/model',
  verificationCommands: {},
}

/** A fixture package directory. */
async function fixture(files) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-coding-verify-'))
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content))
  }
  return dir
}

test('resolves the package manager and script from the project manifest', async () => {
  const dir = await fixture({
    'package.json': { name: 'fixture', scripts: { test: 'vitest run', typecheck: 'tsc --noEmit' } },
    'pnpm-lock.yaml': 'lockfileVersion: 9\n',
  })
  const resolved = await resolveVerification(CONFIG, dir, 'test', 'targeted')
  assert.equal(resolved.command, 'pnpm run test')
  assert.equal(resolved.script, 'test')
  assert.equal(resolved.packageManager, 'pnpm')
  assert.equal(resolved.cwd, dir)
})

test('a configured override wins over detection', async () => {
  const dir = await fixture({ 'package.json': { name: 'fixture', scripts: { test: 'exit 0' } } })
  const config = { ...CONFIG, verificationCommands: { 'test:full': 'make check' } }
  assert.equal(configuredCommand(config, 'test', 'full'), 'make check')
  assert.equal(configuredCommand(config, 'test', 'package'), undefined)
  const resolved = await resolveVerification(config, dir, 'test', 'full')
  assert.equal(resolved.command, 'make check')
})

test('a missing script fails with the available scripts and the override key', async () => {
  const dir = await fixture({ 'package.json': { name: 'fixture', scripts: { build: 'tsc' } } })
  await assert.rejects(
    () => resolveVerification(CONFIG, dir, 'lint', 'package'),
    (error) => error instanceof VerificationError
      && /no lint script/.test(error.message)
      && /verificationCommands\.lint/.test(error.message),
  )
})

test('a directory without a package.json asks for an explicit command', async () => {
  const dir = await fixture({})
  await assert.rejects(
    () => resolveVerification(CONFIG, dir, 'test', 'targeted'),
    /no package\.json/,
  )
})

test('parses TAP, jest, and tsc failure output', () => {
  const tap = parseFailure('test', 'ok 1 first\nnot ok 2 - adds numbers\n', '')
  assert.deepEqual(tap.failedTests, ['adds numbers'])

  const jest = parseFailure('test', '  ● renders the capsule\n\n  ✕ computes the stage\n', '')
  assert.deepEqual(jest.failedTests, ['renders the capsule', 'computes the stage'])

  const tsc = parseFailure('typecheck', '', 'src/a.ts(3,5): error TS2322: Type \'string\' is not assignable to type \'number\'.')
  assert.equal(tsc.errors.length, 1)
  assert.match(tsc.errors[0], /TS2322/)
})

test('executes through the subprocess seam and reports the structured outcome', async () => {
  const calls = []
  const subprocess = {
    spawn(spec) {
      calls.push(spec)
      return {
        done: Promise.resolve({ exitCode: 1, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text: 'not ok 1 - adds numbers\n', nextOffset: 22, lossy: false }) },
          stderr: { readFrom: () => ({ text: 'AssertionError: expected 3\n', nextOffset: 25, lossy: false }) },
        },
      }
    },
  }
  const run = await executeVerification(
    subprocess,
    { command: 'pnpm test', cwd: '/tmp/fixture' },
    'test',
    'targeted',
    'lead',
    new AbortController().signal,
    0,
  )
  assert.equal(calls.length, 1)
  // The seam runs the command through the platform shell: cmd.exe on Windows,
  // /bin/sh elsewhere.
  const shell = process.platform === 'win32' ? ['cmd.exe', '/d', '/s', '/c'] : ['/bin/sh', '-c']
  assert.deepEqual(calls[0].argv, [...shell, 'pnpm test'])
  assert.equal(calls[0].cwd, '/tmp/fixture')
  assert.equal(run.passed, false)
  assert.equal(run.exitCode, 1)
  assert.deepEqual(run.failedTests, ['adds numbers'])
  assert.match(run.output, /AssertionError/)
})

test('a verification longer than verificationTimeoutMs fails as a timeout', async () => {
  let terminated = false
  const subprocess = {
    spawn() {
      return {
        // Never settles: only the deadline can end this run.
        done: new Promise(() => {}),
        collected: {
          stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
          stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        },
        terminate() {
          terminated = true
        },
      }
    },
  }
  const run = await executeVerification(
    subprocess,
    { command: 'sleep', cwd: process.cwd() },
    'test',
    'package',
    'lead',
    undefined,
    20,
  )
  assert.equal(run.passed, false)
  assert.equal(run.exitCode, null)
  assert.equal(terminated, true, 'the managed range is terminated at the deadline')
  assert.match(run.errors.join(' '), /verificationTimeoutMs|exceeded/)
  assert.equal(run.output, '')
})

test('a zero verificationTimeoutMs leaves the run undeadlined', async () => {
  const subprocess = {
    spawn() {
      return {
        done: Promise.resolve({ exitCode: 0, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text: 'ok 1 first\n', nextOffset: 11, lossy: false }) },
          stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        },
        terminate() {
          throw new Error('terminate must not be called when the timeout is disabled')
        },
      }
    },
  }
  const run = await executeVerification(
    subprocess,
    { command: 'pnpm test', cwd: process.cwd() },
    'test',
    'targeted',
    'lead',
    undefined,
    0,
  )
  assert.equal(run.passed, true)
  assert.equal(run.exitCode, 0)
  assert.deepEqual(run.errors, [])
})

test('full resolves the repository root even when .git is a directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-coding-repo-'))
  await mkdir(join(root, '.git'), { recursive: true })
  await mkdir(join(root, 'packages', 'a'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'root', scripts: { test: 'echo root' } }))
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  await writeFile(join(root, 'packages', 'a', 'package.json'), JSON.stringify({ name: 'a', scripts: { test: 'echo a' } }))

  const full = await resolveVerification(CONFIG, join(root, 'packages', 'a'), 'test', 'full')
  assert.equal(full.command, 'pnpm run test')
  assert.equal(full.cwd, root, 'full runs from the repository root')

  const targeted = await resolveVerification(CONFIG, join(root, 'packages', 'a'), 'test', 'targeted')
  assert.equal(targeted.cwd, join(root, 'packages', 'a'), 'targeted stays on the nearest package')
})
