/**
 * Handoff-document tests: the file name, the composed Markdown, the truncation
 * bound, and the two write outcomes (recorded write, actionable failure).
 *
 * `composeMemoryDocument` is pure and `writeMemoryDocument` only talks to the
 * injected fs service, so both halves are asserted without touching a real
 * filesystem: the fake service records what the Host would have written.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MEMORY_LIMIT,
  composeMemoryDocument,
  memoryFileName,
  writeMemoryDocument,
} from '../lib/memory.js'
import { createState } from '../lib/state.js'

/** The instant every filename assertion uses: 2026-07-15T06:30:12Z. */
const AT = Date.UTC(2026, 6, 15, 6, 30, 12)

/** One passing verification outcome, as `run_verification` records it. */
function outcome(overrides = {}) {
  return {
    passed: true,
    kind: 'test',
    scope: 'package',
    source: 'lead',
    command: 'pnpm test',
    exitCode: 0,
    durationMs: 12,
    failedTests: [],
    errors: [],
    ranAt: 9,
    ...overrides,
  }
}

/** The handoff a codex run records before delivering. */
function handoffOf(overrides = {}) {
  return {
    version: 1,
    goal: 'ship the flag',
    delivered: 'turn 1: shipped the flag',
    constraints: ['no new dependency'],
    acceptance: ['the failing test passes'],
    findings: [],
    decisions: [],
    open: [],
    followUps: ['harden the parser'],
    tasks: [],
    changes: [{ file: 'src/a.ts', summary: 'added the flag' }],
    updatedAt: 7,
    ...overrides,
  }
}

/** One complete document input; overrides replace whole fields. */
function inputOf(overrides = {}) {
  return {
    sessionId: 'session-1',
    cwd: 'D:/proj',
    mode: 'codex',
    stage: 'deliver',
    turn: 4,
    blocked: false,
    handoff: handoffOf(),
    plan: [{ content: 'ship the flag', status: 'completed' }],
    verification: outcome(),
    files: ['src/a.ts', 'src/b.ts'],
    transitions: [{ from: 'verify', to: 'deliver', at: 5, reason: 'verification passed' }],
    now: AT,
    ...overrides,
  }
}

/** A fake fs service that records writes instead of performing them. */
function createFakeFs(writes) {
  return {
    async resolve(path) {
      return { targetKey: path, displayPath: `D:/proj/${path}` }
    },
    async writeText(target, content, expected) {
      writes.push({ target, content, expected })
      return { operation: 'create', version: 'v1' }
    },
  }
}

test('a handoff document name cleans the session id and stamps UTC', () => {
  assert.equal(MEMORY_LIMIT, 20000, 'the document keeps its budget')
  assert.equal(memoryFileName('session-1', AT), 'session-1-20260715-063012.md')
  assert.equal(memoryFileName('a/b c', AT), 'a-b-c-20260715-063012.md', 'path separators and spaces become dashes')
  assert.match(memoryFileName('', AT), /^session-\d{8}-\d{6}\.md$/u, 'an empty id falls back to session')

  // An unusable instant must not throw: the file is still a Markdown document.
  assert.match(memoryFileName('session-1', Number.NaN), /\.md$/u)
  assert.match(memoryFileName('session-1', Number.POSITIVE_INFINITY), /\.md$/u)
})

test('the composed document carries the run handoff, the plan, and the verification', () => {
  const document = composeMemoryDocument(inputOf())

  assert.match(document, /# Coding 任务交接文档/u)
  assert.match(document, /## 目标/u)
  assert.match(document, /ship the flag/u, 'the goal reaches the document')
  assert.match(document, /## 交付记录/u)
  assert.match(document, /turn 1: shipped the flag/u, 'the delivery record reaches the document')
  assert.match(document, /## 后续跟进/u)
  assert.match(document, /harden the parser/u)
  assert.match(document, /## 任务清单/u)
  assert.match(document, /\[x\] ship the flag/u)
  assert.match(document, /## 改动文件/u)
  assert.match(document, /src\/a\.ts — added the flag/u)
  assert.match(document, /## 验证/u)
  assert.match(document, /pnpm test/u, 'the verification command reaches the document')
  assert.match(document, /- 结果: passed/u)
  assert.match(document, /## 阶段轨迹/u)
  assert.match(document, /verify → deliver/u)
  assert.match(document, /session-1/u)
})

test('empty handoff sections are omitted instead of rendered as headings', () => {
  const document = composeMemoryDocument(inputOf({
    handoff: undefined,
    plan: [],
    files: [],
    transitions: [],
    verification: undefined,
  }))

  assert.match(document, /# Coding 任务交接文档/u, 'an empty run still yields a document')
  assert.doesNotMatch(document, /## 决策/u)
  assert.doesNotMatch(document, /## 后续跟进/u)
  assert.doesNotMatch(document, /## 验收标准/u)
})

test('an oversized delivery record is truncated and marked', () => {
  const document = composeMemoryDocument(inputOf({
    handoff: handoffOf({ delivered: 'x'.repeat(30000) }),
  }))

  assert.ok(document.length <= MEMORY_LIMIT + 64, `the document stays bounded, got ${document.length}`)
  assert.match(document, /（文档已截断）/u)
})

test('writeMemoryDocument writes one new file under .agents/memory', async () => {
  const writes = []
  const fake = createFakeFs(writes)
  const ctx = { get: (name) => (name === 'fs' ? fake : undefined) }
  const agent = { session: { header: { cwd: 'D:/proj' } }, ctx: {} }
  const state = createState('session-1', 'codex')
  state.stage = 'deliver'
  state.turn = 2
  state.handoff = handoffOf({ goal: 'fix the flag' })
  state.files.add('src/a.ts')

  const result = await writeMemoryDocument(ctx, agent, state)

  assert.equal(result.ok, true)
  assert.match(result.name, /^session-1-\d{8}-\d{6}\.md$/u)
  assert.match(result.displayPath, /\.agents/u)
  assert.match(result.displayPath, /\.md$/u)

  assert.equal(writes.length, 1, 'one document per press')
  assert.deepEqual(
    writes[0].expected,
    { kind: 'createIfAbsent' },
    'a repeated press creates a new file instead of overwriting the last one',
  )
  assert.match(writes[0].content, /# Coding 任务交接文档/u)
  assert.match(writes[0].content, /fix the flag/u, 'the recorded goal reaches the file')
})

test('a Host without the fs service reports the reason and the next move', async () => {
  const ctx = { get: () => undefined }
  const agent = { session: { header: { cwd: 'D:/proj' } }, ctx: {} }
  const state = createState('session-1', 'codex')

  const result = await writeMemoryDocument(ctx, agent, state)

  assert.equal(result.ok, false)
  assert.match(result.reason, /fs service/u)
  assert.equal(typeof result.action, 'string')
  assert.notEqual(result.action.trim(), '', 'a failure always names what to do next')
})

test('a failing write becomes a receipt instead of an exception', async () => {
  const ctx = {
    get: (name) => (name === 'fs'
      ? {
        async resolve(path) {
          return { targetKey: path, displayPath: `D:/proj/${path}` }
        },
        async writeText() {
          throw new Error('disk full')
        },
      }
      : undefined),
  }
  const agent = { session: { header: { cwd: 'D:/proj' } }, ctx: {} }
  const state = createState('session-1', 'codex')

  const result = await writeMemoryDocument(ctx, agent, state)

  assert.equal(result.ok, false)
  assert.match(result.reason, /disk full/u)
  assert.equal(typeof result.action, 'string')
})
