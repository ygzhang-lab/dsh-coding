/**
 * 变更文件列表：为 `/coding init` 等命令提供“最近改动过哪些文件”的只读视图。
 *
 * 设计上有四条不可放松的约束：
 *
 * 1. **固定 argv 前缀**：每条 git 命令都是
 *    `git -C <root> --no-pager -c color.ui=false -c core.quotepath=false <args...>`。
 *    `core.quotepath=false` 让非 ASCII 路径保持 UTF-8 原文而不是八进制转义；参数一律以
 *    argv 数组传给 `spawn`，绝不拼 shell 字符串，路径或分支名不可能变成第二条命令。
 * 2. **不出现 destructive 动词**：本模块只读，`clean` / `reset --hard` / `checkout --` /
 *    `push --force` / `restore` / `config` 都不在调用表里；`GIT_OPTIONAL_LOCKS=0` 让只读
 *    命令不去抢 index 锁，`GIT_TERMINAL_PROMPT=0` 让缺少凭据时干净失败而不是挂在 stdin。
 * 3. **输出有界**：stdout 上限 1 MiB、stderr 上限 64 KiB，超出部分直接丢弃；再大的
 *    monorepo diff 也不会把宿主内存或模型上下文打满。
 * 4. **超时有上限**：默认 30 秒，超时 `SIGKILL` 并抛 {@link GitError}（code 为 `timeout`）。
 *
 * 命令失败一律抛 {@link GitError}（带 `code` / `command` / `stderr`），由 {@link runGit}
 * 统一负责；而 {@link getChangedFiles} 是给命令层用的安全外壳：它把每条命令的失败都收成
 * 结果对象，**从不抛错**，失败时返回 `{ ok: false, files: [] }` 与一句可展示的 reason。
 *
 * 基线优先取最近 tag（`git describe --tags --abbrev=0` → `git diff --name-only <tag>..HEAD`），
 * 没有 tag 才回退最近的提交时间窗口（`git log --name-only --since=<since>`），再叠加工作区
 * 相对 HEAD 的差异（`git diff --name-only HEAD`）与未跟踪文件
 * （`git ls-files --others --exclude-standard`）。各条命令失败只跳过该条，全部失败才整体失败；
 * 非 git 仓库只探测一次就返回 `not a git repository`，不执行任何 log/diff。
 *
 * 结果带 `baseline` 字段说明这次用了哪条基线（`tag:<tag>` / `recent:<since>` / `worktree`，
 * 工作区改动也并入文件集时追加 `+worktree`），命令层据此写进回执，让用户知道 diff 的起点。
 *
 * `GitRunner` 可注入，便于测试用假实现模拟非 git 仓库、固定输出或抛错。
 *
 * 本模块只在 Host 侧使用（依赖 `node:child_process`），客户端不导入它。
 *
 * @module dsh-coding/lib/git
 */
import { spawn, type ChildProcess } from 'node:child_process'

/** git 调用失败的原因分类：git 不可用、超时、命令本身失败。 */
export type GitErrorCode = 'git-unavailable' | 'timeout' | 'git-failed'

/** 一条 git 命令的执行失败；`command` 是 argv 的字符串形式，`stderr` 是已截断的原始输出。 */
export class GitError extends Error {
  readonly code: GitErrorCode
  readonly command: string
  readonly stderr: string

  constructor(message: string, code: GitErrorCode, command: string, stderr = '') {
    super(message)
    this.name = 'GitError'
    this.code = code
    this.command = command
    this.stderr = stderr
  }
}

/**
 * 可注入的 git 执行器：给定仓库根与 argv，成功时 resolve stdout 原文，失败时抛
 * {@link GitError}。生产默认 {@link runGit}，测试可以整体替换。
 */
export type GitRunner = (
  root: string,
  args: readonly string[],
  options?: { readonly timeoutMs?: number },
) => Promise<string>

/** git 命令执行结果；失败时 reason 非空、files 为空。 */
export interface ChangedFilesResult {
  readonly ok: boolean
  readonly files: readonly string[]
  readonly reason?: string
  /** 变更基线：`tag:v1.2.3` / `recent:7 days ago` / `worktree`；并入了工作区改动时追加 `+worktree`。 */
  readonly baseline?: string
}

export interface GetChangedFilesOptions {
  /** git 执行器；默认 {@link runGit}。 */
  readonly git?: GitRunner
  /** 没有 tag 时回退的提交时间窗口（`git log --since=<since>`）；默认 {@link GIT_SINCE}。 */
  readonly since?: string
}

/** 没有 tag 时默认回退的时间窗口。 */
export const GIT_SINCE = '7 days ago'

