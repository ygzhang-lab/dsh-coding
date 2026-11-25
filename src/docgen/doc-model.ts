/**
 * 文档模型直连：把提示词发给本会话当前模型，收成一段纯文本正文。
 *
 * `/coding init` 的 AGENTS.md 不再只靠模板：命令层先用 `./doc-context.js` 组装 system/user，
 * 再经这里走一次 Host 直连 —— `ctx.llm.prepareCall` 绑定当前适配器注册 → `prepared.stream`
 * 派发唯一一次请求 → `BlockAssembler` 把流式块拼成内容块 → 只取 text 块正文。
 *
 * 这一层只做「发一次请求、判一次结果」：不派子代理、不进对话 Turn、不读写文件、不 import
 * 内置文件系统模块，也不 import 预设。所有失败（宿主没有模型服务、读不到本会话模型、
 * prepareCall 抛错、流迭代抛错、blocks 抛错、finish 不是 stop、正文为空）都收成
 * {@link DocModelResult} 的 `ok: false`：既不上抛异常，也不回退为模板 —— 回执与写盘由
 * 命令层负责。
 *
 * @module dsh-coding/docgen/doc-model
 */
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason } from '@deepseek-ai/dsh-llm'
import { controlMessage } from '../core/messages.js'
import { leadRouteOf } from '../config/models.js'

/** 默认输出上限：一次文档生成最多 8000 token。 */
export const DOC_MODEL_MAX_TOKENS = 8000

/** 一次模型调用的输入；`agent` / `llm` 是宿主对象，`system` / `user` 来自 `buildDocPrompt`。 */
export interface DocModelRequest {
  readonly agent: any
  readonly llm: any
  readonly system: string
  readonly user: string
  /** 输出上限，缺省用 {@link DOC_MODEL_MAX_TOKENS}。 */
  readonly maxTokens?: number
  readonly signal?: AbortSignal
}

/** 调用结果：成功带正文与路由，失败带可读原因与下一步动作。 */
export type DocModelResult =
  | { readonly ok: true; readonly text: string; readonly route: string }
  | { readonly ok: false; readonly reason: string; readonly action: string }

/** 路由预检结果：可用时给出 `provider/model`，否则给出原因与下一步动作。 */
export type DocRouteCheck =
  | { readonly ok: true; readonly route: string }
  | { readonly ok: false; readonly reason: string; readonly action: string }

/** 宿主没有模型服务时的原因与动作。 */
const NO_LLM_REASON = '当前宿主没有可用的模型服务（llm.prepareCall）'
const NO_LLM_ACTION = '升级/重启 DSH 后再执行 /coding init。'

/** 读不到本会话当前模型时的动作。 */
const NO_ROUTE_ACTION = '先在对话框选择模型，再执行 /coding init。'

/** 其它调用失败时的统一动作：说清不会静默回退为模板。 */
const RETRY_ACTION = '检查模型路由与凭据后重试 /coding init；插件不会回退为模板。'

/** 组装失败结果。 */
function failed(reason: string, action: string): DocModelResult {
  return { ok: false, reason, action }
}

/** 读一个异常的可读消息；非 Error 值退回 `String`。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 输出上限：显式给了正数就用它，否则用 {@link DOC_MODEL_MAX_TOKENS}。 */
function maxTokensOf(request: DocModelRequest): number {
  const raw = request.maxTokens
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return DOC_MODEL_MAX_TOKENS
  return Math.floor(raw)
}

/** 从 `provider/model` 拆回两段：provider 不含 `/`，按首个 `/` 切分。 */
function splitRoute(route: string): { readonly provider: string; readonly model: string } {
  const at = route.indexOf('/')
  return { provider: route.slice(0, at), model: route.slice(at + 1) }
}

/** 拼正文：只取 `type === 'text'` 的块，按块顺序拼接，其余块忽略。 */
function textOf(blocks: readonly ContentBlock[]): string {
  let text = ''
  for (const block of blocks) {
    if (block.type === 'text') text += block.text
  }
  return text
}

/** 取 finish 里的失败原因；缺失时给一句可读兜底。 */
function failureOf(failure: { readonly message?: string } | undefined): string {
  const message = typeof failure?.message === 'string' ? failure.message.trim() : ''
  return message === '' ? '未给出原因' : message
}

