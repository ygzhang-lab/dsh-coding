/**
 * 后台任务运行器：让长任务脱离命令生命周期继续跑。
 *
 * 命令处理器 settle 之后，payload 里的 signal 会被 abort，所以后台任务不能再借它。
 * 这里每次调用新建一个 `AbortController` 与超时 timer：优先借 `agent.runMaintenance` 拿到的
 * 宿主维护名额（维护期间 Agent 不会再开新的 Turn）；agent 忙到同步抛错时退回普通后台
 * Promise + 独立超时。
 *
 * 约定：任务自身与 `runMaintenance` 返回的 Promise 的 rejection 全部吞掉（后台任务没人 await，
 * 不能产生 unhandled rejection）；timer 一律 `unref()` 并在 settle 后清理，进程能自然退出。
 * 这一层不写文件、不读 `agent.followup`、不拼回执 —— 通知由调用方在任务里自行发送。
 *
 * @module dsh-coding/docgen/background-task
 */

/** 后台任务超时：10 分钟。 */
export const BACKGROUND_TIMEOUT_MS = 600_000

/** 任务实际落在哪条通道上：宿主维护名额，还是独立后台 Promise。 */
export type BackgroundMode = 'maintenance' | 'detached'

/** 后台任务本体；`signal` 在超时或宿主中断时 abort。 */
export type BackgroundTask = (signal: AbortSignal) => Promise<void>

/** 运行器：给定 agent 与任务，同步返回任务落在哪条通道。 */
export type BackgroundRunner = (agent: any, task: BackgroundTask) => BackgroundMode

export interface BackgroundRunnerOptions {
  /** 后台任务超时；默认 {@link BACKGROUND_TIMEOUT_MS}。 */
  readonly timeoutMs?: number
}

/** 超时原因：挂在 `AbortController.abort` 的 reason 上，任务里可以读到。 */
const TIMEOUT_REASON = '后台任务超时'

/** 超时：显式给了正数就用它，否则用 {@link BACKGROUND_TIMEOUT_MS}。 */
function timeoutOf(options: BackgroundRunnerOptions | undefined): number {
  const raw = options?.timeoutMs
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return BACKGROUND_TIMEOUT_MS
  return Math.floor(raw)
}

/**
 * 建一个后台任务运行器。
 *
 * 每次调用都新建 controller 与 timer，互不影响；同一 agent 的并发由调用方或
 * `runMaintenance` 自己保证。
 *
 * @param options - 可选的任务超时；缺省用 {@link BACKGROUND_TIMEOUT_MS}。
 * @returns 同步返回 `'maintenance'` 或 `'detached'` 的运行器。
 */
export function createBackgroundRunner(options?: BackgroundRunnerOptions): BackgroundRunner {
  const timeoutMs = timeoutOf(options)
  return (agent: any, task: BackgroundTask): BackgroundMode => {
    const controller = new AbortController()

    /** 起超时 timer：到点 abort，并 unref 避免拖住进程退出。 */
    const arm = (): ReturnType<typeof setTimeout> => {
      const timer = setTimeout(() => controller.abort(new Error(TIMEOUT_REASON)), timeoutMs)
      void (timer as any).unref?.()
      return timer
    }

    const runMaintenance = agent?.runMaintenance
    if (typeof runMaintenance === 'function') {
      try {
        const outer = runMaintenance.call(agent, async (signal: AbortSignal) => {
          // 宿主中断（会话关闭、维护超时）要联动到任务自己的 signal 上。
          const relay = (): void => controller.abort(signal.reason)
          if (signal.aborted) relay()
          else signal.addEventListener('abort', relay, { once: true })
          const timer = arm()
          try {
            await task(controller.signal)
          } catch {
            // 任务失败由调用方在任务内部回执；这里只吞掉，不让它变成 unhandled rejection。
          } finally {
            clearTimeout(timer)
          }
        })
        // 维护 Promise 与任务 rejection 都在这里收口，不留给别人。
        void Promise.resolve(outer).catch(() => {})
        return 'maintenance'
      } catch {
        // agent 忙时会同步抛错：此刻还没起 timer，直接退回 detached。
      }
    }

    const timer = arm()
    void Promise.resolve()
      .then(() => task(controller.signal))
      .catch(() => {})
      .finally(() => clearTimeout(timer))
    return 'detached'
  }
}
