/**
 * 文档模板：`/coding init` 的纯文档层。
 *
 * 三个职责：把 {@link ProjectFacts} 渲染成项目级 / 模块级 AGENTS.md 文本；把已有文档按 `##`
 * 切分并做章节级合并；判定一次变更会影响到哪些章节。全部是纯函数：不做 I/O、不 import
 * `node:fs`、不把渲染结果写入磁盘，文件读写由命令层负责。
 *
 * 防幻觉在渲染层落地：只有扫描到的真实证据才写成正文，拿不到证据就写
 * {@link TODO_PLACEHOLDER}，并把该章节的 `evidence` 标记为 false —— 命令层据此在
 * `-update` 时跳过这些章节，避免覆盖人工补充的内容。文档总长由
 * {@link truncateToMaxLines} 兜底到 {@link MAX_DOC_LINES} 行。
 *
 * 模型生成的正文不套固定模板：{@link composeGeneratedDoc} 按模型给出的章节顺序组装，
 * {@link scrubPlaceholders} 整行删除占位符残留，{@link pruneEmptySections} 与
 * {@link applyModelSections} 让清洗后为空的章节整节消失 —— 写出的文档里不留占位符。
 *
 * @module dsh-coding/docgen/agents-doc
 */
import type { ProjectFacts, ProjectModule } from './project-scan.js'

/** 缺证据时写入正文的占位符；命令层按它的出现次数汇总“待补充 N 处”。 */
export const TODO_PLACEHOLDER = '<!-- TODO: 待补充 -->'

/** 单篇文档的行数上限（按 `\n` 切分计数）。 */
export const MAX_DOC_LINES = 150

/** 项目级文档的章节顺序；渲染顺序与 `-update` 的追加顺序都以此为准。 */
export const PROJECT_SECTIONS: readonly string[] = [
  '快速开始',
  '项目背景',
  '项目目标',
  '当前状态',
  '关键里程碑',
  '交付物',
  '验收标准',
  '依赖关系',
  '协作流程',
  '模块索引',
  '代码风格',
  '边界',
  '常见问题 FAQ',
]

/** 模块级文档的章节顺序：项目级去掉「模块索引」，加「模块入口」「与父级的约定」。 */
export const MODULE_SECTIONS: readonly string[] = [
  '模块背景',
  '模块目标',
  '当前状态',
  '模块入口',
  '交付物',
  '验收标准',
  '依赖关系',
  '与父级的约定',
  '协作流程',
  '常见问题 FAQ',
]

/** 「模块索引」章节：模型不得改写，一律由插件按模块事实回写。 */
const MODULE_INDEX_TITLE = '模块索引'

/**
 * 项目级可写章节：{@link PROJECT_SECTIONS} 去掉「模块索引」后的标题，顺序保持不变。
 *
 * 「模块索引」由插件按模块事实回写，模型不写，因此分批调用模型时只从这份清单里取章节。
 */
export const PROJECT_WRITABLE_SECTIONS: readonly string[] = PROJECT_SECTIONS.filter(
  (title: string) => title !== MODULE_INDEX_TITLE,
)

/** 每批最多章节数：`/coding init` 按批调用模型，避免单次输出撞上路由的 token 上限。 */
export const BATCH_MAX_SECTIONS = 4

/**
 * 把章节标题按入参顺序切成连续批次，每批至多 `maxPerBatch` 个。
 *
 * 纯切片：不重排、不去重、不丢章节，各批依次拼接后等于入参顺序。空数组返回空数组。
 * `maxPerBatch` 非正数或非有限数时回退到 {@link BATCH_MAX_SECTIONS}（与
 * {@link truncateToMaxLines} 对 `max` 的处理风格一致）。
 */
export function planSectionBatches(
  sections: readonly string[],
  maxPerBatch: number = BATCH_MAX_SECTIONS,
): readonly (readonly string[])[] {
  const size =
    Number.isFinite(maxPerBatch) && maxPerBatch >= 1
      ? Math.floor(maxPerBatch)
      : BATCH_MAX_SECTIONS
  const batches: (readonly string[])[] = []
  for (let index = 0; index < sections.length; index += size) {
    batches.push(sections.slice(index, index + size))
  }
  return batches
}

/** 一个待渲染的章节；`body` 为空串表示该章节整节省略。 */
export interface DocSection {
  readonly title: string
  readonly body: string
  /** 是否来自真实证据；false 的章节在 `-update` 中不会被改写。 */
  readonly evidence: boolean
}

/** 渲染选项：模块清单与已有模块文档路径由命令层注入，缺省取 `facts.modules` 与空数组。 */
export interface RenderOptions {
  readonly modules?: readonly ProjectModule[]
  readonly moduleDocs?: readonly string[]
}

/** 渲染结果：文本、可用于 `-update` 的章节标题、以及待补充占位符数量。 */
export interface RenderedDoc {
  readonly text: string
  readonly evidenceSections: readonly string[]
  readonly todoCount: number
}

/** 切分后的章节：`title` 是标题文本，`raw` 是从标题行到下一章节标题前的原文切片。 */
export interface ParsedSection {
  readonly title: string
  readonly raw: string
}

/** 切分结果：第一个章节标题之前的原文 + 各章节原文。 */
export interface ParsedDoc {
  readonly preamble: string
  readonly sections: readonly ParsedSection[]
}

/** 插件自有表格章节（如「模块索引」）：正文由插件生成，补在模型章节之后。 */
export interface GeneratedDocTable {
  readonly title: string
  readonly body: string
}

