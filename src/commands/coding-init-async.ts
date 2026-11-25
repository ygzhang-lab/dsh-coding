/**
 * `/coding init` 的异步提交器：命令立即回执，模型生成与写盘在后台跑完，结果经 followup 回到会话。
 *
 * 命令处理器 settle 之后 payload 里的 signal 会被 abort，所以这条路径不能同步等模型：
 * 本模块只做两件同步就能定的事，然后立刻把回执交回去。
 *
 * 1. **轻量预检（同步可判）**：`workspaceOf` 定位项目根 → `listSourceFiles` 枚举源码 →
 *    空项目只回 `initText(...).emptyProject`；`checkDocRoute` 预检本会话当前模型 → 读不到路由
 *    只回 error。两种失败都在这里收口，**不启动后台、不调用 `run`**。
 * 2. **单飞 + 后台**：`WeakSet` 记录在途 agent，重复触发同步回一句提示，绝不启动第二个任务；
 *    否则标记在途、交给 `lib/background-task` 的后台运行器，并把 `run` 的最终回执包成
 *    `agent.followup(controlMessage(...))` 送回会话。
 *
 * 后台任务只用运行器给的 signal（maintenance 名额或独立超时），**绝不透传命令 payload 里的
 * signal**：命令一 settle 它就被 abort，透传等于让后台任务立刻中断。`run` 抛错在这一层
 * 收成 error 回执；通知本身失败（agent 没有 followup、followup 抛错或返回 rejected Promise）
 * 一律静默吞掉，不影响后台收尾与在途标记的释放。
 *
 * 依赖全部可注入，测试可以换掉 `run` / `listSources` / `checkRoute` / `runner` / `notify`，
 * 用来验证「回执先于后台 settle」「空项目与路由失败不启动后台」「单飞」。
 *
 * @module dsh-coding/commands/coding-init-async
 */
import { createBackgroundRunner, type BackgroundRunner } from '../lib/background-task.js'
import { checkDocRoute, type DocRouteCheck } from '../lib/doc-model.js'
import { listSourceFiles } from '../lib/project-scan.js'
import { controlMessage } from '../messages.js'
import { initText, type InitText } from '../command-text.js'
import {
  parseCodingInitArgs,
  workspaceOf,
  type CodingInitPayload,
  type CodingInitResult,
} from './coding-init.js'
import type { PromptLanguage } from '../language.js'

/** 提交通道的依赖；`run` 是唯一必填项，其余都有生产缺省实现。 */
export interface CodingInitSubmitterDeps {
  /** 同步执行器（现有 createCodingInitHandler 的返回）。 */
  readonly run: (payload: CodingInitPayload) => Promise<CodingInitResult>
  /** 源码枚举；默认 listSourceFiles。 */
  readonly listSources?: (root: string) => Promise<{ readonly files: readonly string[] }>
  /** 模型路由预检；默认 checkDocRoute。 */
  readonly checkRoute?: (agent: unknown) => DocRouteCheck
  /** 后台运行器；默认 createBackgroundRunner()。 */
  readonly runner?: BackgroundRunner
  /** 完成/失败通知；默认走 agent.followup(controlMessage(text, <语言化的摘要>))。 */
  readonly notify?: (agent: unknown, text: string) => void
  /** 会话语言；缺省 `zh`（既有中文回执逐字不变）。 */
  readonly language?: () => PromptLanguage
}

/**
 * 默认通知：`agent.followup(controlMessage(...))`。
 *
 * agent 不是对象、没有 `followup`、`followup` 抛错或返回 rejected Promise 时全部静默：
 * 通知失败不能让后台任务的收尾与在途标记受影响。
 * @param agent - 触发这次生成的 agent（可能已不可用）。
 * @param text - 要送进会话的正文。
 * @param summary - `controlMessage` 的一行摘要（按语言取）。
 */
