/**
 * `/coding init` 异步链路的单元测试：后台运行器与异步提交器。
 *
 * 这两层都只跑构建产物，不接真实 Host、模型或网络：后台运行器用假 agent 的
 * `runMaintenance` 模拟宿主维护名额；提交器注入假的 `run` / `listSources` / `checkRoute` /
 * `runner` / `notify`，用可控 Promise 验证「回执先于后台 settle」。
 *
 * 计时只有超时用例的 5ms / 20ms，而且运行器把 timer `unref()` 并在 settle 后清理，
 * 所以测试进程能自然退出；任务 rejection 全被运行器吞掉，不会变成 unhandled rejection。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBackgroundRunner } from '../lib/docgen/background-task.js'
import { createCodingInitSubmitter } from '../lib/commands/coding-init-async.js'

/** 一个可以由测试手工 settle 的 Promise，用来控制后台任务何时完成。 */
function deferred() {
  let resolve
  const promise = new Promise((settle) => { resolve = settle })
  return { promise, resolve }
}

/** 等一小会儿：只给超时用例用，timer 自然退出。 */
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 提交器测试的公共预检：有源码、路由可读。 */
function depsOf(overrides = {}) {
  return {
    listSources: async () => ({ files: ['src/index.ts'] }),
    checkRoute: () => ({ ok: true, route: 'deepseek-account/deepseek-flash' }),
    ...overrides,
  }
}

test('后台运行器：agent 有 runMaintenance 时返回 maintenance，任务的 signal 未被 abort', async () => {
  const runner = createBackgroundRunner()
  const signals = []
  let outer
  const agent = {
    runMaintenance(task) {
      outer = task(new AbortController().signal)
      return outer
    },
  }

  const mode = runner(agent, async (signal) => {
    signals.push(signal)
    await Promise.resolve()
  })

  assert.equal(mode, 'maintenance', '优先借宿主的维护名额')
  await outer
  assert.equal(signals.length, 1, '任务经维护名额执行了一次')
  assert.equal(signals[0].aborted, false, '没有超时也没有中断，signal 保持可用')
})

test('后台运行器：runMaintenance 同步抛错时退回 detached，任务仍然执行', async () => {
  const runner = createBackgroundRunner()
  const done = deferred()
  const agent = {
    runMaintenance() {
      throw new Error('agent is busy')
    },
  }

  const mode = runner(agent, async (signal) => { done.resolve(signal) })

  assert.equal(mode, 'detached', 'agent 忙到同步抛错就退回独立后台任务')
  const signal = await done.promise
  assert.equal(signal.aborted, false, '独立后台任务拿到自己的 signal')
})

test('后台运行器：超时 abort 任务的 signal，并吞掉任务 rejection', async () => {
  const runner = createBackgroundRunner({ timeoutMs: 5 })
  const signals = []
  const mode = runner({}, (signal) => {
    signals.push(signal)
    return new Promise(() => {}) // 永不 settle：只有超时能让它结束
  })

  assert.equal(mode, 'detached', '没有维护名额就是独立后台任务')
  await wait(20)
  assert.equal(signals.length, 1)
  assert.equal(signals[0].aborted, true, '到点后 signal 被 abort')
  assert.match(String(signals[0].reason?.message), /后台任务超时/u)

  // 任务抛错同样被吞掉：后台任务没人 await，不能变成 unhandled rejection。
  assert.equal(runner({}, async () => { throw new Error('boom') }), 'detached')
  await wait(20)
})

test('提交器：空项目只回提示，不调用 run', async () => {
  let runCalls = 0
  const submit = createCodingInitSubmitter(depsOf({
    listSources: async () => ({ files: [] }),
    run: async () => {
      runCalls++
      return { kind: 'success', text: '不该走到这里' }
    },
  }))

  const result = await submit({ agent: {} })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /未检测到代码文件/u)
  assert.equal(runCalls, 0, '空项目不启动后台任务')
})

test('提交器：读不到模型路由时同步返回 error，不调用 run', async () => {
  let runCalls = 0
  const submit = createCodingInitSubmitter(depsOf({
    checkRoute: () => ({ ok: false, reason: 'no model', action: 'pick one' }),
    run: async () => {
      runCalls++
      return { kind: 'success', text: '不该走到这里' }
    },
  }))

  const result = await submit({ agent: {} })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /no model/u)
  assert.match(result.text, /pick one/u)
  assert.equal(runCalls, 0, '没有模型就不启动后台任务')
})