/** {@link composeGeneratedDoc} 的输入。 */
export interface ComposeGeneratedDocInput {
  /** 插件提供的固定前置块，按顺序各占一段（如模块的「> 上级：…」引用行与标题行）。 */
  readonly preamble: readonly string[]
  readonly modelText: string
  /** 插件自有表格章节（如「模块索引」），追加在模型章节之后。 */
  readonly table?: GeneratedDocTable
  readonly maxLines?: number
}

/** {@link composeGeneratedDoc} 的结果。 */
export interface ComposedDoc {
  readonly text: string
  /** 实际写进文档的模型章节标题（模型顺序）。 */
  readonly applied: readonly string[]
  /** 被丢弃的模型章节标题：清洗后为空、同名重复、或「模块索引」由插件接管。 */
  readonly dropped: readonly string[]
}

/** 依赖关系章节最多逐条列出的条数；超出部分只写计数。 */
const MAX_LISTED_DEPENDENCIES = 15

/** CI 配置：`execFile` 之外的常见根文件（另有 `.github/workflows/` 前缀规则）。 */
const CI_FILES: readonly string[] = [
  '.gitlab-ci.yml',
  'Jenkinsfile',
  '.circleci/config.yml',
  'azure-pipelines.yml',
  '.travis.yml',
  'appveyor.yml',
]

/** 锁文件：只认文件名，路径任意，统一归到「依赖关系」。 */
const LOCK_FILES: readonly string[] = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'go.sum',
  'uv.lock',
]

/** 命令来源文件：改这些会让「快速开始」里的命令过期。 */
const COMMAND_FILES: readonly string[] = [
  'Makefile',
  'makefile',
  'GNUmakefile',
  'justfile',
  'Justfile',
  'pyproject.toml',
]

/** workspace 声明文件：模块集合的显式来源，归到「模块索引」。 */
const WORKSPACE_FILES: readonly string[] = [
  'pnpm-workspace.yaml',
  'lerna.json',
  'nx.json',
  'turbo.json',
  'go.work',
  'Cargo.toml',
]

/** 表头分隔行的单元格：`---`、`:--:` 之类。 */
const TABLE_SEPARATOR_CELL = /^:?-{3,}:?$/u

/** 行首的列表 / 引用标记：`-`、`*`、`+`、`>`、`1.`、`1)`。 */
const LINE_MARKER = /^\s*(?:[-*+]|>|\d+[.)])\s*/u

/** 单个单元格是否只剩占位符：`TODO`、`TODO:`、`TODO：`、`待补充`。 */
const PLACEHOLDER_CELL = /^(?:TODO[：:]?|待补充)$/u

/** 整行只剩「标签 + 占位符」时的形状；标签最多 24 字符，`TODO 列表接口待实现` 不算。 */
const PLACEHOLDER_LINE = /^.{1,24}[：:]\s*(?:TODO[：:]?|待补充)$/u

/** 反斜杠转 `/`、去掉行首 `./` 与行尾 `/`；只用于本模块内部比较。 */
function normalizeRelPath(path: string): string {
  let normalized = path.replaceAll('\\', '/')
  while (normalized.startsWith('./')) normalized = normalized.slice(2)
  while (normalized.endsWith('/')) normalized = normalized.slice(0, -1)
  return normalized
}

/** 路径的最后一段；没有 `/` 时返回原串。 */
function basenameOf(path: string): string {
  const normalized = normalizeRelPath(path)
  const slash = normalized.lastIndexOf('/')
  return slash < 0 ? normalized : normalized.slice(slash + 1)
}

/** 组装章节；`body` 为空串表示整节省略。 */
function section(title: string, body: string, evidence: boolean): DocSection {
  return { title, body, evidence }
}

/** 项目级「快速开始」：已知命令按固定顺序列出，其余脚本照实列成“其他命令”。 */
function quickStartSection(facts: ProjectFacts): DocSection {
  const commands = facts.commands
  if (commands.all.length === 0) return section('快速开始', TODO_PLACEHOLDER, false)

  const known: readonly (readonly [string, string | undefined])[] = [
    ['安装', commands.install],
    ['开发', commands.dev],
    ['构建', commands.build],
    ['测试', commands.test],
    ['类型检查', commands.typecheck],
    ['单文件测试', commands.singleTest],
  ]
  const used = new Set<string>()
  const lines: string[] = []
  for (const [label, command] of known) {
    if (command === undefined || command === '') continue
    used.add(command)
    lines.push(`- ${label}：\`${command}\``)
  }
  for (const script of commands.all) {
    if (used.has(script.command)) continue
    lines.push(`- 其他命令（${script.name}）：\`${script.command}\``)
  }
  return section('快速开始', lines.join('\n'), true)
}

/** 项目级「项目背景」：描述与 README 摘要各占一段，都是原文，不补写。 */
function backgroundSection(facts: ProjectFacts): DocSection {
  const parts: string[] = []
  const description = facts.description?.trim() ?? ''
  const summary = facts.readmeSummary?.trim() ?? ''
  if (description !== '') parts.push(description)
  if (summary !== '') parts.push(summary)
  if (parts.length === 0) return section('项目背景', TODO_PLACEHOLDER, false)
  return section('项目背景', parts.join('\n\n'), true)
}

/** 项目级「当前状态」：只写 package.json 里真实存在的版本号，进度留给人填。 */
function statusSection(facts: ProjectFacts): DocSection {
  const version = facts.version?.trim() ?? ''
  if (version === '') return section('当前状态', TODO_PLACEHOLDER, false)
  return section(
    '当前状态',
    [`- 版本：\`${version}\`（来自 package.json）`, `- 阶段与进度：${TODO_PLACEHOLDER}`].join('\n\n'),
    true,
  )
}

