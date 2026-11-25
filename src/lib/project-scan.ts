/**
 * 项目扫描：为 `/coding init` 收集“这个仓库里到底有什么证据”的只读视图。
 *
 * 模块分两层：纯函数负责解析（package.json / Makefile / justfile / pyproject / workspace 声明 /
 * glob 匹配），`scanProject` 负责 I/O 编排（根目录清单、README、CI、docs、模块清单）。
 * 所有 I/O 都走注入的 `readdir / readFile / access`，默认实现是 `node:fs/promises`；
 * 任何一次读取失败都静默降级，`scanProject` 从不抛错，也不写任何文件。
 *
 * 另外提供 `getFilesModifiedSince`：给非 git 项目的 `-update` 提供“不使用 diff”的变更来源，
 * 按文件 mtime 与基线时间比较收集相对路径，跳过排除目录、点目录与生成的 AGENTS.md 自身。
 * `listSourceFiles` 用同一套排除规则与遍历边界枚举源码文件，供空项目判定与模型上下文使用。
 *
 * 只输出从文件里真实读到的事实：读不到的字段直接省略，不猜测日期、人名、版本号或指标。
 * `ProjectFacts.modules` 超过上限时整体留空并给出 `moduleNotice`，由命令层降级为只生成项目级文档。
 *
 * 本模块只在 Host 侧使用（依赖 `node:fs/promises`），客户端不导入它。
 *
 * @module dsh-coding/lib/project-scan
 */
import {
  access as nodeAccess,
  readFile as nodeReadFile,
  readdir as nodeReaddir,
  stat as nodeStat,
} from 'node:fs/promises'
import { basename, join } from 'node:path'

/** 包管理器；`unknown` 表示仓库里没有可识别的锁文件与 packageManager 字段。 */
export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun' | 'unknown'

/** 单条可复制命令：`name` 是脚本名，`command` 是可直接粘贴的命令，`raw` 是脚本原文。 */
export interface ScriptCommand {
  readonly name: string
  readonly command: string
  readonly raw: string
}

/** 项目级常用命令；没有证据的字段省略，`all` 始终存在（可能为空）。 */
export interface ProjectCommands {
  readonly install?: string
  readonly dev?: string
  readonly build?: string
  readonly test?: string
  readonly typecheck?: string
  readonly singleTest?: string
  readonly all: readonly ScriptCommand[]
}

/** 一条依赖事实：只保留键与版本字符串，不推断用途。 */
export interface DependencyFact {
  readonly name: string
  readonly version: string
  readonly kind: 'runtime' | 'dev' | 'peer'
}

/** 一个可独立成文的模块；路径都是相对项目根的 posix 路径。 */
export interface ProjectModule {
  readonly name: string
  readonly path: string // 相对项目根的 posix 路径，如 'packages/core'
  readonly kind: 'node' | 'python' | 'go' | 'rust' | 'unknown'
  readonly packageName?: string
  readonly description?: string
  readonly entries: readonly string[] // 相对模块根的入口文件，最多 3 个
  readonly testCommand?: string // 真实可复制，如 'pnpm --filter @x/core test'
  readonly dependencies: readonly string[] // 依赖的包名（dependencies + peerDependencies 的 key）
  readonly dependents: readonly string[] // 同仓库内依赖本模块包名的其他模块路径
}

/** FAQ 条目：只从 README / docs 里已有的 `###` 标题提取，不补答案。 */
export interface FaqEntry {
  readonly question: string
  readonly answer?: string
}

/** 一段代码样例：文件相对路径 + 截断后的源码文本。 */
export interface CodeSample {
  readonly file: string
  readonly code: string
}

/** 扫描结果：ProjectFacts 是 `/coding init` 渲染文档的唯一输入。 */
export interface ProjectFacts {
  readonly root: string
  readonly name: string
  readonly description?: string
  readonly version?: string
  readonly packageManager: PackageManager
  readonly commands: ProjectCommands
  readonly readmeTitle?: string
  readonly readmeSummary?: string
  readonly ciFiles: readonly string[]
  readonly docsFiles: readonly string[]
  readonly changelogFiles: readonly string[]
  readonly dependencies: readonly DependencyFact[]
  readonly workspaceConfigFiles: readonly string[]
  readonly explicitWorkspace: boolean
  readonly modules: readonly ProjectModule[]
  readonly moduleCount: number
  readonly moduleNotice?: string
  readonly sourceLanguages: readonly string[]
  readonly namingConvention?: 'kebab-case' | 'camelCase' | 'snake_case' | 'PascalCase'
  readonly codeSample?: CodeSample
  readonly contributingFiles: readonly string[]
  readonly faq: readonly FaqEntry[]
}

/** 扫描钩子：三个 I/O 都可注入，便于测试用假实现替换；其余字段是行为开关。 */
export interface ScanOptions {
  readonly readdir?: (path: string) => Promise<string[]>
  readonly readFile?: (path: string, encoding: 'utf8') => Promise<string>
  readonly access?: (path: string) => Promise<unknown>
  readonly moduleLimit?: number // 默认 15
}

/** 本地 mtime 扫描的钩子：`readdir / stat` 可注入，`depth / maxFiles` 是遍历边界。 */
export interface LocalChangeOptions {
  readonly readdir?: (path: string) => Promise<string[]>
  readonly stat?: (path: string) => Promise<{ readonly mtimeMs: number; isFile(): boolean }>
  readonly depth?: number // 默认 4
  readonly maxFiles?: number // 默认 1000
}

/** 本地 mtime 扫描结果：`truncated` 表示命中数超过 `maxFiles` 被截断。 */
export interface LocalChangeResult {
  readonly files: readonly string[]
  readonly truncated: boolean
}

/** 源码枚举选项：readdir/stat 可注入，depth/maxFiles 是遍历边界。 */
export interface SourceFileOptions {
  readonly readdir?: (path: string) => Promise<string[]>
  readonly stat?: (path: string) => Promise<{ isFile(): boolean }>
  readonly depth?: number // 默认 4
  readonly maxFiles?: number // 默认 200
}

/** 源码枚举结果：相对项目根的 posix 路径（去重排序），命中超过 maxFiles 时 truncated。 */
export interface SourceFileResult {
  readonly files: readonly string[]
  readonly truncated: boolean
}

/** 模块探测与路径判断时跳过的目录名。 */
export const EXCLUDED_DIRS: readonly string[] = [
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.git',
  'vendor',
  'target',
  '__tests__',
  'fixtures',
]