/** 固定 argv 前缀：`-C root` 决定仓库，两个 `-c` 关掉颜色与非 ASCII 路径转义。 */
const GIT_ARGV_PREFIX: readonly string[] = [
  '--no-pager',
  '-c',
  'color.ui=false',
  '-c',
  'core.quotepath=false',
]

/** stdout 上限（1 MiB）；仓库再大也不至于把宿主内存打满。 */
const STDOUT_CAP = 1 << 20

/** stderr 上限（64 KiB）；只用来写一句失败摘要。 */
const STDERR_CAP = 64 * 1024

/** 单条本地 git 命令的默认超时。 */
const GIT_TIMEOUT_MS = 30_000

/** 失败摘要的最大字符数；reason 会原样进命令回执，必须保持一行可读。 */
const MAX_REASON = 200

/** 工作区查询的两条命令；任何一条失败都只跳过该条。 */
const WORKTREE_COMMANDS: readonly (readonly string[])[] = [
  ['diff', '--name-only', 'HEAD'],
  ['ls-files', '--others', '--exclude-standard'],
]

/** 提交基线的前缀：最近 tag 与最近时间窗口。 */
const TAG_BASELINE_PREFIX = 'tag:'
const RECENT_BASELINE_PREFIX = 'recent:'

/** 只有工作区可用时的基线；叠加在提交基线上时只用后缀。 */
const WORKTREE_BASELINE = 'worktree'
const WORKTREE_SUFFIX = '+worktree'

/**
 * 本模块运行 git 用的环境变量：固定 locale 让报错保持英文原样，只读命令不抢 index 锁，
 * 缺少凭据时干净失败而不是等 stdin。
 */
export function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LC_ALL: 'C',
    LANG: 'C',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  }
}

/**
 * 执行一条 git 命令并返回 stdout 原文。
 *
 * 固定 argv 前缀（`-C root --no-pager -c color.ui=false -c core.quotepath=false`）由本函数
 * 统一拼好；`args` 只放真正的子命令与参数。输出有界、执行超时、失败一律抛 {@link GitError}。
 * @param root - 仓库根（或仓库内任意目录）。
 * @param args - 子命令与参数，已经拆成 argv 数组。
 * @param options - 超时毫秒数，默认 30 秒。
 * @returns stdout 原文（可能被 1 MiB 上限截断）。
 */
export function runGit(
  root: string,
  args: readonly string[],
  options: { readonly timeoutMs?: number } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS
  const argv = ['-C', root, ...GIT_ARGV_PREFIX, ...args]
  const command = args.join(' ')
  const subcommand = args[0] ?? ''

  return new Promise<string>((resolve, reject) => {
    let created: ChildProcess | undefined
    try {
      created = spawn('git', argv, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: gitEnv(),
      })
    } catch (error) {
      // spawn 的同步抛错（例如非法参数）按“git 不可用”收口。
      reject(new GitError(`cannot run git: ${messageOf(error)}`, 'git-unavailable', command))
      return
    }
    // 到这里一定已创建；这一行只为让下面的闭包拿到非空类型。
    if (created === undefined) return
    const child = created

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(
        new GitError(`git ${subcommand} timed out after ${timeoutMs}ms`, 'timeout', command, stderr),
      )
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (stdout.length < STDOUT_CAP) stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (stderr.length < STDERR_CAP) stderr += chunk.toString()
    })
    child.on('error', (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new GitError(`cannot run git: ${error.message}`, 'git-unavailable', command, stderr))
    })
    child.on('close', (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) {
        resolve(stdout)
        return
      }
      reject(
        new GitError(
          stderr.trim() !== '' ? stderr.trim() : `git ${subcommand} exited with ${String(code)}`,
          'git-failed',
          command,
          stderr,
        ),
      )
    })
  })
}

/**
 * 取 `root` 下的变更文件：优先最近 tag，其次最近 `since` 时间窗口，最后工作区改动。
 *
 * 命令顺序固定为“探测仓库 → tag → 时间窗口 → 工作区”：非 git 仓库只跑探测，
 * 有 tag 或时间窗口可用时不再重复取提交历史，工作区两条命令始终尝试（失败了就跳过）。
 * 每条命令的失败（含超时与 git 不可用）都收成结果对象，**本函数从不抛错**。
 */