/** 项目级「交付物」：包名 + 每个模块一行。 */
function deliverablesSection(facts: ProjectFacts): DocSection {
  if (facts.modules.length === 0) return section('交付物', TODO_PLACEHOLDER, false)
  const lines = [`- 包 \`${facts.name}\``]
  for (const module of facts.modules) {
    lines.push(`- 模块 \`${module.path}\`（${module.kind}）`)
  }
  return section('交付物', lines.join('\n'), true)
}

/** 项目级「验收标准」：可复制的测试/构建/类型检查命令与 CI 配置。 */
function acceptanceSection(facts: ProjectFacts): DocSection {
  const lines: string[] = []
  const commands = facts.commands
  if (commands.test !== undefined && commands.test !== '') {
    lines.push(`- 测试通过：\`${commands.test}\``)
  }
  if (commands.build !== undefined && commands.build !== '') {
    lines.push(`- 构建通过：\`${commands.build}\``)
  }
  if (commands.typecheck !== undefined && commands.typecheck !== '') {
    lines.push(`- 类型检查通过：\`${commands.typecheck}\``)
  }
  for (const file of facts.ciFiles) {
    lines.push(`- CI 通过：\`${file}\``)
  }
  if (lines.length === 0) return section('验收标准', TODO_PLACEHOLDER, false)
  return section('验收标准', lines.join('\n'), true)
}

/** 项目级「依赖关系」：前 15 条逐条列出，其余只写计数。 */
function dependenciesSection(facts: ProjectFacts): DocSection {
  const dependencies = facts.dependencies
  if (dependencies.length === 0) return section('依赖关系', TODO_PLACEHOLDER, false)
  const lines: string[] = []
  for (const dependency of dependencies.slice(0, MAX_LISTED_DEPENDENCIES)) {
    lines.push(`- \`${dependency.name}\`（${dependency.kind}）：\`${dependency.version}\``)
  }
  const rest = dependencies.length - MAX_LISTED_DEPENDENCIES
  if (rest > 0) lines.push(`- 其余 ${rest} 个依赖见 package.json`)
  return section('依赖关系', lines.join('\n'), true)
}

/** 项目级「协作流程」：有贡献指南就指向文件，否则留三条人工约定占位。 */
function collaborationSection(facts: ProjectFacts): DocSection {
  if (facts.contributingFiles.length > 0) {
    const lines = facts.contributingFiles.map((file) => `- 贡献与评审约定见 \`${file}\``)
    return section('协作流程', lines.join('\n'), true)
  }
  const lines = ['- 分支命名：TODO', '- 提交规范：TODO', '- PR 与评审：TODO']
  return section('协作流程', lines.join('\n'), false)
}

/** 项目级「模块索引」：没有模块时整节省略（body 为空串）。 */
function moduleIndexSection(modules: readonly ProjectModule[], moduleDocs: readonly string[]): DocSection {
  if (modules.length === 0) return section('模块索引', '', false)
  return section('模块索引', moduleIndexTable(modules, moduleDocs), true)
}

/** 项目级「代码风格」：命名风格来自目录统计，代码样例来自真实文件首几行。 */
function codeStyleSection(facts: ProjectFacts): DocSection {
  const convention = facts.namingConvention
  const sample = facts.codeSample
  if (convention === undefined && sample === undefined) {
    return section('代码风格', TODO_PLACEHOLDER, false)
  }

  const blocks: string[] = []
  if (convention !== undefined) {
    const example = sample === undefined ? '' : `（如 \`${basenameOf(sample.file)}\`）`
    blocks.push(`- 文件名使用 ${convention}${example}`)
  }
  if (sample !== undefined) {
    blocks.push(
      [`\`\`\`${languageFor(sample.file)}`, `// ${sample.file}`, sample.code, '```'].join('\n'),
    )
  }
  return section('代码风格', blocks.join('\n\n'), true)
}

/** 项目级「常见问题 FAQ」：只复用已有问题，答案留占位。 */
function faqSection(facts: ProjectFacts): DocSection {
  if (facts.faq.length === 0) return section('常见问题 FAQ', TODO_PLACEHOLDER, false)
  const blocks = facts.faq.map((entry) => `### ${entry.question}\n\n${TODO_PLACEHOLDER}`)
  return section('常见问题 FAQ', blocks.join('\n\n'), true)
}

/** 模块级「模块背景」：优先 package.json 的 description。 */
function moduleBackgroundSection(module: ProjectModule): DocSection {
  const description = module.description?.trim() ?? ''
  if (description === '') return section('模块背景', TODO_PLACEHOLDER, false)
  return section('模块背景', description, true)
}

/** 模块级「模块入口」：扫描到的入口文件逐行列出。 */
function moduleEntriesSection(module: ProjectModule): DocSection {
  if (module.entries.length === 0) return section('模块入口', TODO_PLACEHOLDER, false)
  const lines = module.entries.map((entry) => `- \`${entry}\``)
  return section('模块入口', lines.join('\n'), true)
}

/** 模块级「交付物」：有包名写包名，否则退回第一个入口文件。 */
function moduleDeliverablesSection(module: ProjectModule): DocSection {
  const packageName = module.packageName?.trim() ?? ''
  if (packageName !== '') return section('交付物', `- 包 \`${packageName}\``, true)
  const entry = module.entries[0]
  if (entry !== undefined) return section('交付物', `- 入口：\`${entry}\``, true)
  return section('交付物', TODO_PLACEHOLDER, false)
}