/** 单模块入口文件上限。 */
const MAX_MODULE_ENTRIES = 3
/** package.json 脚本进入 `all` 的上限。 */
const MAX_SCRIPTS = 20
/** docs 文档上限。 */
const MAX_DOCS_FILES = 30
/** FAQ 条目上限。 */
const MAX_FAQ = 5
/** README 摘要上限（字符）。 */
const MAX_SUMMARY = 240
/** 代码样例读取行数上限。 */
const MAX_SAMPLE_READ_LINES = 200
/** 代码样例保留行数上限。 */
const MAX_SAMPLE_LINES = 25
/** 代码样例字符上限。 */
const MAX_SAMPLE_CHARS = 1500
/** 默认模块数上限。 */
const DEFAULT_MODULE_LIMIT = 15
/** 本地 mtime 扫描的默认目录深度上限。 */
const DEFAULT_LOCAL_DEPTH = 4
/** 本地 mtime 扫描的默认文件数上限。 */
const DEFAULT_LOCAL_MAX_FILES = 1000
/** 源码枚举的默认目录深度上限。 */
const DEFAULT_SOURCE_DEPTH = 4
/** 源码枚举的默认文件数上限。 */
const DEFAULT_SOURCE_MAX_FILES = 200
/** 生成的文档文件名：它是变更基线本身，不进入本地变更列表。 */
const AGENTS_DOC_FILE = 'AGENTS.md'
/** 探测模块时用于判定目录是否独立的清单文件名。 */
const MANIFEST_FILES: readonly string[] = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml']
/** 代码样例的扩展名优先级。 */
const SAMPLE_EXTENSIONS: readonly string[] = ['.ts', '.js', '.py', '.go', '.rs']
/** 统计源码文件与命名风格时认的扩展名。 */
const SOURCE_EXTENSIONS: readonly string[] = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.vue',
]
/** FAQ 标题：`##` 到 `####` 之间的 `FAQ` 或 `常见问题`。 */
const FAQ_HEADING = /^#{2,4}\s*(FAQ|常见问题)/u
/** `matchGlob` 里需要加反斜杠的正则元字符。 */
const REGEX_SPECIALS = '\\^$.*+?()[]{}|'

/** 内部 I/O 形状：三个函数都必填，`scanProject` 负责补默认实现。 */
interface ScanIo {
  readonly readdir: (path: string) => Promise<string[]>
  readonly readFile: (path: string, encoding: 'utf8') => Promise<string>
  readonly access: (path: string) => Promise<unknown>
}

/** 模块草稿：依赖关系要等全部模块建好后才能回填，所以先留可变的 dependents。 */
interface DraftModule {
  name: string
  path: string
  kind: ProjectModule['kind']
  packageName?: string
  description?: string
  entries: string[]
  testCommand?: string
  dependencies: string[]
  dependents: string[]
}

/** 反斜杠转 `/`，去掉行首 `./` 与行尾 `/`。 */
export function normalizeRelPath(path: string): string {
  let normalized = path.replaceAll('\\', '/')
  while (normalized.startsWith('./')) normalized = normalized.slice(2)
  while (normalized.endsWith('/')) normalized = normalized.slice(0, -1)
  return normalized
}

/** 任一路径段命中 {@link EXCLUDED_DIRS} 或以 `.` 开头（`.` / `..` 除外）即为排除路径。 */
export function isExcludedPath(relPath: string): boolean {
  const segments = normalizeRelPath(relPath)
    .split('/')
    .filter((segment) => segment !== '')
  for (const segment of segments) {
    if (segment === '.' || segment === '..') continue
    if (EXCLUDED_DIRS.includes(segment)) return true
    if (segment.startsWith('.')) return true
  }
  return false
}

/**
 * 本地改动扫描的排除判定：默认同 {@link isExcludedPath}，但放行 `.github/` 子树（CI 证据）。
 *
 * `isExcludedPath` 会把任何以 `.` 开头的路径段都排除，于是 `.github/workflows/ci.yml` 这种
 * 改动在非 git 项目里永远检测不到，而 `lib/agents-doc` 的受影响章节映射恰恰把它算作
 * 「验收标准」的证据。这里只对 `.github` 之后的路径段按原规则（命中 {@link EXCLUDED_DIRS}
 * 或以 `.` 开头）判定，其余路径继续走 {@link isExcludedPath}，不改后者的语义。
 */
function isLocalScanExcluded(path: string): boolean {
  const segments = normalizeRelPath(path)
    .split('/')
    .filter((segment) => segment !== '')
  if (segments[0] !== '.github') return isExcludedPath(path)
  // `.github` 本身放行；其子树只看 `.github` 之后的段。
  for (const segment of segments.slice(1)) {
    if (segment === '.' || segment === '..') continue
    if (EXCLUDED_DIRS.includes(segment)) return true
    if (segment.startsWith('.')) return true
  }
  return false
}

/** 按锁文件判定包管理器；priority 与文件同时出现时按 pnpm → yarn → bun → npm 取。 */
export function detectPackageManager(files: readonly string[]): PackageManager {
  const names = new Set<string>()
  for (const file of files) {
    const normalized = normalizeRelPath(file)
    const slash = normalized.lastIndexOf('/')
    names.add(slash < 0 ? normalized : normalized.slice(slash + 1))
  }
  if (names.has('pnpm-lock.yaml')) return 'pnpm'
  if (names.has('yarn.lock')) return 'yarn'
  if (names.has('bun.lockb') || names.has('bun.lock')) return 'bun'
  if (names.has('package-lock.json')) return 'npm'
  return 'unknown'
}

/** 包管理器下的脚本执行命令；`unknown` 与 npm 同形。 */
export function runCommandFor(pm: PackageManager, name: string): string {
  switch (pm) {
    case 'pnpm':
      return `pnpm ${name}`
    case 'npm':
      return `npm run ${name}`
    case 'yarn':
      return `yarn ${name}`
    case 'bun':
      return `bun run ${name}`
    default:
      return `npm run ${name}`
  }
}

/**
 * 从 package.json / Makefile / justfile / pyproject 提取可复制命令。
 *
 * 已知字段（dev/build/test/typecheck/install/singleTest）优先取 package.json scripts；
 * Makefile 与 justfile 只在字段为空时按同名目标补。`all` 保持 package.json 的脚本顺序，
 * 最多 20 条，然后依次追加 make / just / poetry 命令。
 */
