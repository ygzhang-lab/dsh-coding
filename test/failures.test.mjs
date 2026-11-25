/**
 * Failure report unit tests. The reports are pure data built at the blocking
 * dispatch points, persisted inside checkpoints, and rendered once to the
 * model; these tests pin the reason, the next move, the one-line status, and
 * the validation tolerance that keeps a junk field from dropping a whole card.
 * They import the built JavaScript the Host actually runs.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { asFailure, failureNotice, failureStatus, makeFailure } from '../lib/core/failures.js'

test('a delegate failure names the point, the reason, and the next move', () => {
  const failure = makeFailure('delegate', new Error('model missing'), 'zh')
  assert.equal(failure.point, 'delegate')
  assert.equal(failure.reason, 'model missing')
  assert.match(failure.action, /worker|模型/)
  assert.equal(typeof failure.at, 'number')
  assert.ok(Number.isFinite(failure.at), 'the report carries a timestamp')

  // The notice states the interrupted subsystem, the cause, and what to do.
  const zh = failureNotice(failure, 'zh')
  assert.match(zh, /运行中断/)
  assert.match(zh, /子代理派发/)
  assert.match(zh, /model missing/)
  assert.match(zh, /处理：/)

  const en = failureNotice(failure, 'en')
  assert.match(en, /runtime failure/)
  assert.match(en, /Worker dispatch/)
  assert.match(en, /model missing/)
  assert.match(en, /What to do:/)

  assert.equal(failureStatus(failure), 'failure delegate')
})

test('the reason and the action are bounded', () => {
  const long = makeFailure('command', new Error('x'.repeat(900)), 'en')
  assert.equal(long.reason.length, 600)
  assert.ok(long.action.length <= 600)
})

test('a stage failure names the run_verification example in both languages', () => {
  const example = "run_verification({ kind: 'test', scope: 'package' })"
  const zh = makeFailure('stage', new Error('blocked'), 'zh')
  const en = makeFailure('stage', new Error('blocked'), 'en')

  for (const failure of [zh, en]) {
    assert.ok(failure.action.includes(example), failure.action)
    assert.ok(failure.action.length <= 600, 'the action stays inside the failure text limit')
  }
  assert.match(zh.action, /[\u4e00-\u9fff]/, 'the Chinese action stays Chinese')
  assert.doesNotMatch(en.action, /[\u4e00-\u9fff]/, 'the English action carries no CJK')

  // The rendered notice keeps the copyable example, not just the report object.
  assert.ok(failureNotice(zh, 'zh').includes(example))
  assert.ok(failureNotice(en, 'en').includes(example))
})

test('asFailure accepts a report and rejects every malformed field', () => {
  const valid = makeFailure('verification', new Error('no package.json'), 'en', 42)
  assert.deepEqual(asFailure(JSON.parse(JSON.stringify(valid))), valid, 'a report survives durable JSON')

  assert.equal(asFailure({ ...valid, point: 'nope' }), undefined, 'an unknown dispatch point is not a report')
  assert.equal(asFailure({ ...valid, reason: 7 }), undefined, 'the reason must be a string')
  assert.equal(asFailure({ ...valid, action: undefined }), undefined, 'the action must be a string')
  assert.equal(asFailure({ ...valid, at: Number.POSITIVE_INFINITY }), undefined, 'the timestamp must be finite')
  assert.equal(asFailure(null), undefined)
  assert.equal(asFailure('delegate'), undefined)
})

test('an empty error message reads as unknown error', () => {
  // The builder never emits an empty reason: the notice always names something.
  assert.equal(makeFailure('handoff', new Error(''), 'zh').reason, 'unknown error')
  assert.equal(makeFailure('handoff', new Error('  \n\t '), 'zh').reason, 'unknown error')
})