/** 模块级「验收标准」：只写真实可复制的模块测试命令。 */
function moduleAcceptanceSection(module: ProjectModule): DocSection {
  const testCommand = module.testCommand?.trim() ?? ''
  if (testCommand === '') return section('验收标准', TODO_PLACEHOLDER, false)
  return section('验收标准', `- \`${testCommand}\` 通过`, true)
}

/** 模块级「依赖关系」：依赖与被依赖各一行。 */
function moduleDependenciesSection(module: ProjectModule): DocSection {
  const lines: string[] = []
  if (module.dependencies.length > 0) {
    const names = module.dependencies.map((name) => `\`${name}\``).join('、')
    lines.push(`- 依赖：${names}`)
  }
  if (module.dependents.length > 0) {
    const paths = module.dependents.map((path) => `\`${path}\``).join('、')
    lines.push(`- 被依赖：${paths}（修改公共 API 时通知这些模块）`)
  }
  if (lines.length === 0) return section('依赖关系', TODO_PLACEHOLDER, false)
  return section('依赖关系', lines.join('\n'), true)
}

/** 代码块语言标记：只认 ts/js/py/go/rs，未知扩展名不带标记。 */
function languageFor(file: string): string {
  const lower = file.toLowerCase()
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return 'ts'
  if (
    lower.endsWith('.js') ||
    lower.endsWith('.jsx') ||
    lower.endsWith('.mjs') ||
    lower.endsWith('.cjs')
  ) {
    return 'js'
  }
  if (lower.endsWith('.py')) return 'py'
  if (lower.endsWith('.go')) return 'go'
  if (lower.endsWith('.rs')) return 'rs'
  return ''
}

/**
 * 生成项目级章节列表（未截断、未省略空章节）。
 *
 * 顺序严格等于 {@link PROJECT_SECTIONS}；`body` 为空串的章节由渲染函数负责跳过。
 */
export function buildProjectSections(facts: ProjectFacts, options: RenderOptions = {}): DocSection[] {
  const modules = options.modules ?? facts.modules
  const moduleDocs = options.moduleDocs ?? []

  return [
    quickStartSection(facts),
    backgroundSection(facts),
    section('项目目标', TODO_PLACEHOLDER, false),
    statusSection(facts),
    section(
      '关键里程碑',
      ['| 里程碑 | 目标日期 | 交付物 | 状态 |', '| --- | --- | --- | --- |', TODO_PLACEHOLDER].join(
        '\n',
      ),
      false,
    ),
    deliverablesSection(facts),
    acceptanceSection(facts),
    dependenciesSection(facts),
    collaborationSection(facts),
    moduleIndexSection(modules, moduleDocs),
    codeStyleSection(facts),
    section(
      '边界',
      [
        '- ✅ Always：提交前运行本项目的测试命令；改动前先读目标文件。',
        '- ⚠️ Ask first：修改公共 API、依赖清单、CI 配置或数据迁移前先确认。',
        '- ❌ Never：提交密钥、`node_modules`、或手工改锁文件绕过解析。',
      ].join('\n'),
      false,
    ),
    faqSection(facts),
  ]
}

/**
 * 渲染项目级 AGENTS.md 文本。
 *
 * 空章节整节省略、章节之间空一行，最后统一截断到 {@link MAX_DOC_LINES} 行；
 * `evidenceSections` 只包含截断后仍然存在的证据章节，供 `-update` 组装 updates。
 */
export function renderProjectDoc(facts: ProjectFacts, options: RenderOptions = {}): RenderedDoc {
  const sections = buildProjectSections(facts, options)
  const blocks: string[] = [`# AGENTS.md — ${facts.name}`]
  const visible = sections.filter((item) => item.body.trim() !== '')
  for (const item of visible) blocks.push(`## ${item.title}\n\n${item.body}`)
  return finishDoc(blocks, visible)
}

/** 生成模块级章节列表；顺序严格等于 {@link MODULE_SECTIONS}。 */
export function buildModuleSections(module: ProjectModule): DocSection[] {
  return [
    moduleBackgroundSection(module),
    section('模块目标', TODO_PLACEHOLDER, false),
    section('当前状态', TODO_PLACEHOLDER, false),
    moduleEntriesSection(module),
    moduleDeliverablesSection(module),
    moduleAcceptanceSection(module),
    moduleDependenciesSection(module),
    section(
      '与父级的约定',
      [
        '- 构建命令、全局代码风格、通用协作流程继承上级文档，本文不重复。',
        '- 改动对外 API 时同步更新上级「模块索引」与受影响模块的 AGENTS.md。',
      ].join('\n'),
      false,
    ),
    section('协作流程', '', false),
    section('常见问题 FAQ', TODO_PLACEHOLDER, false),
  ]
}

/**
 * 渲染模块级 AGENTS.md 文本。
 *
 * 首行固定是引用上级文档的说明（全局规则、构建命令、协作流程以项目级为准），
 * 之后是标题与 {@link MODULE_SECTIONS} 的章节；同样截断到 {@link MAX_DOC_LINES} 行。
 */
export function renderModuleDoc(module: ProjectModule): RenderedDoc {
  const sections = buildModuleSections(module)
  const parent = parentLinkFor(module.path)
  const blocks: string[] = [
    `> 上级：[项目级 AGENTS.md](${parent})（全局规则、构建命令、协作流程以此为准，本文不重复）`,
    `# AGENTS.md — ${module.name}`,
  ]
  const visible = sections.filter((item) => item.body.trim() !== '')
  for (const item of visible) blocks.push(`## ${item.title}\n\n${item.body}`)
  return finishDoc(blocks, visible)
}