export function extractCommands(input: {
  packageManager: PackageManager
  packageJson?: unknown
  makefile?: string
  justfile?: string
  pyproject?: string
}): ProjectCommands {
  const packageManager = input.packageManager
  const scripts = readStringRecord(readField(input.packageJson, 'scripts'))
  const scriptMap: Record<string, string> = { ...scripts }
  const all: ScriptCommand[] = []

  for (const [name, raw] of Object.entries(scriptMap)) {
    if (all.length >= MAX_SCRIPTS) break
    all.push({ name, command: runCommandFor(packageManager, name), raw })
  }

  const devName = firstScriptName(scripts, ['dev', 'serve', 'start'])
  const buildName = firstScriptName(scripts, ['build'])
  const testName = firstScriptName(scripts, ['test'])
  const typecheckName = firstScriptName(scripts, ['typecheck', 'check', 'lint:types'])

  let dev = devName === undefined ? undefined : runCommandFor(packageManager, devName)
  let build = buildName === undefined ? undefined : runCommandFor(packageManager, buildName)
  let test = testName === undefined ? undefined : runCommandFor(packageManager, testName)
  let typecheck =
    typecheckName === undefined ? undefined : runCommandFor(packageManager, typecheckName)

  const makeTargets = input.makefile === undefined ? [] : parseMakeTargets(input.makefile)
  for (const target of makeTargets) {
    const command = `make ${target}`
    all.push({ name: target, command, raw: command })
  }
  if (dev === undefined && makeTargets.includes('dev')) dev = 'make dev'
  if (build === undefined && makeTargets.includes('build')) build = 'make build'
  if (test === undefined && makeTargets.includes('test')) test = 'make test'

  const justRecipes = input.justfile === undefined ? [] : parseJustRecipes(input.justfile)
  for (const recipe of justRecipes) {
    const command = `just ${recipe}`
    all.push({ name: recipe, command, raw: command })
  }
  if (dev === undefined && justRecipes.includes('dev')) dev = 'just dev'
  if (build === undefined && justRecipes.includes('build')) build = 'just build'
  if (test === undefined && justRecipes.includes('test')) test = 'just test'

  const poetryScripts = input.pyproject === undefined ? [] : parsePyprojectScripts(input.pyproject)
  for (const script of poetryScripts) {
    const command = `poetry run ${script}`
    all.push({ name: script, command, raw: command })
  }

  const pyproject = input.pyproject
  const hasPytest = pyproject !== undefined && pyproject.includes('pytest')
  if (test === undefined && hasPytest) test = 'pytest'

  const testRaw = scripts?.test
  let singleTest: string | undefined
  if (testRaw !== undefined) {
    if (testRaw.includes('node --test')) singleTest = 'node --test <file>'
    else if (testRaw.includes('vitest'))
      singleTest = execCommandFor(packageManager, 'vitest', 'run <file>')
    else if (testRaw.includes('jest')) singleTest = execCommandFor(packageManager, 'jest', '<file>')
  }
  if (singleTest === undefined && hasPytest) singleTest = 'pytest <file>'

  return {
    install: installCommandFor(packageManager),
    ...(dev !== undefined ? { dev } : {}),
    ...(build !== undefined ? { build } : {}),
    ...(test !== undefined ? { test } : {}),
    ...(typecheck !== undefined ? { typecheck } : {}),
    ...(singleTest !== undefined ? { singleTest } : {}),
    all,
  }
}

/**
 * 解析 workspace 声明，返回 glob 模式、来源文件名与“是否存在显式声明”。
 *
 * nx.json / turbo.json 不产生 patterns，但只要传入的是非空对象，也算显式声明。
 */
export function parseWorkspaceDeclarations(input: {
  pnpmWorkspace?: string
  packageJson?: unknown
  lernaJson?: unknown
  nxJson?: unknown
  turboJson?: unknown
  goWork?: string
  cargoToml?: string
}): { declared: boolean; patterns: string[]; sources: string[] } {
  const patterns: string[] = []
  const sources: string[] = []

  const add = (values: readonly string[], source: string): void => {
    let produced = false
    for (const value of values) {
      const pattern = cleanPattern(value)
      if (pattern === '') continue
      produced = true
      if (!patterns.includes(pattern)) patterns.push(pattern)
    }
    if (produced) sources.push(source)
  }

  if (input.pnpmWorkspace !== undefined) {
    add(parsePnpmWorkspacePackages(input.pnpmWorkspace), 'pnpm-workspace.yaml')
  }
  add(readPackageJsonWorkspaces(input.packageJson), 'package.json')
  add(readStringArray(readField(input.lernaJson, 'packages')), 'lerna.json')
  if (input.goWork !== undefined) add(parseGoWorkUsePaths(input.goWork), 'go.work')
  if (input.cargoToml !== undefined) add(parseCargoMembers(input.cargoToml), 'Cargo.toml')

  const declared =
    patterns.length > 0 || isNonEmptyJson(input.nxJson) || isNonEmptyJson(input.turboJson)
  return { declared, patterns, sources }
}

/** 把 workspace glob 翻译成正则做整串匹配：`**`→`.*`、`*`→`[^/]*`、`?`→`[^/]`。 */
export function matchGlob(pattern: string, relPath: string): boolean {
  const source = normalizeRelPath(pattern)
  const target = normalizeRelPath(relPath)
  let regex = '^'
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (char === '*') {
      if (source[index + 1] === '*') {
        regex += '.*'
        index += 1
      } else {
        regex += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      regex += '[^/]'
      continue
    }
    regex += REGEX_SPECIALS.includes(char) ? `\\${char}` : char
  }
  regex += '$'
  try {
    return new RegExp(regex, 'u').test(target)
  } catch {
    return false
  }
}

/** 统计目录下直接子文件中的源码文件数；读不到目录时返回 0，从不抛错。 */
export async function countSourceFiles(path: string, options: ScanOptions = {}): Promise<number> {
  const readdir = options.readdir ?? (async (dir: string) => await nodeReaddir(dir))
  try {
    const entries = (await readdir(path)).map(String)
    return countSourceNames(entries)
  } catch {
    return 0
  }
}

/**
 * 收集 `root` 下 mtime 晚于 `baselineMs` 的普通文件（非 git 项目的 `-update` 变更来源）。
 *
 * 不用 `git diff`，只比文件 mtime：从 `root` 递归遍历到 `depth` 层（默认 4），跳过
 * {@link isLocalScanExcluded} 命中的路径（排除目录、点目录、点文件，但放行 `.github/` 子树
 * ——CI 改动是「验收标准」章节的证据），以及生成的 `AGENTS.md` 自身
 * ——它是基线来源，不该被列成“改动”。`readdir` / `stat` 的失败都只跳过该项，从不抛错；
 * 结果去重排序，命中超过 `maxFiles`（默认 1000）就截断并置 `truncated`。
 */
export async function getFilesModifiedSince(
  root: string,
  baselineMs: number,
  options: LocalChangeOptions = {},
): Promise<LocalChangeResult> {
  const readdir = options.readdir ?? (async (path: string) => await nodeReaddir(path))
  const stat = options.stat ?? (async (path: string) => await nodeStat(path))
  const depthLimit = normalizeLocalLimit(options.depth, DEFAULT_LOCAL_DEPTH)
  const maxFiles = normalizeLocalLimit(options.maxFiles, DEFAULT_LOCAL_MAX_FILES)

  const files: string[] = []
  let truncated = false

  // `depth` 是目录相对根的段数（根为 0）；文件所在段数不超过 depthLimit。
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (truncated) return
    let entries: string[] = []
    try {
      entries = (await readdir(dir === '' ? root : join(root, dir))).map(String)
    } catch {
      return
    }
    for (const entry of entries) {
      if (truncated) return
      const rel = normalizeRelPath(dir === '' ? entry : `${dir}/${entry}`)
      if (rel === '' || isLocalScanExcluded(rel)) continue
      let info: { readonly mtimeMs: number; isFile(): boolean } | undefined
      try {
        info = await stat(join(root, rel))
      } catch {
        // 读不到 stat 就跳过该项：可能刚被删除，也可能是权限问题。
        info = undefined
      }
      if (info === undefined) continue
      if (info.isFile()) {
        if (basename(rel) === AGENTS_DOC_FILE) continue
        // 严格晚于基线才算改动；`NaN` 之类的坏 mtime 一并跳过。
        if (!(info.mtimeMs > baselineMs)) continue
        if (files.length >= maxFiles) {
          truncated = true
          return
        }
        files.push(rel)
        continue
      }
      if (depth + 1 < depthLimit) await walk(rel, depth + 1)
    }
  }

  await walk('', 0)
  const ordered = [...new Set(files)]
  ordered.sort(compareText)
  return { files: ordered, truncated }
}