/**
 * 预检本会话当前模型的路由，供 `/coding init` 在真正发请求前判定能不能生成。
 *
 * 只读 {@link leadRouteOf}（对话框里当前选中的 provider/model）：读不到就给出原因与
 * 下一步动作，能读到就拼成 `provider/model`。这里不检查 llm 服务、不抛错，也不做任何
 * 回退 —— 走哪条路由仍只由本会话当前模型决定。
 *
 * @param agent - 承载本会话模型的 agent；任意值都可传，读不到即失败。
 * @returns 可用时是 `{ok: true, route}`，否则是 `{ok: false, reason, action}`。
 */
export function checkDocRoute(agent: unknown): DocRouteCheck {
  const route = leadRouteOf(agent)
  if ('unavailable' in route) {
    return {
      ok: false,
      reason: `读不到本会话当前模型：${route.unavailable}`,
      action: NO_ROUTE_ACTION,
    }
  }
  return { ok: true, route: `${route.provider}/${route.model}` }
}

/**
 * 判定 finish：只接受 `stop`，其余一律收成失败结果。
 *
 * `max-tokens` 说明输出超过上限，`aborted` / `error` 带上 failure.message，未知终止原因
 * 也按失败处理 —— 一份被截断或半途中断的文档不能写盘。
 */
function finishFailure(finish: FinishReason, maxTokens: number): DocModelResult | undefined {
  switch (finish.kind) {
    case 'stop':
      return undefined
    case 'max-tokens':
      return failed(
        `模型输出超过 ${maxTokens} token 上限（max-tokens），文档未生成完整。`,
        RETRY_ACTION,
      )
    case 'aborted':
      return failed(`模型调用被中断（aborted）：${failureOf(finish.failure)}`, RETRY_ACTION)
    case 'error':
      return failed(`模型调用失败（error）：${failureOf(finish.failure)}`, RETRY_ACTION)
    default:
      return failed(`模型没有正常结束（finish: ${String(finish.kind)}），不接受该结果。`, RETRY_ACTION)
  }
}

/**
 * 用本会话当前模型生成一段文档正文。
 *
 * 路由预检走 {@link checkDocRoute}（即对话框里当前选中的 provider/model），读不到就失败，
 * 不回退到任何其它模型；`prepareCall` 只准备一次，`prepared.stream` 也只派发一次，且
 * provider/model 原样取自 `prepared.config`，满足 `INVALID_PREPARED_CALL` 的校验条件。
 *
 * @param request - 提示词、宿主对象与可选的中断信号 / 输出上限。
 * @returns 成功时是 trim 过的正文与 `${provider}/${model}` 路由；失败时是原因与动作。
 */
export async function generateDoc(request: DocModelRequest): Promise<DocModelResult> {
  const maxTokens = maxTokensOf(request)
  try {
    const llm = request.llm
    if (llm === undefined || llm === null || typeof llm.prepareCall !== 'function') {
      return failed(NO_LLM_REASON, NO_LLM_ACTION)
    }

    const preflight = checkDocRoute(request.agent)
    if (!preflight.ok) return failed(preflight.reason, preflight.action)

    const prepared = await llm.prepareCall(
      { ...splitRoute(preflight.route), maxTokens },
      request.signal,
    )
    const assembler = new BlockAssembler()
    const stream = prepared.stream({
      ...prepared.config,
      messages: [controlMessage(request.user, '生成 AGENTS.md')],
      system: request.system,
      signal: request.signal,
    })
    for await (const chunk of stream) assembler.push(chunk)

    // finish 先判：被截断或中断的流即便能拼出部分正文也不能采用。
    const finishFailureResult = finishFailure(assembler.finish, maxTokens)
    if (finishFailureResult !== undefined) return finishFailureResult

    // blocks() 对未闭合的未知块会抛错，统一由外层 catch 收成失败结果。
    const text = textOf(assembler.blocks()).trim()
    if (text === '') {
      return failed('模型没有返回内容（正文为空），文档未生成。', RETRY_ACTION)
    }
    return { ok: true, text, route: preflight.route }
  } catch (error) {
    return failed(`调用本会话模型失败：${messageOf(error)}`, RETRY_ACTION)
  }
}