/** 拼接块、兜底行数、统计占位符；两个渲染函数共用。 */
function finishDoc(blocks: readonly string[], visible: readonly DocSection[]): RenderedDoc {
  const text = truncateToMaxLines(`${blocks.join('\n\n')}\n`, MAX_DOC_LINES)
  const rendered = new Set(splitSections(text).sections.map((item) => item.title))
  return {
    text,
    evidenceSections: visible
      .filter((item) => item.evidence && rendered.has(item.title))
      .map((item) => item.title),
    todoCount: countTodoPlaceholders(text),
  }
}

/** 模块路径到项目级 AGENTS.md 的相对链接；深度按 `/` 段数决定。 */
export function parentLinkFor(modulePath: string): string {
  const depth = normalizeRelPath(modulePath)
    .split('/')
    .filter((segment) => segment !== '').length
  return `${'../'.repeat(depth)}AGENTS.md`
}

/** 模块文档相对项目根的 posix 路径，如 `packages/core/AGENTS.md`。 */
export function moduleDocRelativePath(modulePath: string): string {
  const normalized = normalizeRelPath(modulePath)
  return normalized === '' ? 'AGENTS.md' : `${normalized}/AGENTS.md`
}

/** 模块索引表格：文档列只指向确实存在的模块文档，其余写 `—`。 */
export function moduleIndexTable(
  modules: readonly ProjectModule[],
  moduleDocs: readonly string[],
): string {
  const known = new Set(moduleDocs.map((path) => normalizeRelPath(path)))
  const lines = ['| 模块 | 路径 | 文档 |', '| --- | --- | --- |']
  for (const module of modules) {
    const path = normalizeRelPath(module.path)
    const doc = known.has(path) ? `[AGENTS.md](${moduleDocRelativePath(path)})` : '—'
    lines.push(`| ${module.name} | \`${path}\` | ${doc} |`)
  }
  return lines.join('\n')
}

/** 统计整篇文本里 {@link TODO_PLACEHOLDER} 的出现次数（不是 “TODO” 单词）。 */
export function countTodoPlaceholders(text: string): number {
  return text.split(TODO_PLACEHOLDER).length - 1
}

/**
 * 按行清洗占位符残留；只删「整行都只是占位符」的行，不改写正文用词。
 *
 * 删除三类行：含 {@link TODO_PLACEHOLDER} 的行；去掉行首列表/引用标记后只剩 `标签：TODO`、
 * `标签: 待补充`、`TODO`、`待补充` 的行（标签最多 24 字符）；单元格全部都是占位符的表格行
 * （有真实数据的表格行必须保留）。正文里正常出现 TODO 的句子（如 `- TODO 列表接口待实现`）
 * 原样保留，行尾 `\r` 也不改写。
 */
export function scrubPlaceholders(text: string): string {
  const kept: string[] = []
  for (const line of text.split('\n')) {
    if (!isPlaceholderOnlyLine(line)) kept.push(line)
  }
  return kept.join('\n')
}

/** 单行是否只剩占位符；表格行按单元格判定，其余行先去掉列表/引用标记。 */
function isPlaceholderOnlyLine(line: string): boolean {
  const content = line.endsWith('\r') ? line.slice(0, -1) : line
  if (content.includes(TODO_PLACEHOLDER)) return true

  const trimmed = content.trim()
  if (trimmed === '') return false

  if (trimmed.startsWith('|')) {
    const cells = tableCells(trimmed).filter((cell) => cell !== '')
    return cells.length > 0 && cells.every((cell) => PLACEHOLDER_CELL.test(cell))
  }

  const rest = trimmed.replace(LINE_MARKER, '').trim()
  return PLACEHOLDER_CELL.test(rest) || PLACEHOLDER_LINE.test(rest)
}

/**
 * 判断章节正文是否「没有真实内容」。
 *
 * 空行与表格分隔行不算内容；出现任何非表格正文行即视为有内容。只有表格时表头不算数据，
 * 因此「表头 + 分隔行」仍是空章节（例如只剩表头的「关键里程碑」），出现任一数据行才算有内容。
 */
export function isEmptyDocBody(body: string): boolean {
  let headerSeen = false
  let dataRows = 0
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (!trimmed.startsWith('|')) return false
    if (isTableSeparator(tableCells(trimmed))) continue
    if (!headerSeen) {
      headerSeen = true
      continue
    }
    dataRows += 1
  }
  return dataRows === 0
}

/**
 * 截断到 `max` 行（默认 {@link MAX_DOC_LINES}）。
 *
 * 行数按 `\n` 切分统计；超限时在 `max-3` 行范围内找最后一个以 `## ` 开头的行作为切点，
 * 保留切点之前的行，再追加空行与截断说明。切点找不到就用 `max-3`。结果总行数 ≤ `max`。
 */
export function truncateToMaxLines(text: string, max: number = MAX_DOC_LINES): string {
  const limit = Number.isFinite(max) && max >= 4 ? Math.floor(max) : MAX_DOC_LINES
  const lines = text.split('\n')
  if (lines.length <= limit) return text

  const cutLimit = limit - 3
  let cut = cutLimit
  for (let index = cutLimit - 1; index > 0; index -= 1) {
    if (lines[index].startsWith('## ')) {
      cut = index
      break
    }
  }
  if (cut <= 0) cut = cutLimit
  const kept = lines.slice(0, cut)
  kept.push('', `<!-- 文档已截断：超过 ${limit} 行，请人工精简 -->`, '')
  return kept.join('\n')
}