/**
 * 从 `root` 递归枚举源码文件（`/coding init` 的空项目判定与模型上下文来源）。
 *
 * `depth` 是目录相对根的段数（根为 0），与 {@link getFilesModifiedSince} 同一套边界；
 * 跳过 {@link isExcludedPath} 命中的目录与文件（排除目录、点目录、点文件，`.github` 也不放行），
 * 只收集 basename 通过源码扩展名判定的普通文件，返回 `normalizeRelPath` 后的 posix 相对路径。
 * `readdir` / `stat` 失败只跳过该项，从不抛错；`root` 不存在时返回空结果。
 * 结果去重后按字典序排序；命中数超过 `maxFiles`（默认 200）就置 `truncated` 并停止遍历。
 */
export async function listSourceFiles(
  root: string,
  options: SourceFileOptions = {},
): Promise<SourceFileResult> {
  const readdir = options.readdir ?? (async (path: string) => await nodeReaddir(path))
  const stat = options.stat ?? (async (path: string) => await nodeStat(path))
  const depthLimit = normalizeLocalLimit(options.depth, DEFAULT_SOURCE_DEPTH)
  const maxFiles = normalizeLocalLimit(options.maxFiles, DEFAULT_SOURCE_MAX_FILES)

  const files: string[] = []
  let truncated = false

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (truncated) return
    let entries: string[] = []
    try {
      entries = (await readdir(dir === '' ? root : join(root, dir))).map(String)
    } catch {
      return
    }
    for (const entry of entries) {
      if (truncated) return
      const rel = normalizeRelPath(dir === '' ? entry : `${dir}/${entry}`)
      if (rel === '' || isExcludedPath(rel)) continue
      let info: { isFile(): boolean } | undefined
      try {
        info = await stat(join(root, rel))
      } catch {
        // 读不到 stat 就跳过该项：可能刚被删除，也可能是权限问题。
        info = undefined
      }
      if (info === undefined) continue
      if (info.isFile()) {
        // 只看 basename：`foo.test.ts` 这类命名仍按扩展名判定。
        if (!isSourceExtension(basename(rel))) continue
        if (files.length >= maxFiles) {
          truncated = true
          return
        }
        files.push(rel)
        continue
      }
      if (depth + 1 < depthLimit) await walk(rel, depth + 1)
    }
  }

  await walk('', 0)
  const ordered = [...new Set(files)]
  ordered.sort(compareText)
  return { files: ordered, truncated }
}

/**
 * 扫描项目根目录并返回 {@link ProjectFacts}。
 *
 * 顺序：根清单 → 关键文件原文 → 包管理/命令 → README/CI/docs → 依赖与 workspace →
 * 模块检测 → 语言/命名/样例/FAQ。任何一步失败都只让对应字段缺失，不中断扫描。
 */