function notifyByFollowup(agent: unknown, text: string, summary: string): void {
  if (typeof agent !== 'object' || agent === null) return
  const followup: unknown = Reflect.get(agent, 'followup')
  if (typeof followup !== 'function') return
  try {
    swallowRejection(followup.call(agent, controlMessage(text, summary)))
  } catch {
    // followup 同步抛错（agent 正在收尾等）：通知静默丢弃。
  }
}

/**
 * Promise 形态的通知也要吞掉 rejection：后台任务没人 await 它，不能让通知失败变成
 * unhandled rejection。
 * @param value - `followup` 的返回值；非 thenable 直接忽略。
 */
function swallowRejection(value: unknown): void {
  if (typeof value !== 'object' || value === null) return
  if (typeof Reflect.get(value, 'then') !== 'function') return
  void Promise.resolve(value).catch(() => {})
}

/**
 * 单飞键：只有对象才进得了 `WeakSet`。
 * @param agent - 触发这次生成的 agent。
 * @returns agent 本身，或非对象时的 undefined（此时无从记账，按无键处理）。
 */
function flightKeyOf(agent: unknown): object | undefined {
  return typeof agent === 'object' && agent !== null ? agent : undefined
}

/**
 * 构造异步提交器：把依赖固定下来，返回只接收 payload 的异步函数。
 *
 * 返回的函数不会因为预检失败而启动后台，也不会等待模型：正常情况下 `run` 还没 settle，
 * 回执就已经交回命令层。
 * @param deps - `run` 必填，其余可注入；缺省实现见 {@link CodingInitSubmitterDeps}。
 * @returns 提交一次 `/coding init` 的函数。
 */
export function createCodingInitSubmitter(
  deps: CodingInitSubmitterDeps,
): (payload: CodingInitPayload) => Promise<CodingInitResult> {
  const listSources = deps.listSources ?? (async (root: string) => await listSourceFiles(root))
  const checkRoute = deps.checkRoute ?? checkDocRoute
  // 单飞：同一 agent 同时只允许一个在途任务。
  const running = new WeakSet<object>()

  return async (payload: CodingInitPayload): Promise<CodingInitResult> => {
    // 语言在入口只取一次，后台任务与回执共用同一份文案表。
    const copy: InitText = initText(deps.language?.() ?? 'zh')
    const notify = deps.notify ?? ((target: unknown, body: string) => {
      notifyByFollowup(target, body, copy.noticeSummary)
    })

    // 1. 轻量预检：空项目与读不到模型都同步回执，不启动后台。
    const root = workspaceOf(payload)
    const sources = await listSources(root)
    if (sources.files.length === 0) {
      return { kind: 'success', text: copy.emptyProject }
    }

    const route = checkRoute(payload.agent)
    if (route.ok === false) {
      return { kind: 'error', text: `${route.reason} — ${route.action}` }
    }

    // 2. 单飞：已在途就同步回执，绝不启动第二个任务。
    const key = flightKeyOf(payload.agent)
    if (key !== undefined) {
      if (running.has(key)) return { kind: 'success', text: copy.inFlight }
      running.add(key)
    }

    // 3. 标记在途后启动后台：signal 只来自运行器，绝不透传命令 payload 里的 signal。
    const runner = deps.runner ?? createBackgroundRunner()
    const mode = runner(payload.agent, async (signal) => {
      try {
        let result: CodingInitResult
        try {
          result = await deps.run({
            agent: payload.agent,
            ...(payload.rawInput === undefined ? {} : { rawInput: payload.rawInput }),
            signal,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          result = { kind: 'error', text: copy.runFailed(message) }
        }
        const prefix = result.kind === 'success' ? 'done' : 'failed'
        notify(payload.agent, `${copy.notice(prefix, result.text)}${copy.noticeFooter}`)
      } finally {
        // 无论成功、失败还是超时，都要释放单飞标记。
        if (key !== undefined) running.delete(key)
      }
    })

    // 4. 立即回执：此时后台任务的 `run` 还没有 settle。
    const started = copy.started(route.route)
    return {
      kind: 'success',
      text: mode === 'detached' ? `${started}${copy.detached}` : started,
    }
  }
}