/**
 * 按 `##` 切分文档。
 *
 * 边界正则只用 `##`（`###` 不匹配）；`preamble` 是第一个边界前的原文，每个 `section.raw`
 * 是从标题行到下一个边界前的原文切片 —— 不改写、不 trim、保留原换行。
 */
export function splitSections(markdown: string): ParsedDoc {
  const heading = /^##[ \t]+(.+?)[ \t]*$/gm
  const boundaries: { index: number; title: string }[] = []
  for (let match = heading.exec(markdown); match !== null; match = heading.exec(markdown)) {
    boundaries.push({ index: match.index, title: match[1].trim() })
  }
  if (boundaries.length === 0) return { preamble: markdown, sections: [] }

  const sections: ParsedSection[] = []
  for (let index = 0; index < boundaries.length; index += 1) {
    const start = boundaries[index].index
    const end = index + 1 < boundaries.length ? boundaries[index + 1].index : markdown.length
    sections.push({ title: boundaries[index].title, raw: markdown.slice(start, end) })
  }
  return { preamble: markdown.slice(0, boundaries[0].index), sections }
}

/** 取出某章节去掉标题行后的 trim 内容；章节不存在返回 undefined。 */
export function sectionBody(markdown: string, title: string): string | undefined {
  const wanted = title.trim()
  const found = splitSections(markdown).sections.find((item) => item.title === wanted)
  if (found === undefined) return undefined
  return bodyOfRaw(found.raw).trim()
}

/** 原文切片去掉第一行（章节标题行）后的内容。 */
function bodyOfRaw(raw: string): string {
  const newline = raw.indexOf('\n')
  return newline < 0 ? '' : raw.slice(newline + 1)
}

/** 单个章节的替换文本：标题 + 空行 + body（trimEnd）。 */
function replacementFor(title: string, body: string): string {
  return `## ${title}\n\n${body.trimEnd()}\n`
}

/**
 * 按标题做章节级合并。
 *
 * 只替换 `updates` 里给出的标题：新 body 与现有 body 相同则不重写（计入 preserved）；
 * 未提及的章节 `raw` 逐字保留；`updates` 中文档不存在的标题按 {@link PROJECT_SECTIONS}
 * 顺序（未知标题按 updates 顺序）追加到末尾。返回的 `text` 以单个 `\n` 结尾。
 *
 * 「只改证据章节」由调用方保证：把 evidence 章节放进 `updates` 即可。
 */
export function mergeSections(
  markdown: string,
  updates: ReadonlyMap<string, string>,
): { text: string; changed: string[]; preserved: string[] } {
  const parsed = splitSections(markdown)
  const changed: string[] = []
  const preserved: string[] = []
  const replaced = new Set<string>()
  const parts: string[] = [parsed.preamble]

  for (const item of parsed.sections) {
    const update = updates.get(item.title)
    if (update === undefined || replaced.has(item.title)) {
      parts.push(item.raw)
      continue
    }
    replaced.add(item.title)
    if (bodyOfRaw(item.raw).trim() === update.trim()) {
      preserved.push(item.title)
      parts.push(item.raw)
      continue
    }
    changed.push(item.title)
    parts.push(replacementFor(item.title, update))
  }

  // 文档里还没有的标题：项目级章节按固定顺序追加，其余保持 updates 的插入顺序。
  const existing = new Set(parsed.sections.map((item) => item.title))
  const appended: string[] = []
  for (const title of PROJECT_SECTIONS) {
    if (updates.has(title) && !existing.has(title)) appended.push(title)
  }
  for (const title of updates.keys()) {
    if (appended.includes(title) || existing.has(title)) continue
    appended.push(title)
  }
  for (const title of appended) {
    parts.push(replacementFor(title, updates.get(title) ?? ''))
    changed.push(title)
  }

  const text = `${parts.join('').replace(/\n+$/u, '')}\n`
  return { text, changed, preserved }
}

/**
 * 删掉清洗后为空的章节，其余章节 `raw` 原样保留。
 *
 * `preamble` 原样保留（不参与空判定）；每节先 {@link scrubPlaceholders} 再交给
 * {@link isEmptyDocBody}，判定为空的整节删除。结果去掉多余尾部空行，只留一个结尾换行，
 * 与 {@link mergeSections} 的收尾风格一致。
 */
export function pruneEmptySections(markdown: string): string {
  const parsed = splitSections(markdown)
  const parts: string[] = [parsed.preamble]
  for (const item of parsed.sections) {
    const body = scrubPlaceholders(bodyOfRaw(item.raw)).trim()
    if (isEmptyDocBody(body)) continue
    parts.push(item.raw)
  }
  return `${parts.join('').replace(/\n+$/u, '')}\n`
}

/** 清洗后的模型章节：标题 + 去掉首尾空白的正文（不含标题行）。 */
interface ModelSection {
  readonly title: string
  readonly body: string
}

/** 记录被丢弃的标题；同一个标题只记一次。 */
function pushDropped(dropped: string[], title: string): void {
  if (!dropped.includes(title)) dropped.push(title)
}

/**
 * 读取模型输出里的 `##` 章节：丢弃 preamble、清洗占位符、丢弃空章节。
 *
 * `###` 子标题留在所属章节正文里；同名标题只保留第一次出现，`模块索引` 一律丢弃
 * （由插件按模块事实回写），被丢弃的标题按出现顺序记入 `dropped`。
 */