export async function scanProject(root: string, options: ScanOptions = {}): Promise<ProjectFacts> {
  const io: ScanIo = {
    readdir: options.readdir ?? (async (path: string) => await nodeReaddir(path)),
    readFile:
      options.readFile ??
      (async (path: string, encoding: 'utf8') => await nodeReadFile(path, encoding)),
    access: options.access ?? (async (path: string) => await nodeAccess(path)),
  }

  // 根目录清单：失败视为空项目，后续所有根文件探测都会自然降级。
  let rootEntries: string[] = []
  try {
    rootEntries = (await io.readdir(root)).map(String)
  } catch {
    rootEntries = []
  }

  // 目录清单缓存：`null` 表示不是目录 / 读不到。既省 I/O，也让“目录 or 文件”判定一致。
  const listCache = new Map<string, string[] | null>()
  const absOf = (rel: string): string => (rel === '' ? root : join(root, rel))
  const listDir = async (rel: string): Promise<string[] | null> => {
    if (listCache.has(rel)) return listCache.get(rel) ?? null
    let entries: string[] | null = null
    if (rel === '') {
      entries = rootEntries
    } else {
      try {
        entries = (await io.readdir(absOf(rel))).map(String)
      } catch {
        entries = null
      }
    }
    listCache.set(rel, entries)
    return entries
  }

  // 路径存在性优先用目录清单判断；清单不可用时才回退到 access 探测。
  const existsRel = async (rel: string): Promise<boolean> => {
    const normalized = normalizeRelPath(rel)
    if (normalized === '') return false
    const slash = normalized.lastIndexOf('/')
    const dir = slash < 0 ? '' : normalized.slice(0, slash)
    const name = slash < 0 ? normalized : normalized.slice(slash + 1)
    const entries = await listDir(dir)
    if (entries !== null) return entries.includes(name)
    try {
      await io.access(absOf(normalized))
      return true
    } catch {
      return false
    }
  }

  const readText = async (rel: string): Promise<string | undefined> => {
    try {
      return await io.readFile(absOf(normalizeRelPath(rel)), 'utf8')
    } catch {
      return undefined
    }
  }

  const readFirstText = async (candidates: readonly string[]): Promise<string | undefined> => {
    for (const candidate of candidates) {
      const text = await readText(candidate)
      if (text !== undefined) return text
    }
    return undefined
  }

  // 关键文件原文：全部 try/catch，读不到就是 undefined。
  const packageJsonText = await readText('package.json')
  const packageJson = parseJson(packageJsonText)
  const pnpmWorkspace = await readText('pnpm-workspace.yaml')
  const lernaJson = parseJson(await readText('lerna.json'))
  const nxJson = parseJson(await readText('nx.json'))
  const turboJson = parseJson(await readText('turbo.json'))
  const goWork = await readText('go.work')
  const cargoToml = await readText('Cargo.toml')
  const makefile = await readText('Makefile')
  const justfile = await readText('justfile')
  const pyproject = await readText('pyproject.toml')
  const readme = await readFirstText(['README.md', 'readme.md', 'README.markdown'])

  // 名称/版本/描述只取 package.json 与目录名。
  const name = stringField(packageJson, 'name') ?? basename(root)
  const description = stringField(packageJson, 'description')
  const version = stringField(packageJson, 'version')

  // 包管理器：packageManager 字段（'pnpm@9.0.0' 的 'pnpm@' 前缀）优先，其次锁文件。
  const declaredPackageManager = packageManagerFromField(readField(packageJson, 'packageManager'))
  const packageManager = declaredPackageManager ?? detectPackageManager(rootEntries)

  const commands = extractCommands({
    packageManager,
    ...(packageJson !== undefined ? { packageJson } : {}),
    ...(makefile !== undefined ? { makefile } : {}),
    ...(justfile !== undefined ? { justfile } : {}),
    ...(pyproject !== undefined ? { pyproject } : {}),
  })

  const readmeParts: { title?: string; summary?: string } =
    readme === undefined ? {} : extractReadme(readme)

  // CI 文件：workflows 目录枚举 + 常见根/嵌套配置的存在性。
  const ciFiles: string[] = []
  const workflows = await listDir('.github/workflows')
  if (workflows !== null) {
    for (const file of [...workflows].sort()) {
      if (/\.(?:yml|yaml)$/iu.test(file)) ciFiles.push(`.github/workflows/${file}`)
    }
  }
  for (const candidate of [
    '.gitlab-ci.yml',
    'Jenkinsfile',
    '.circleci/config.yml',
    'azure-pipelines.yml',
    '.travis.yml',
    'appveyor.yml',
  ]) {
    if (await existsRel(candidate)) ciFiles.push(candidate)
  }

  // docs/ 递归深度 ≤ 2 的 .md，最多 30 个。
  const docsFiles: string[] = []
  const docsTop = await listDir('docs')
  if (docsTop !== null) {
    for (const entry of [...docsTop].sort()) {
      if (docsFiles.length >= MAX_DOCS_FILES) break
      if (isExcludedPath(entry)) continue
      if (/\.md$/iu.test(entry)) {
        docsFiles.push(`docs/${entry}`)
        continue
      }
      const subEntries = await listDir(`docs/${entry}`)
      if (subEntries === null) continue
      for (const child of [...subEntries].sort()) {
        if (docsFiles.length >= MAX_DOCS_FILES) break
        if (isExcludedPath(`docs/${entry}/${child}`)) continue
        if (/\.md$/iu.test(child)) docsFiles.push(`docs/${entry}/${child}`)
      }
    }
  }

  const changelogFiles: string[] = []
  for (const candidate of ['CHANGELOG.md', 'HISTORY.md', 'CHANGES.md']) {
    if (await existsRel(candidate)) changelogFiles.push(candidate)
  }

  const dependencies = collectDependencies(packageJson)

  const workspaceConfigFiles: string[] = []
  for (const candidate of [
    'pnpm-workspace.yaml',
    'lerna.json',
    'nx.json',
    'turbo.json',
    'go.work',
    'Cargo.toml',
  ]) {
    if (await existsRel(candidate)) workspaceConfigFiles.push(candidate)
  }
  const packageJsonWorkspaces = readPackageJsonWorkspaces(packageJson)
  if (packageJsonWorkspaces.length > 0) workspaceConfigFiles.push('package.json')

  const declarations = parseWorkspaceDeclarations({
    ...(pnpmWorkspace !== undefined ? { pnpmWorkspace } : {}),
    packageJson,
    lernaJson,
    nxJson,
    turboJson,
    ...(goWork !== undefined ? { goWork } : {}),
    ...(cargoToml !== undefined ? { cargoToml } : {}),
  })
  const explicitWorkspace = declarations.declared

  // 模块检测：先按显式 workspace 模式，无匹配再退回启发式。
  const moduleCandidates: string[] = []
  const hasManifest = (entries: readonly string[]): boolean =>
    MANIFEST_FILES.some((file) => entries.includes(file))

  const walkByPatterns = async (dir: string, depth: number): Promise<void> => {
    const entries = await listDir(dir)
    if (entries === null) return
    for (const entry of [...entries].sort()) {
      const rel = dir === '' ? entry : `${dir}/${entry}`
      if (isExcludedPath(rel)) continue
      const childEntries = await listDir(rel)
      if (childEntries === null) continue
      if (declarations.patterns.some((pattern) => matchGlob(pattern, rel)) && hasManifest(childEntries)) {
        moduleCandidates.push(rel)
      }
      // 命中也继续下探：workspace 里允许模块嵌套。
      if (depth + 1 < 3) await walkByPatterns(rel, depth + 1)
    }
  }

  // 模块边界只到二级目录，避免把 src/http/lib 这类子目录当成独立模块。
  const moduleDirOf = (rel: string): string => {
    const segments = rel.split('/').filter((segment) => segment !== '')
    return segments.length <= 2 ? segments.join('/') : segments.slice(0, 2).join('/')
  }

  const walkByHeuristic = async (dir: string, depth: number): Promise<void> => {
    const entries = await listDir(dir)
    if (entries === null) return
    for (const entry of [...entries].sort()) {
      const rel = dir === '' ? entry : `${dir}/${entry}`
      if (isExcludedPath(rel)) continue
      const childEntries = await listDir(rel)
      if (childEntries === null) continue
      const independent = hasManifest(childEntries) || countSourceNames(childEntries) >= 5
      if (independent) {
        moduleCandidates.push(moduleDirOf(rel))
        continue // 命中后不再下探其子目录
      }
      if (depth + 1 < 3) await walkByHeuristic(rel, depth + 1)
    }
  }

  if (declarations.patterns.length > 0) await walkByPatterns('', 0)
  if (moduleCandidates.length === 0) await walkByHeuristic('', 0)

  const buildModule = async (modulePath: string): Promise<DraftModule | undefined> => {
    const moduleEntries = await listDir(modulePath)
    if (moduleEntries === null) return undefined
    const has = (file: string): boolean => moduleEntries.includes(file)

    let kind: ProjectModule['kind'] = 'unknown'
    let packageName: string | undefined
    let manifestName: string | undefined
    let description: string | undefined
    let scripts: Record<string, string> | undefined
    let dependencies: string[] = []
    const entries: string[] = []

    if (has('package.json')) {
      kind = 'node'
      const modulePackage = parseJson(await readText(`${modulePath}/package.json`))
      packageName = stringField(modulePackage, 'name')
      description = stringField(modulePackage, 'description')
      scripts = readStringRecord(readField(modulePackage, 'scripts'))
      dependencies = unique([
        ...objectKeys(readField(modulePackage, 'dependencies')),
        ...objectKeys(readField(modulePackage, 'peerDependencies')),
      ])

      for (const candidate of [
        'src/index.ts',
        'src/index.js',
        'src/main.ts',
        'index.ts',
        'index.js',
      ]) {
        if (entries.length >= MAX_MODULE_ENTRIES) break
        if (entries.includes(candidate)) continue
        if (await existsRel(`${modulePath}/${candidate}`)) entries.push(candidate)
      }
      for (const candidate of collectManifestEntries(modulePackage)) {
        if (entries.length >= MAX_MODULE_ENTRIES) break
        if (entries.includes(candidate)) continue
        if (await existsRel(`${modulePath}/${candidate}`)) entries.push(candidate)
      }
    } else if (has('pyproject.toml')) {
      kind = 'python'
      manifestName = parsePyprojectName(await readText(`${modulePath}/pyproject.toml`))
    } else if (has('go.mod')) {
      kind = 'go'
    } else if (has('Cargo.toml')) {
      kind = 'rust'
    }

    const displayName = packageName ?? manifestName ?? basename(modulePath)

    let testCommand: string | undefined
    const testScript = scripts?.test
    if (kind === 'node' && testScript !== undefined) {
      const workspaceTest =
        explicitWorkspace && packageName !== undefined
          ? workspaceTestCommand(packageManager, packageName)
          : undefined
      testCommand = workspaceTest ?? `cd ${modulePath} && ${testScript}`
    } else if (kind === 'python') {
      testCommand = `cd ${modulePath} && pytest`
    } else if (kind === 'go') {
      testCommand = `cd ${modulePath} && go test ./...`
    } else if (kind === 'rust') {
      testCommand = `cd ${modulePath} && cargo test`
    }

    const draft: DraftModule = {
      name: displayName,
      path: modulePath,
      kind,
      entries,
      dependencies,
      dependents: [],
    }
    if (packageName !== undefined) draft.packageName = packageName
    if (description !== undefined) draft.description = description
    if (testCommand !== undefined) draft.testCommand = testCommand
    return draft
  }

  const drafts: DraftModule[] = []
  const seenModulePaths = new Set<string>()
  for (const modulePath of [...moduleCandidates].sort()) {
    if (seenModulePaths.has(modulePath)) continue
    seenModulePaths.add(modulePath)
    const draft = await buildModule(modulePath)
    if (draft !== undefined) drafts.push(draft)
  }

  // 回填 dependents：同仓库内声明依赖了本模块包名的其他模块。
  const packagePaths = new Map<string, string>()
  for (const draft of drafts) {
    if (draft.packageName !== undefined) packagePaths.set(draft.packageName, draft.path)
  }
  for (const draft of drafts) {
    const packageName = draft.packageName
    if (packageName === undefined || !packagePaths.has(packageName)) {
      draft.dependents = []
      continue
    }
    const dependents = new Set<string>()
    for (const other of drafts) {
      if (other.path === draft.path) continue
      if (other.dependencies.includes(packageName)) dependents.add(other.path)
    }
    draft.dependents = [...dependents].sort()
  }

  drafts.sort((left, right) => compareText(left.path, right.path))

  const moduleCount = drafts.length
  const moduleLimit = normalizeModuleLimit(options.moduleLimit)
  let modules: readonly ProjectModule[] = []
  let moduleNotice: string | undefined
  if (moduleCount === 0) {
    modules = []
  } else if (moduleCount > moduleLimit) {
    // 模块太多时不生成模块级文档，只保留计数与提示。
    modules = []
    moduleNotice = `检测到 ${moduleCount} 个模块（超过 ${moduleLimit} 个），只生成项目级文档；请先收敛模块边界。`
  } else {
    modules = drafts.map(toProjectModule)
  }

  // 源码语言：只看根目录证据，可多项。
  const sourceLanguages: string[] = []
  if (packageJson !== undefined) {
    sourceLanguages.push((await existsRel('tsconfig.json')) ? 'TypeScript' : 'JavaScript')
  }
  if (pyproject !== undefined || (await existsRel('requirements.txt'))) sourceLanguages.push('Python')
  if (await existsRel('go.mod')) sourceLanguages.push('Go')
  if (await existsRel('Cargo.toml')) sourceLanguages.push('Rust')

  const srcEntries = await listDir('src')
  const namingConvention =
    srcEntries === null
      ? undefined
      : detectNamingConvention(
          srcEntries.filter((entry) => isSourceExtension(entry)).map((entry) => stripExtension(entry)),
        )

  const codeSample =
    (await findCodeSample(listDir, readText, 'src')) ??
    (await findCodeSample(listDir, readText, ''))

  const contributingFiles: string[] = []
  for (const candidate of [
    'CONTRIBUTING.md',
    '.github/CONTRIBUTING.md',
    'docs/CONTRIBUTING.md',
    '.github/PULL_REQUEST_TEMPLATE.md',
  ]) {
    if (await existsRel(candidate)) contributingFiles.push(candidate)
  }

  const faqTexts: string[] = []
  if (readme !== undefined) faqTexts.push(readme)
  for (const doc of docsFiles) {
    const text = await readText(doc)
    if (text !== undefined) faqTexts.push(text)
  }

  return {
    root,
    name,
    ...(description !== undefined ? { description } : {}),
    ...(version !== undefined ? { version } : {}),
    packageManager,
    commands,
    ...(readmeParts.title !== undefined ? { readmeTitle: readmeParts.title } : {}),
    ...(readmeParts.summary !== undefined ? { readmeSummary: readmeParts.summary } : {}),
    ciFiles,
    docsFiles,
    changelogFiles,
    dependencies,
    workspaceConfigFiles,
    explicitWorkspace,
    modules,
    moduleCount,
    ...(moduleNotice !== undefined ? { moduleNotice } : {}),
    sourceLanguages,
    ...(namingConvention !== undefined ? { namingConvention } : {}),
    ...(codeSample !== undefined ? { codeSample } : {}),
    contributingFiles,
    faq: extractFaq(faqTexts, MAX_FAQ),
  }
}

