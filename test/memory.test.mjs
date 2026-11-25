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
import { join } from 'node:path'
import {
  MEMORY_LIMIT,
  MEMORY_TITLE_LIMIT,
  composeMemoryDocument,
  memoryFileName,
  readLatestMemory,
  sessionTitleOf,
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

/** A fake fs service backed by an in-memory `files` map, for the read path. */
function createFakeReader(files) {
  return {
    async resolve(path) {
      return { targetKey: path, displayPath: `D:/proj/${path}` }
    },
    async stat(target) {
      const key = String(target.targetKey).replace(/[\\/]+$/u, '')
      const sep = key.includes('\\') ? '\\' : '/'
      for (const child of files.keys()) {
        if (child === key || child.startsWith(key + sep)) return { type: 'directory' }
      }
      return undefined
    },
    async listDir(target) {
      const key = String(target.targetKey)
      const sep = key.includes('\\') ? '\\' : '/'
      const prefix = key.replace(/[\\/]+$/u, '') + sep
      const entries = []
      for (const child of files.keys()) {
        if (!child.startsWith(prefix)) continue
        const rest = child.slice(prefix.length)
        if (rest.includes('\\') || rest.includes('/')) continue
        entries.push({ name: rest, type: 'file', target: { targetKey: child, displayPath: `D:/proj/${child}` } })
      }
      return entries
    },
    async readText(target) {
      return files.get(String(target.targetKey))
    },
  }
}

/** One `.agents/memory` key built with the platform separator. */
function memoryKey(name) {
  return join('.agents', 'memory', name)
}

test('a handoff document name stamps UTC first and cleans the title', () => {
  assert.equal(MEMORY_LIMIT, 20000, 'the document keeps its budget')
  assert.equal(MEMORY_TITLE_LIMIT, 40, 'the title has a fixed code-point cap')
  assert.equal(memoryFileName('session-1', AT), '20260715-063012-session-1.md')
  assert.equal(memoryFileName('a/b c', AT), '20260715-063012-a-b-c.md', 'path separators and spaces become dashes')
  assert.equal(memoryFileName('', AT), '20260715-063012-session.md', 'an empty title falls back to session')
  assert.equal(memoryFileName('   ', AT), '20260715-063012-session.md', 'a blank title falls back to session')
  assert.equal(
    memoryFileName('a/b:c*?"<>|', AT),
    '20260715-063012-a-b-c.md',
    'every Windows-illegal character is folded into a dash run',
  )
  assert.equal(
    memoryFileName('fix the bug. ', AT),
    '20260715-063012-fix-the-bug.md',
    'a trailing dot and space are eaten instead of trailing the name',
  )

  const long = memoryFileName('x'.repeat(60), AT)
  const longStem = long.slice('20260715-063012-'.length, -'.md'.length)
  assert.equal(longStem.length, MEMORY_TITLE_LIMIT, 'an oversized title is cut to the code-point cap')

  const emoji = memoryFileName('😀'.repeat(50), AT)
  const emojiStem = emoji.slice('20260715-063012-'.length, -'.md'.length)
  assert.equal(Array.from(emojiStem).length, MEMORY_TITLE_LIMIT, 'the cut never splits a surrogate pair')

  // An unusable instant must not throw: the file is still a Markdown document.
  assert.match(memoryFileName('session-1', Number.NaN), /\.md$/u)
  assert.match(memoryFileName('session-1', Number.POSITIVE_INFINITY), /\.md$/u)
})

test('sessionTitleOf reads the snapshot and never throws', () => {
  assert.equal(sessionTitleOf({ get: () => ({ title: '  hello  ' }) }, {}), 'hello')
  assert.equal(sessionTitleOf({ get: () => undefined }, {}), '', 'a missing snapshot reads as an empty title')
  assert.equal(sessionTitleOf({ get: () => { throw new Error('x') } }, {}), '', 'a throwing service reads as empty')
  assert.equal(sessionTitleOf(undefined, {}), '', 'a Host without the service reads as empty')
  assert.equal(sessionTitleOf({}, {}), '', 'a service without get reads as empty')
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
  assert.match(
    result.name,
    /^\d{8}-\d{6}-fix-the-flag\.md$/u,
    'without a sessionTitle service the handoff goal names the file',
  )
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

test('writeMemoryDocument prefers the session title over the handoff goal', async () => {
  const writes = []
  const fake = createFakeFs(writes)
  const titleService = { get: () => ({ title: 'weekly report' }) }
  const ctx = {
    get: (name) => (name === 'fs' ? fake : name === 'sessionTitle' ? titleService : undefined),
  }
  const agent = { session: { header: { cwd: 'D:/proj' } }, ctx: {} }
  const state = createState('session-1', 'codex')
  state.stage = 'deliver'
  state.handoff = handoffOf({ goal: 'fix the flag' })

  const result = await writeMemoryDocument(ctx, agent, state)

  assert.equal(result.ok, true)
  assert.match(result.name, /weekly-report\.md$/u, 'the session title wins over the goal')
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

/** One reader `ctx`/`agent` pair over an in-memory `.agents/memory` directory. */
function readerOf(fake) {
  return {
    ctx: { get: (name) => (name === 'fs' ? fake : undefined) },
    agent: { session: { header: { cwd: 'D:/proj' } }, ctx: {} },
  }
}

/** The three-file directory the read assertions share; `notes.md` is not a handoff document. */
function archiveOf() {
  return new Map([
    [memoryKey('20260715-063012-fix-flag.md'), '# Coding 任务交接文档\n\n- 会话: a\n'],
    [memoryKey('20260716-101500-weekly-report.md'), '# Coding 任务交接文档\n\n- 会话: b\n'],
    [memoryKey('notes.md'), '# notes\n'],
  ])
}

test('readLatestMemory loads the newest archived handoff document', async () => {
  const { ctx, agent } = readerOf(createFakeReader(archiveOf()))

  const result = await readLatestMemory(ctx, agent)

  assert.equal(result.ok, true)
  assert.equal(result.name, '20260716-101500-weekly-report.md', 'the time-ordered name picks the newest one')
  assert.match(result.content, /- 会话: b/u)
  assert.match(result.displayPath, /\.agents/u)
})

test('readLatestMemory filters by a case-insensitive filename keyword', async () => {
  const { ctx, agent } = readerOf(createFakeReader(archiveOf()))

  const fix = await readLatestMemory(ctx, agent, { keyword: 'fix' })
  assert.equal(fix.ok, true)
  assert.equal(fix.name, '20260715-063012-fix-flag.md')
  assert.match(fix.content, /- 会话: a/u)

  const upper = await readLatestMemory(ctx, agent, { keyword: 'FIX' })
  assert.equal(upper.ok, true)
  assert.equal(upper.name, '20260715-063012-fix-flag.md', 'the keyword match ignores case')
})

test('readLatestMemory reports an empty archive as a receipt', async () => {
  const { ctx, agent } = readerOf(createFakeReader(new Map()))

  const result = await readLatestMemory(ctx, agent)

  assert.equal(result.ok, false)
  assert.match(result.reason, /no handoff document under/u)
  assert.equal(typeof result.action, 'string')
  assert.notEqual(result.action.trim(), '', 'a failure always names what to do next')
})

test('readLatestMemory treats a missing archive directory as an empty archive', async () => {
  // 首次使用时 `.agents/memory` 还不存在：stat 读不到目标，listDir 会抛 ENOENT。
  const fake = {
    async resolve(path) {
      return { targetKey: path, displayPath: `D:/proj/${path}` }
    },
    async stat() {
      return undefined
    },
    async listDir() {
      throw new Error('ENOENT: no such file or directory')
    },
    async readText() {
      return ''
    },
  }
  const { ctx, agent } = readerOf(fake)

  const result = await readLatestMemory(ctx, agent)

  assert.equal(result.ok, false)
  assert.match(result.reason, /no handoff document under/u, 'a missing directory reads as an empty archive')
  assert.equal(typeof result.action, 'string')
  assert.notEqual(result.action.trim(), '', 'a failure always names what to do next')
  assert.doesNotMatch(result.reason, /ENOENT|filesystem/u, 'a first run is not a filesystem problem')

  const keyword = await readLatestMemory(ctx, agent, { keyword: 'weekly' })
  assert.equal(keyword.ok, false)
  assert.match(keyword.reason, /no handoff document matches "weekly"/u, 'the keyword still names itself')
  assert.notEqual(keyword.action.trim(), '')
})

test('readLatestMemory names the keyword when nothing matches', async () => {
  const { ctx, agent } = readerOf(createFakeReader(archiveOf()))

  const result = await readLatestMemory(ctx, agent, { keyword: 'no-such-keyword' })

  assert.equal(result.ok, false)
  assert.match(result.reason, /no-such-keyword/u)
})

test('a failing listDir becomes a receipt instead of an exception', async () => {
  const fake = {
    async resolve(path) {
      return { targetKey: path, displayPath: `D:/proj/${path}` }
    },
    async stat() {
      return { type: 'directory' }
    },
    async listDir() {
      throw new Error('EACCES: denied')
    },
    async readText() {
      return ''
    },
  }
  const { ctx, agent } = readerOf(fake)

  const result = await readLatestMemory(ctx, agent)

  assert.equal(result.ok, false)
  assert.match(result.reason, /EACCES/u)
})

test('a Host without the fs service cannot read a handoff document', async () => {
  const ctx = { get: () => undefined }
  const agent = { session: { header: { cwd: 'D:/proj' } }, ctx: {} }

  const result = await readLatestMemory(ctx, agent)

  assert.equal(result.ok, false)
  assert.match(result.reason, /fs service/u)
})