function readModelSections(text: string): {
  readonly sections: readonly ModelSection[]
  readonly dropped: readonly string[]
} {
  const sections: ModelSection[] = []
  const dropped: string[] = []
  const seen = new Set<string>()

  for (const item of splitSections(text).sections) {
    if (item.title === MODULE_INDEX_TITLE) {
      pushDropped(dropped, item.title)
      continue
    }
    const body = scrubPlaceholders(bodyOfRaw(item.raw)).trim()
    if (isEmptyDocBody(body) || seen.has(item.title)) {
      pushDropped(dropped, item.title)
      continue
    }
    seen.add(item.title)
    sections.push({ title: item.title, body })
  }
  return { sections, dropped }
}

/**
 * 组装模型生成的文档：插件前置块 → 模型章节（模型顺序）→ 插件表格章节。
 *
 * 不套固定模板，也不按 {@link PROJECT_SECTIONS} 重排：模型返回什么章节就写什么章节；
 * 清洗后为空的、同名重复的与 `模块索引` 一律丢弃并计入 `dropped`。模型没有任何可用章节时
 * `applied` 为空、`text` 只含前置块（`table` 也不追加，由调用方转成错误）。结果截断到
 * `maxLines`（默认 {@link MAX_DOC_LINES}）行，并以单个 `\n` 结尾。
 */
export function composeGeneratedDoc(input: ComposeGeneratedDocInput): ComposedDoc {
  const model = readModelSections(input.modelText)

  const blocks: string[] = []
  for (const block of input.preamble) {
    if (block.trim() === '') continue
    blocks.push(block.trimEnd())
  }

  const applied: string[] = []
  if (model.sections.length > 0) {
    for (const item of model.sections) {
      blocks.push(`## ${item.title}\n\n${item.body}`)
      applied.push(item.title)
    }
    if (input.table !== undefined) {
      blocks.push(`## ${input.table.title}\n\n${input.table.body.trimEnd()}`)
    }
  }

  const assembled = blocks.length === 0 ? '' : `${blocks.join('\n\n')}\n`
  const truncated = truncateToMaxLines(assembled, input.maxLines ?? MAX_DOC_LINES)
  const text = truncated === '' ? '' : `${truncated.replace(/\n+$/u, '')}\n`
  // 截断可能砍掉末尾章节：只把真正写进文档的标题算作 applied。
  const written = new Set(splitSections(text).sections.map((item) => item.title))
  return {
    text,
    applied: applied.filter((title) => written.has(title)),
    dropped: model.dropped,
  }
}

/**
 * 只取模型输出里的 `##` 章节：丢弃 preamble、清洗占位符、丢弃清洗后为空的章节。
 *
 * 切分复用 {@link splitSections}，`###` 不产生章节（子标题因此留在所属章节正文里）；
 * `raw` 规范化为 `## <title>\n\n<body>\n`。返回顺序与模型输出一致，同名标题不去重。
 */
export function parseModelSections(text: string): readonly ParsedSection[] {
  const sections: ParsedSection[] = []
  for (const item of splitSections(text).sections) {
    const body = scrubPlaceholders(bodyOfRaw(item.raw)).trim()
    if (isEmptyDocBody(body)) continue
    sections.push({ title: item.title, raw: `## ${item.title}\n\n${body}\n` })
  }
  return sections
}

/**
 * 以 `skeleton` 为基准应用模型章节：只替换 `replaceable` 白名单内的标题。
 *
 * 语义：
 * - 模型清洗后没有任何可用章节时原样返回骨架（`applied` / `dropped` 都为空），连格式都不动；
 * - 同名章节只保留第一次出现，`模块索引` 一律记入 `dropped`；
 * - 骨架已有且模型返回的标题：`replaceable` 省略或包含该标题时换成模型正文（记入 `applied`），
 * 否则保留旧正文（仍清洗占位符）并把该标题记入 `dropped`；
 * - 骨架已有但模型未返回的章节：保留并清洗占位符，清洗后为空的整节删除；
 * - 骨架没有的标题：按模型出现顺序追加到末尾，记入 `applied`。
 *
 * 结果统一用 {@link truncateToMaxLines} 收敛到 {@link MAX_DOC_LINES} 行，并以单个 `\n` 结尾。
 *
 * @param skeleton - 插件渲染出的骨架文档（新建时）或现有文档（更新时）。
 * @param modelText - 模型返回的 Markdown 正文。
 * @param replaceable - 允许用模型正文替换的章节标题；省略表示骨架里的标题都可替换。
 * @returns 合并后的文本、实际应用的章节标题与被丢弃的章节标题。
 */
export function applyModelSections(
  skeleton: string,
  modelText: string,
  replaceable?: readonly string[],
): { readonly text: string; readonly applied: readonly string[]; readonly dropped: readonly string[] } {
  const model = readModelSections(modelText)
  if (model.sections.length === 0) return { text: skeleton, applied: [], dropped: [] }

  const whitelist = replaceable === undefined ? undefined : new Set(replaceable)
  const updates = new Map(model.sections.map((item) => [item.title, item.body] as const))
  const parsed = splitSections(skeleton)
  const existing = new Set(parsed.sections.map((item) => item.title))
  const dropped = [...model.dropped]
  const applied: string[] = []
  const replaced = new Set<string>()
  const parts: string[] = [parsed.preamble]

  for (const item of parsed.sections) {
    const modelBody = updates.get(item.title)
    if (modelBody !== undefined && !replaced.has(item.title)) {
      if (whitelist === undefined || whitelist.has(item.title)) {
        replaced.add(item.title)
        applied.push(item.title)
        parts.push(replacementFor(item.title, modelBody))
        continue
      }
      pushDropped(dropped, item.title)
    }

    // 保留旧章节：清洗占位符，清完为空的整节删除；清洗没改动时原文逐字保留。
    const rawBody = bodyOfRaw(item.raw)
    const scrubbed = scrubPlaceholders(rawBody)
    const body = scrubbed.trim()
    if (isEmptyDocBody(body)) continue
    parts.push(scrubbed === rawBody ? item.raw : replacementFor(item.title, body))
  }

  // 骨架没有的标题：按模型出现顺序追加到末尾。
  const appended = model.sections.filter((item) => !existing.has(item.title))
  let text = parts.join('')
  for (const item of appended) applied.push(item.title)
  if (appended.length > 0) {
    const tail = appended.map((item) => replacementFor(item.title, item.body)).join('')
    text = text === '' ? tail : `${text.replace(/\n*$/u, '')}\n\n${tail}`
  }

  return { text: truncateToMaxLines(`${text.replace(/\n+$/u, '')}\n`), applied, dropped }
}