/** 读取未知字段；非对象返回 undefined。 */
function readField(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  return Reflect.get(value, key)
}

/** 读取非空字符串字段并去掉首尾空白。 */
function stringField(value: unknown, key: string): string | undefined {
  const raw = readField(value, key)
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : trimmed
}

/** JSON 解析：失败返回 undefined，不抛错。 */
function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** 把字符串值收成 Record；非对象或没有字符串值时返回 undefined。 */
function readStringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string') record[key] = raw
  }
  return Object.keys(record).length > 0 ? record : undefined
}

/** 取对象自己的键；非对象返回空数组。 */
function objectKeys(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return []
  return Object.keys(value)
}

/** 把 unknown 收成 string 数组（非字符串项丢弃）。 */
function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const strings: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.trim() !== '') strings.push(item)
  }
  return strings
}

/** 去重并保持首次出现的顺序。 */
function unique(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

/** 字典序比较，保证输出稳定。 */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** 包管理器安装命令。 */
function installCommandFor(pm: PackageManager): string {
  switch (pm) {
    case 'pnpm':
      return 'pnpm install'
    case 'yarn':
      return 'yarn install'
    case 'bun':
      return 'bun install'
    default:
      return 'npm install'
  }
}

/** 单个测试的“执行某一元命令”形式；`unknown` 与 npm 同形。 */
function execCommandFor(pm: PackageManager, bin: string, args: string): string {
  switch (pm) {
    case 'pnpm':
      return `pnpm exec ${bin} ${args}`
    case 'npm':
      return `npx ${bin} ${args}`
    case 'yarn':
      return `yarn ${bin} ${args}`
    case 'bun':
      return `bunx ${bin} ${args}`
    default:
      return `npx ${bin} ${args}`
  }
}

/** workspace 内的单模块测试命令；无显式 workspace 或未知包管理器时返回 undefined。 */
function workspaceTestCommand(pm: PackageManager, packageName: string): string | undefined {
  switch (pm) {
    case 'pnpm':
      return `pnpm --filter ${packageName} test`
    case 'yarn':
      return `yarn workspace ${packageName} test`
    case 'npm':
      return `npm run test --workspace ${packageName}`
    case 'bun':
      return `bun --filter ${packageName} test`
    default:
      return undefined
  }
}

/** 按顺序找第一个存在且非空的脚本名。 */
function firstScriptName(
  scripts: Record<string, string> | undefined,
  names: readonly string[],
): string | undefined {
  if (scripts === undefined) return undefined
  for (const name of names) {
    const raw = scripts[name]
    if (typeof raw === 'string' && raw.trim() !== '') return name
  }
  return undefined
}

/** 解析 Makefile 的 target：只认行首 `name:`（`:=` 与 `.PHONY` 之类排除）。 */
function parseMakeTargets(text: string): string[] {
  const targets: string[] = []
  for (const line of text.split(/\r?\n/u)) {
    const match = /^([A-Za-z0-9_.-]+)[ \t]*:(?!=)/u.exec(line)
    if (match === null) continue
    const target = match[1]
    if (target.startsWith('.') || target.includes('%')) continue
    if (!targets.includes(target)) targets.push(target)
  }
  return targets
}

/** 解析 justfile 的 recipe 名：`name 参数: ...`。 */
function parseJustRecipes(text: string): string[] {
  const recipes: string[] = []
  for (const line of text.split(/\r?\n/u)) {
    const match = /^([A-Za-z0-9_-]+)(\s[^:]*)?:/u.exec(line)
    if (match === null) continue
    const recipe = match[1]
    if (!recipes.includes(recipe)) recipes.push(recipe)
  }
  return recipes
}

/** 解析 pyproject 的 `[project.scripts]` / `[tool.poetry.scripts]` 名称。 */
function parsePyprojectScripts(text: string): string[] {
  const names: string[] = []
  let section = ''
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim()
    const heading = /^\[([^\]]+)\]$/u.exec(line)
    if (heading !== null) {
      section = heading[1].trim()
      continue
    }
    if (section !== 'project.scripts' && section !== 'tool.poetry.scripts') continue
    const match = /^([A-Za-z0-9_.-]+)\s*=\s*["']/u.exec(line)
    if (match === null) continue
    if (!names.includes(match[1])) names.push(match[1])
  }
  return names
}