test('提交器：先交回执，后台完成后才回一条通知', async () => {
  const tasks = []
  const notes = []
  const gate = deferred()
  let runCalls = 0
  const submit = createCodingInitSubmitter(depsOf({
    run: async () => {
      runCalls++
      return await gate.promise
    },
    runner: (agent, task) => {
      tasks.push(task(new AbortController().signal))
      return 'detached'
    },
    notify: (agent, text) => { notes.push(text) },
  }))

  const receipt = await submit({ agent: {} })
  assert.equal(receipt.kind, 'success')
  assert.match(receipt.text, /已开始文档生成/u, '回执说清任务已在后台开始')
  assert.match(receipt.text, /后台执行/u)
  assert.match(receipt.text, /deepseek-account\/deepseek-flash/u, '回执带本次使用的模型路由')
  assert.equal(runCalls, 1, '回执发出时后台任务已经启动')
  assert.equal(notes.length, 0, 'run 还没 settle，回执就已经交回')

  gate.resolve({ kind: 'success', text: '已生成 AGENTS.md（模型 deepseek-account/deepseek-flash）。' })
  await tasks[0]
  assert.equal(notes.length, 1, '完成只通知一次')
  assert.match(notes[0], /文档生成完成/u)
  assert.match(notes[0], /运行时回执/u)
})

test('提交器：同一 agent 同时只允许一个在途任务', async () => {
  const tasks = []
  const notes = []
  const gates = []
  let runCalls = 0
  const submit = createCodingInitSubmitter(depsOf({
    run: async () => {
      runCalls++
      const gate = deferred()
      gates.push(gate)
      return await gate.promise
    },
    runner: (agent, task) => {
      tasks.push(task(new AbortController().signal))
      return 'detached'
    },
    notify: (agent, text) => { notes.push(text) },
  }))
  const agent = {}

  const first = await submit({ agent })
  assert.match(first.text, /已开始文档生成/u)

  const second = await submit({ agent })
  assert.match(second.text, /已有一个文档生成任务在运行/u, '重复触发只回提示')
  assert.equal(runCalls, 1, '第二次提交没有启动新任务')

  gates[0].resolve({ kind: 'success', text: 'ok' })
  await tasks[0]
  assert.equal(notes.length, 1)

  // 在途标记在任务收尾时释放：第三次提交能再次启动。
  const third = await submit({ agent })
  assert.match(third.text, /已开始文档生成/u)
  assert.equal(runCalls, 2, '在途任务结束后可以再次启动')

  gates[1].resolve({ kind: 'success', text: 'ok' })
  await tasks[1]
  assert.equal(notes.length, 2)
})

test('提交器：后台失败的通知写明原因', async () => {
  const tasks = []
  const notes = []
  const submit = createCodingInitSubmitter(depsOf({
    run: async () => ({ kind: 'error', text: 'provider down' }),
    runner: (agent, task) => {
      tasks.push(task(new AbortController().signal))
      return 'detached'
    },
    notify: (agent, text) => { notes.push(text) },
  }))

  const receipt = await submit({ agent: {} })
  assert.equal(receipt.kind, 'success', '失败在后台发生，回执照样先交回')
  await tasks[0]
  assert.equal(notes.length, 1)
  assert.match(notes[0], /文档生成失败/u)
  assert.match(notes[0], /provider down/u)
})

test('提交器：run 抛错收成失败回执，不上抛', async () => {
  const tasks = []
  const notes = []
  const submit = createCodingInitSubmitter(depsOf({
    run: async () => { throw new Error('disk exploded') },
    runner: (agent, task) => {
      tasks.push(task(new AbortController().signal))
      return 'detached'
    },
    notify: (agent, text) => { notes.push(text) },
  }))

  await submit({ agent: {} })
  await assert.doesNotReject(async () => { await tasks[0] })
  assert.equal(notes.length, 1, '抛错也要回一条失败通知')
  assert.match(notes[0], /命令失败/u)
  assert.match(notes[0], /disk exploded/u, '原始错误消息到达会话')
})

test('提交器：默认通知在 agent 没有 followup 或 followup 出错时静默', async () => {
  const tasks = []
  const submit = createCodingInitSubmitter(depsOf({
    run: async () => ({ kind: 'success', text: 'ok' }),
    runner: (agent, task) => {
      tasks.push(task(new AbortController().signal))
      return 'detached'
    },
  }))

  // 完全没有 followup 的 agent。
  await assert.doesNotReject(async () => { await submit({ agent: {} }) })
  await assert.doesNotReject(async () => { await tasks[0] })

  // followup 同步抛错（agent 正在收尾）。
  const throwing = {
    followup() { throw new Error('agent is finalizing') },
  }
  await assert.doesNotReject(async () => { await submit({ agent: throwing }) })
  await assert.doesNotReject(async () => { await tasks[1] })

  // followup 返回 rejected Promise：也不能变成 unhandled rejection。
  const rejecting = {
    async followup() { throw new Error('rejected followup') },
  }
  await assert.doesNotReject(async () => { await submit({ agent: rejecting }) })
  await assert.doesNotReject(async () => { await tasks[2] })
})