/** 从「模块索引」表格解析模块路径：取第 2 个单元格，去反引号与空白，去重保序。 */
export function modulePathsFromIndex(markdown: string): string[] {
  const body = sectionBody(markdown, '模块索引')
  if (body === undefined) return []

  const paths: string[] = []
  const seen = new Set<string>()
  for (const line of body.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    const cells = tableCells(trimmed)
    if (cells.length < 2) continue
    if (cells[0] === '模块' || isTableSeparator(cells)) continue
    const path = cells[1].replaceAll('`', '').trim()
    if (path === '' || seen.has(path)) continue
    seen.add(path)
    paths.push(path)
  }
  return paths
}

/** 表格行切分：去掉首尾竖线后按 `|` 切，单元格各自 trim。 */
function tableCells(line: string): string[] {
  let text = line
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|')) text = text.slice(0, -1)
  return text.split('|').map((cell) => cell.trim())
}

/** 是否表头分隔行（每个单元格都是 `---` / `:--:` 之类）。 */
function isTableSeparator(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every((cell) => TABLE_SEPARATOR_CELL.test(cell))
}

/**
 * 找出文件所属的模块：按 `module.path + '/'` 前缀匹配，多个命中取最长前缀。
 *
 * 加 `/` 边界是为了让 `packages/core-utils/...` 不会被 `packages/core` 吞掉；
 * 与路径完全相同的“文件”不算命中（那只是同名目录，不是模块内的文件）。
 */
export function matchModuleForFile(
  modules: readonly ProjectModule[],
  file: string,
): ProjectModule | undefined {
  const target = normalizeRelPath(file)
  if (target === '') return undefined

  let best: ProjectModule | undefined
  let bestLength = -1
  for (const module of modules) {
    const modulePath = normalizeRelPath(module.path)
    if (modulePath === '') continue
    if (!target.startsWith(`${modulePath}/`)) continue
    if (modulePath.length > bestLength) {
      best = module
      bestLength = modulePath.length
    }
  }
  return best
}

/**
 * 判定一次变更影响到的项目级章节。
 *
 * 被模块归属的文件不算项目级证据；模块集合与上一版文档不同时补「模块索引」。
 * 返回的标题都是 {@link PROJECT_SECTIONS} 中的名字，`Set` 天然去重。
 */
export function affectedProjectSections(
  changedFiles: readonly string[],
  modules: readonly ProjectModule[],
  previousModulePaths: readonly string[],
): Set<string> {
  const affected = new Set<string>()

  for (const file of changedFiles) {
    const normalized = normalizeRelPath(file)
    if (normalized === '') continue
    // 模块内的文件只影响模块级文档，项目级不动。
    if (matchModuleForFile(modules, normalized) !== undefined) continue

    const base = basenameOf(normalized)
    if (normalized.startsWith('.github/workflows/') || CI_FILES.includes(normalized)) {
      affected.add('验收标准')
    }
    if (LOCK_FILES.includes(base)) affected.add('依赖关系')
    if (normalized === 'package.json') {
      affected.add('快速开始')
      affected.add('依赖关系')
    }
    if (COMMAND_FILES.includes(normalized)) affected.add('快速开始')
    const lowerBase = base.toLowerCase()
    if (
      lowerBase.startsWith('readme') ||
      lowerBase.startsWith('changelog') ||
      lowerBase.startsWith('history') ||
      lowerBase.startsWith('changes') ||
      normalized.startsWith('docs/')
    ) {
      affected.add('项目背景')
    }
    if (WORKSPACE_FILES.includes(normalized)) affected.add('模块索引')
  }

  if (!samePathSet(previousModulePaths, modules.map((module) => module.path))) {
    affected.add('模块索引')
  }
  return affected
}

/** 两个路径集合是否相同（忽略顺序与空路径）。 */
function samePathSet(left: readonly string[], right: readonly string[]): boolean {
  const a = new Set(left.map((path) => normalizeRelPath(path)).filter((path) => path !== ''))
  const b = new Set(right.map((path) => normalizeRelPath(path)).filter((path) => path !== ''))
  if (a.size !== b.size) return false
  for (const path of a) {
    if (!b.has(path)) return false
  }
  return true
}

/** 有文件变更的模块路径集合。 */
export function modulePathsWithChanges(
  changedFiles: readonly string[],
  modules: readonly ProjectModule[],
): Set<string> {
  const paths = new Set<string>()
  for (const file of changedFiles) {
    const module = matchModuleForFile(modules, file)
    if (module === undefined) continue
    paths.add(normalizeRelPath(module.path))
  }
  return paths
}