/** 解析 pyproject 的模块名：`[project] name` 或 `[tool.poetry] name`。 */
function parsePyprojectName(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  let section = ''
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim()
    const heading = /^\[([^\]]+)\]$/u.exec(line)
    if (heading !== null) {
      section = heading[1].trim()
      continue
    }
    if (section !== 'project' && section !== 'tool.poetry') continue
    const match = /^name\s*=\s*["']([^"']+)["']$/u.exec(line)
    if (match !== null) {
      const name = match[1].trim()
      if (name !== '') return name
    }
  }
  return undefined
}

/** 解析 pnpm-workspace.yaml：只取 `packages:` 之后的 `-` 列表行。 */
function parsePnpmWorkspacePackages(text: string): string[] {
  const patterns: string[] = []
  let inPackages = false
  for (const rawLine of text.split(/\r?\n/u)) {
    const trimmed = rawLine.trim()
    if (!inPackages) {
      if (/^packages\s*:\s*$/u.test(trimmed)) inPackages = true
      continue
    }
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const item = /^-\s*(.*)$/u.exec(trimmed)
    if (item === null) break // 离开 packages 列表，进入下一个顶层字段
    patterns.push(item[1])
  }
  return patterns
}

/** 解析 package.json 的 workspaces：数组或 `{ packages: [...] }`。 */
function readPackageJsonWorkspaces(packageJson: unknown): string[] {
  const workspaces = readField(packageJson, 'workspaces')
  if (Array.isArray(workspaces)) return readStringArray(workspaces)
  if (typeof workspaces === 'object' && workspaces !== null) {
    const packages = Reflect.get(workspaces, 'packages')
    if (Array.isArray(packages)) return readStringArray(packages)
  }
  return []
}

/** 解析 go.work 的 `use ./x` 与 `use ( ... )` 块。 */
function parseGoWorkUsePaths(text: string): string[] {
  const paths: string[] = []
  let inBlock = false
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.replace(/\s*\/\/.*$/u, '').trim()
    if (line === '') continue
    if (inBlock) {
      if (line === ')') {
        inBlock = false
        continue
      }
      paths.push(...splitGoUseLine(line))
      continue
    }
    const single = /^use\s+(.+)$/u.exec(line)
    if (single === null) continue
    const argument = single[1].trim()
    if (argument === '(') {
      inBlock = true
      continue
    }
    paths.push(...splitGoUseLine(argument))
  }
  return paths
}