export async function getChangedFiles(
  root: string,
  options: GetChangedFilesOptions = {},
): Promise<ChangedFilesResult> {
  const git = options.git ?? runGit
  const since = normalizeSince(options.since)

  // 非 git 仓库立即返回：此后一条 log / diff 都不执行。
  const inside = await attempt(git, root, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    return { ok: false, files: [], reason: 'not a git repository' }
  }

  const files: string[] = []
  const failures: string[] = []
  let baseline: string | undefined

  // 1) 最近 tag：describe 拿到非空 tag 才用 `tag..HEAD` 比对。
  const described = await attempt(git, root, ['describe', '--tags', '--abbrev=0'])
  if (described.ok) {
    const tag = described.stdout.trim()
    if (tag !== '') {
      const tagDiff = await attempt(git, root, ['diff', '--name-only', `${tag}..HEAD`])
      if (tagDiff.ok) {
        files.push(...parseFileList(tagDiff.stdout))
        baseline = `${TAG_BASELINE_PREFIX}${tag}`
      } else {
        failures.push(tagDiff.reason)
      }
    }
  } else {
    failures.push(described.reason)
  }

  // 2) 没有 tag 基线才回退到最近的提交时间窗口。
  if (baseline === undefined) {
    const recent = await attempt(git, root, ['log', '--name-only', '--pretty=format:', `--since=${since}`])
    if (recent.ok) {
      files.push(...parseFileList(recent.stdout))
      baseline = `${RECENT_BASELINE_PREFIX}${since}`
    } else {
      failures.push(recent.reason)
    }
  }

  // 3) 工作区：未提交改动与未跟踪文件，各自失败只跳过该条。
  // `worktreeOk` 决定只有工作区信息时能否算成功；`worktreeChanged` 决定是否给基线加后缀。
  let worktreeOk = false
  let worktreeChanged = false
  for (const args of WORKTREE_COMMANDS) {
    const result = await attempt(git, root, args)
    if (!result.ok) {
      failures.push(result.reason)
      continue
    }
    worktreeOk = true
    const parsed = parseFileList(result.stdout)
    if (parsed.length > 0) worktreeChanged = true
    files.push(...parsed)
  }

  // 没有任何提交基线时：工作区至少一条成功仍算成功（空仓库只有未跟踪文件的场景）。
  if (baseline === undefined) {
    if (!worktreeOk) {
      const reason = failures[0] ?? 'git command failed'
      return { ok: false, files: [], reason: clip(`git command failed: ${reason}`) }
    }
    return { ok: true, files: uniqueSorted(files), baseline: WORKTREE_BASELINE }
  }

  // 工作区查询真的并入了文件才标出来：空输出说明没有未提交改动，基线仍是纯提交基线。
  return {
    ok: true,
    files: uniqueSorted(files),
    baseline: worktreeChanged ? `${baseline}${WORKTREE_SUFFIX}` : baseline,
  }
}

/** 单条命令的执行结果：失败时只带一句摘要，不抛错。 */
type AttemptOutcome =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly reason: string }

/**
 * 执行一条 git 命令并把任何抛出物（含超时、非 Error 抛出）收成 {@link AttemptOutcome}。
 * 这是 `getChangedFiles` 不抛错的唯一落点：注入实现抛什么都在这里被吸收。
 */
async function attempt(
  git: GitRunner,
  root: string,
  args: readonly string[],
): Promise<AttemptOutcome> {
  try {
    return { ok: true, stdout: await git(root, args) }
  } catch (error) {
    return { ok: false, reason: failureReason(error) }
  }
}

/** 把抛出物转成一行失败摘要：`GitError` 优先用 stderr 原文，其次才是消息。 */
function failureReason(error: unknown): string {
  if (error instanceof GitError) {
    const detail = error.stderr.trim() !== '' ? error.stderr.trim() : error.message
    if (detail.trim() !== '') return clip(detail.trim())
  }
  const message = messageOf(error).trim()
  return clip(message !== '' ? message : 'git command failed')
}

/** 把任意抛出物转成一行可读消息。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '')
}

/** `since` 兜底：空串或纯空白时回落到 {@link GIT_SINCE}。 */
function normalizeSince(value: string | undefined): string {
  const trimmed = value === undefined ? '' : value.trim()
  return trimmed === '' ? GIT_SINCE : trimmed
}

/** `git` 的路径输出按行切分，逐行规整后丢掉空行。 */
function parseFileList(stdout: string): string[] {
  const files: string[] = []
  for (const line of stdout.split(/\r?\n/u)) {
    const file = normalizeFile(line)
    if (file !== '') files.push(file)
  }
  return files
}

/** 统一成 posix 风格：trim、反斜杠转 `/`、去掉行首 `./`。 */
function normalizeFile(line: string): string {
  let file = line.trim().replaceAll('\\', '/')
  while (file.startsWith('./')) file = file.slice(2)
  return file
}

/** 去重并按字典序排序，保证同一仓库的输出稳定可断言。 */
function uniqueSorted(files: readonly string[]): string[] {
  const unique = [...new Set(files)]
  unique.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
  return unique
}

/** 失败摘要超过 {@link MAX_REASON} 时截断，保证回执只有一行。 */
function clip(text: string): string {
  return text.length > MAX_REASON ? `${text.slice(0, MAX_REASON - 1)}…` : text
}