/** go.work 的一行 use 参数：按空白切分，去掉引号与块括号。 */
function splitGoUseLine(line: string): string[] {
  return line
    .split(/\s+/u)
    .map((item) => item.trim().replace(/^['"]/u, '').replace(/['"]$/u, ''))
    .filter((item) => item !== '' && item !== '(' && item !== ')')
}

/** 解析 Cargo.toml `[workspace]` 的 `members = [...]`（支持跨行）。 */
function parseCargoMembers(text: string): string[] {
  const workspace = /^\s*\[workspace\]\s*$/mu.exec(text)
  if (workspace === null) return []
  const section = text.slice(workspace.index)
  const members = /members\s*=\s*\[([\s\S]*?)\]/u.exec(section)
  if (members === null) return []
  const found: string[] = []
  for (const match of members[1].matchAll(/["']([^"']+)["']/gu)) found.push(match[1])
  return found
}

/** workspace 模式清洗：去行尾注释、去引号、归一化路径。 */
function cleanPattern(value: string): string {
  const comment = value.search(/\s#/u)
  const withoutComment = comment < 0 ? value : value.slice(0, comment)
  const unquoted = withoutComment
    .trim()
    .replace(/^['"]/u, '')
    .replace(/['"]$/u, '')
  return normalizeRelPath(unquoted)
}

/** 判断 JSON 值是否“非空”（对象要至少一个键）。 */
function isNonEmptyJson(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim() !== ''
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}

/** 从 package.json 的 `packageManager` 字段读包管理器名（`pnpm@x` 取 `pnpm`）。 */
function packageManagerFromField(value: unknown): PackageManager | undefined {
  if (typeof value !== 'string') return undefined
  const name = value.split('@')[0].trim().toLowerCase()
  if (name === 'pnpm' || name === 'npm' || name === 'yarn' || name === 'bun') return name
  return undefined
}

/** 收集依赖事实：runtime / dev / peer 三段，保持 package.json 顺序。 */
function collectDependencies(packageJson: unknown): DependencyFact[] {
  const facts: DependencyFact[] = []
  const sections: readonly (readonly [string, DependencyFact['kind']])[] = [
    ['dependencies', 'runtime'],
    ['devDependencies', 'dev'],
    ['peerDependencies', 'peer'],
  ]
  for (const [section, kind] of sections) {
    const record = readField(packageJson, section)
    if (typeof record !== 'object' || record === null) continue
    for (const [dependencyName, dependencyVersion] of Object.entries(record)) {
      facts.push({
        name: dependencyName,
        version:
          typeof dependencyVersion === 'string' ? dependencyVersion : String(dependencyVersion),
        kind,
      })
    }
  }
  return facts
}

/** 包入口的补充候选：packageJson.main 与 bin 的值（字符串或对象）。 */
function collectManifestEntries(packageJson: unknown): string[] {
  const candidates: string[] = []
  const main = stringField(packageJson, 'main')
  if (main !== undefined) candidates.push(main)
  const bin = readField(packageJson, 'bin')
  if (typeof bin === 'string') {
    candidates.push(bin)
  } else if (typeof bin === 'object' && bin !== null) {
    for (const value of Object.values(bin)) {
      if (typeof value === 'string') candidates.push(value)
    }
  }
  return unique(candidates.map((candidate) => normalizeRelPath(candidate)).filter((c) => c !== ''))
}

/** 从 README 提取标题与标题后第一段摘要；两者都只来自文件原文。 */
function extractReadme(text: string): { title?: string; summary?: string } {
  const lines = text.split(/\r?\n/u)
  let titleIndex = -1
  let title: string | undefined
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^#\s+(.+)$/u.exec(lines[index])
    if (match === null) continue
    const candidate = match[1].trim()
    if (candidate === '') continue
    title = candidate
    titleIndex = index
    break
  }
  if (titleIndex < 0) return {}

  const paragraph: string[] = []
  for (let index = titleIndex + 1; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (line === '') {
      if (paragraph.length > 0) break
      continue
    }
    if (line.startsWith('#')) {
      // 标题不是段落内容：遇到下一个标题就说明“标题后第一段”不存在。
      break
    }
    if (isSkippableSummaryLine(line)) {
      if (paragraph.length > 0) break
      continue
    }
    paragraph.push(line)
  }

  const summary = paragraph.join(' ').trim()
  return {
    ...(title !== undefined ? { title } : {}),
    ...(summary !== '' ? { summary: summary.slice(0, MAX_SUMMARY) } : {}),
  }
}

/** README 摘要里要跳过的行：徽章、HTML、纯链接行。 */
function isSkippableSummaryLine(line: string): boolean {
  if (line.startsWith('[![') || line.startsWith('![') || line.startsWith('<')) return true
  return /^\[[^\]]*\]\([^)]*\)$/u.test(line)
}

/** 目录清单中的源码文件数。 */
function countSourceNames(entries: readonly string[]): number {
  let count = 0
  for (const entry of entries) {
    if (isExcludedPath(entry)) continue
    if (isSourceExtension(entry)) count += 1
  }
  return count
}

/** 是否源码扩展名（大小写不敏感）。 */
function isSourceExtension(name: string): boolean {
  const lower = name.toLowerCase()
  return SOURCE_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

/** 去掉扩展名：`src/index.ts` 的 basename 处理后就是 `index`。 */
function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? name : name.slice(0, dot)
}

/** 判断命名风格：≥3 个文件名且全部同一种风格才返回，否则省略。 */
function detectNamingConvention(
  names: readonly string[],
): ProjectFacts['namingConvention'] | undefined {
  if (names.length < 3) return undefined
  if (names.every((name) => /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(name))) return 'kebab-case'
  if (names.every((name) => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u.test(name))) return 'snake_case'
  if (names.every((name) => /^[A-Z][a-zA-Z0-9]*$/u.test(name))) return 'PascalCase'
  if (names.every((name) => /^[a-z][a-zA-Z0-9]*$/u.test(name))) return 'camelCase'
  return undefined
}

/** 代码样例：src/ 优先，其次根目录；按扩展名优先级取第一个可读源码文件。 */
async function findCodeSample(
  listDir: (rel: string) => Promise<string[] | null>,
  readText: (rel: string) => Promise<string | undefined>,
  dir: string,
): Promise<CodeSample | undefined> {
  const entries = await listDir(dir)
  if (entries === null) return undefined
  const candidates = entries
    .filter((entry) => sampleRank(entry) < SAMPLE_EXTENSIONS.length)
    .sort((left, right) => sampleRank(left) - sampleRank(right) || compareText(left, right))
  for (const candidate of candidates) {
    const rel = dir === '' ? candidate : `${dir}/${candidate}`
    const text = await readText(rel)
    if (text === undefined) continue
    const lines = text.split(/\r?\n/u).slice(0, MAX_SAMPLE_READ_LINES)
    let code = lines
      .slice(0, MAX_SAMPLE_LINES)
      .map((line) => line.trimEnd())
      .join('\n')
      .trimEnd()
    if (code === '') continue
    if (code.length > MAX_SAMPLE_CHARS) code = code.slice(0, MAX_SAMPLE_CHARS)
    return { file: rel, code }
  }
  return undefined
}

/** 代码样例的扩展名优先级；不在列表里返回 {@link SAMPLE_EXTENSIONS} 长度。 */
function sampleRank(name: string): number {
  const lower = name.toLowerCase()
  const index = SAMPLE_EXTENSIONS.findIndex((extension) => lower.endsWith(extension))
  return index < 0 ? SAMPLE_EXTENSIONS.length : index
}

/** 从 README/docs 文本提取 FAQ 问题：`##`/`###`/`####` 的 FAQ 标题后、下一个 `##` 前的 `###` 标题。 */
function extractFaq(texts: readonly string[], limit: number): FaqEntry[] {
  const faq: FaqEntry[] = []
  const seen = new Set<string>()
  for (const text of texts) {
    const lines = text.split(/\r?\n/u)
    for (let index = 0; index < lines.length; index += 1) {
      if (faq.length >= limit) return faq
      if (!FAQ_HEADING.test(lines[index])) continue
      for (let inner = index + 1; inner < lines.length; inner += 1) {
        const line = lines[inner]
        if (/^##\s/u.test(line)) break
        const question = /^###\s+(.+)$/u.exec(line)
        if (question === null) continue
        const trimmed = question[1].trim()
        if (trimmed === '' || seen.has(trimmed)) continue
        seen.add(trimmed)
        faq.push({ question: trimmed })
        if (faq.length >= limit) return faq
      }
    }
  }
  return faq
}

/** 模块草稿转成对外结构：缺省字段省略，不写 undefined 键。 */
function toProjectModule(draft: DraftModule): ProjectModule {
  return {
    name: draft.name,
    path: draft.path,
    kind: draft.kind,
    ...(draft.packageName !== undefined ? { packageName: draft.packageName } : {}),
    ...(draft.description !== undefined ? { description: draft.description } : {}),
    entries: draft.entries,
    ...(draft.testCommand !== undefined ? { testCommand: draft.testCommand } : {}),
    dependencies: draft.dependencies,
    dependents: draft.dependents,
  }
}

/** moduleLimit 兜底：非法或小于 1 时取默认值 15。 */
function normalizeModuleLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return DEFAULT_MODULE_LIMIT
  return Math.floor(value)
}

/** 本地扫描的 depth / maxFiles 兜底：非法或小于 1 时取默认值。 */
function normalizeLocalLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return fallback
  return Math.floor(value)
}
