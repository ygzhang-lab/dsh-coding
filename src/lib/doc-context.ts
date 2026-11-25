/**
 * 文档提示词上下文：把项目事实、现有文档、代码与文档摘录组装成模型提示词。
 *
 * `/coding init` 的 AGENTS.md 由本会话模型撰写，模型因此必须同时看到四类材料：插件渲染的参考草稿
 * （章节参考与真实证据，已清掉占位符与空章节）、现有文档全文（更新时逐字保留未受影响章节）、
 * 有界代码与 README/docs 摘录、以及变更文件列表。提示词不能把整仓塞进去：单个摘录、参与摘录的
 * 源码文件数与整份 user 文本各有上限，超限时带截断标记硬截断。
 *
 * 纯模块：不做 I/O、不 import 内置文件系统或路径模块、不 import 预设；所有文件内容都经注入的
 * `readFile` 读取。参考章节清单、草稿渲染与占位符清洗复用 `./agents-doc.js`，事实结构复用
 * `./project-scan.js`。
 *
 * @module dsh-coding/lib/doc-context
 */
import {
  MAX_DOC_LINES,
  MODULE_SECTIONS,
  PROJECT_SECTIONS,
  pruneEmptySections,
  renderModuleDoc,
  renderProjectDoc,
  scrubPlaceholders,
} from './agents-doc.js'
import type { ProjectFacts, ProjectModule } from './project-scan.js'

/** 整份 user 文本字符上限；超过就带截断标记硬截断。 */
export const DOC_CONTEXT_TOTAL_LIMIT = 60000

/** 单个文件摘录字符上限。 */
export const DOC_CONTEXT_EXCERPT_CHARS = 2500

/** 参与摘录的源码文件上限。 */
export const DOC_CONTEXT_MAX_FILES = 24

/** 文本被截断时追加在末尾的标记。 */
export const DOC_CONTEXT_TRUNCATED_MARK = '…（已截断）'

/** 文档摘录的文件数上限：docs 取前 5 个、贡献指南取前 3 个。 */
const DOC_EXCERPT_MAX_DOCS = 5
const DOC_EXCERPT_MAX_CONTRIBUTING = 3

/**
 * 把长文本截到 `maxChars` 字符以内，被截断时追加 {@link DOC_CONTEXT_TRUNCATED_MARK}。
 *
 * 标记本身也算在预算内，所以返回值长度永远不超过 `maxChars`；短文本原样返回。
 */
export function excerptOf(text: string, maxChars: number = DOC_CONTEXT_EXCERPT_CHARS): string {
  const limit =
    Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : DOC_CONTEXT_EXCERPT_CHARS
  if (text.length <= limit) return text
  const budget = Math.max(0, limit - DOC_CONTEXT_TRUNCATED_MARK.length)
  return `${text.slice(0, budget).trimEnd()}${DOC_CONTEXT_TRUNCATED_MARK}`
}

/** 提示词种类：项目级新建、项目级更新、模块级。 */
export type DocPromptKind = 'project-create' | 'project-update' | 'module'

/** 组装提示词的输入；文件内容一律经 `readFile` 读取，入参是 posix 相对路径。 */
export interface DocPromptInput {
  readonly kind: DocPromptKind
  readonly facts: ProjectFacts
  readonly module?: ProjectModule // kind === 'module' 时必填
  readonly existingDoc?: string // 更新时传现有 AGENTS.md 全文
  readonly changedFiles?: readonly string[] // 更新时传变更文件列表
  readonly sourceFiles: readonly string[] // listSourceFiles 的结果
  readonly moduleDocs?: readonly string[] // 项目级草稿用：已有模块文档路径
  readonly sections?: readonly string[] // 本批要求撰写的章节标题；非空时才按批收窄提示词
  readonly readFile: (relPath: string) => Promise<string> // 入参是 posix 相对路径
}

/** 组装结果：system 是固定指令，user 是材料（有长度上限）。 */
export interface DocPrompt {
  readonly system: string
  readonly user: string
}

/** 一段摘录：posix 相对路径 + 已截断的文本。 */
interface Excerpt {
  readonly path: string
  readonly text: string
}

/** 反斜杠转 `/`，去掉行首 `./` 与行尾 `/`；本模块内部比较用。 */
function normalizeRelPath(path: string): string {
  let normalized = path.replaceAll('\\', '/')
  while (normalized.startsWith('./')) normalized = normalized.slice(2)
  while (normalized.endsWith('/')) normalized = normalized.slice(0, -1)
  return normalized
}

/** 读取一个相对路径的文本：失败返回 undefined，从不让提示词组装抛错。 */
async function readTextSafely(
  readFile: (relPath: string) => Promise<string>,
  relPath: string,
): Promise<string | undefined> {
  try {
    return await readFile(relPath)
  } catch {
    return undefined
  }
}

/**
 * 选源码摘录并读取内容。
 *
 * 优先序：模块级先取本模块的变更文件与 `entries`、再取模块路径前缀下的文件；项目级先取
 * `changedFiles`、再取各模块的 `entries`、最后取其余源码文件。最多 {@link DOC_CONTEXT_MAX_FILES}
 * 个（读失败的跳过、由后续候选补位），每个按 {@link excerptOf} 截断。
 */
async function collectExcerpts(input: DocPromptInput): Promise<Excerpt[]> {
  const excerpts: Excerpt[] = []
  const seen = new Set<string>()

  const append = (relPath: string, text: string | undefined): boolean => {
    const path = normalizeRelPath(relPath)
    if (text === undefined || path === '' || seen.has(path)) return false
    if (text.trim() === '') return false
    seen.add(path)
    excerpts.push({ path, text: excerptOf(text) })
    return true
  }

  const sources = new Set<string>()
  for (const file of input.sourceFiles) {
    const path = normalizeRelPath(file)
    if (path !== '') sources.add(path)
  }

  const module = input.module
  const modulePath = module === undefined ? '' : normalizeRelPath(module.path)
  const moduleEntries: string[] = []
  if (module !== undefined) {
    for (const entry of module.entries) {
      const path = normalizeRelPath(entry)
      if (path === '') continue
      moduleEntries.push(modulePath === '' ? path : `${modulePath}/${path}`)
    }
  }
  const inModule = (path: string): boolean =>
    modulePath !== '' && (path === modulePath || path.startsWith(`${modulePath}/`))

  const candidates: string[] = []
  const prefer = (raw: string): void => {
    const path = normalizeRelPath(raw)
    if (!sources.has(path) || candidates.includes(path)) return
    candidates.push(path)
  }

  if (input.kind === 'module') {
    for (const file of input.changedFiles ?? []) {
      const path = normalizeRelPath(file)
      if (inModule(path)) prefer(path)
    }
    for (const entry of moduleEntries) prefer(entry)
    for (const file of sources) {
      if (inModule(file)) prefer(file)
    }
  } else {
    for (const file of input.changedFiles ?? []) prefer(file)
    for (const item of input.facts.modules ?? []) {
      const base = normalizeRelPath(item.path)
      for (const entry of item.entries) {
        const path = normalizeRelPath(entry)
        if (path === '') continue
        prefer(base === '' ? path : `${base}/${path}`)
      }
    }
    for (const file of sources) prefer(file)
  }

  let codeCount = 0
  for (const path of candidates) {
    if (codeCount >= DOC_CONTEXT_MAX_FILES) break
    const text = await readTextSafely(input.readFile, path)
    if (append(path, text)) codeCount += 1
  }

  // 文档摘录：README/docs 与贡献指南同样截断，读失败就跳过。
  const docPaths: string[] = [
    ...(input.facts.docsFiles ?? []).slice(0, DOC_EXCERPT_MAX_DOCS),
    ...(input.facts.contributingFiles ?? []).slice(0, DOC_EXCERPT_MAX_CONTRIBUTING),
  ]
  for (const raw of docPaths) {
    const path = normalizeRelPath(raw)
    if (path === '') continue
    append(path, await readTextSafely(input.readFile, path))
  }

  return excerpts
}

/** 参考章节清单：项目级用 {@link PROJECT_SECTIONS}，模块级用 {@link MODULE_SECTIONS}，仅供参考。 */
function referenceSections(kind: DocPromptKind): readonly string[] {
  return kind === 'module' ? MODULE_SECTIONS : PROJECT_SECTIONS
}

/**
 * 拼 system 指令：输出格式、参考章节清单、禁用占位符、行数与更新范围。
 *
 * 传了非空 `sections` 时按批收窄：参考章节清单只列本批章节，新增一条「分批撰写、不要整篇文档」
 * 的硬性规则，行数约束换成单批量级；没传或传空数组时输出与不分批时逐字一致。
 */
function buildSystemPrompt(kind: DocPromptKind, sections?: readonly string[]): string {
  const batched = sections !== undefined && sections.length > 0
  const sectionList = batched && sections !== undefined ? sections : referenceSections(kind)
  const lines: string[] = [
    '你在为一个真实代码仓库撰写 AGENTS.md 的正文（中文 Markdown）。只依据 user 里给出的材料写，不要介绍你自己。',
    '',
    '硬性规则：',
    '- 只输出 Markdown 正文：不要输出解释、前言、结语，也不要用代码块把整篇文档包起来。',
    '- 只使用 `##` 章节；下面的「参考章节」只是一份参考清单，不是模板。',
    '- 不要输出一级标题（`#`），也不要输出文档名或路径标题。',
    '- 章节的增删、改名与顺序都由你按项目实际内容决定：清单里的章节可以省略、合并、改名或换位置。',
    '- 材料不足的章节直接省略，绝不写 `TODO`、`待补充`、`<!-- TODO: 待补充 -->` 或任何其它占位符。',
    '- 每个章节都必须写出基于材料的具体内容，不能只留标题或空泛套话。',
    '- 不得编造日期、版本号、人名或指标：没有证据就省略该章节。',
  ]
  if (batched) {
    lines.push(
      '- 本次是分批撰写：只输出「参考章节」清单里列出的这几章；可以改名、合并或省略材料不足的，但不要输出其它章节，也不要输出 `#` 标题或整篇文档。',
    )
    lines.push('- 本批正文控制在 60 行以内（约 2-3k token），优先短句与列表。')
  } else {
    lines.push(`- 正文总行数不超过 ${MAX_DOC_LINES} 行，优先写短句与列表。`)
  }
  lines.push('- 更新已有文档时，只输出需要修改的章节，其余章节不要重复输出。')
  if (kind !== 'module') {
    lines.push('- 「模块索引」章节由插件用表格回写，不要输出该章节。')
  } else {
    lines.push('- 本文只写 user 中给出的那一个模块，不要输出其他模块的章节。')
  }
  lines.push('', '参考章节（仅供参考：可增删、可改名、可调整顺序）：')
  for (const title of sectionList) lines.push(`- ${title}`)
  return lines.join('\n')
}

/** 「## 模块」段：模块级提示词必须让模型看到模块名与路径。 */
function moduleSection(module: ProjectModule): string {
  const path = normalizeRelPath(module.path)
  const lines = [`- 模块名：${module.name}`, `- 模块路径：\`${path}\``, `- 模块类型：${module.kind}`]
  const description = module.description?.trim() ?? ''
  if (description !== '') lines.push(`- 模块描述：${description}`)
  return ['## 模块', lines.join('\n')].join('\n\n')
}

/** 参考草稿的固定说明：章节与顺序都可增删，缺证据就省略，不许照抄空话或写占位符。 */
const DRAFT_NOTE =
  '下面只是参考草稿：章节与顺序都可以增删，缺证据的章节直接省略；不要照抄其中的空泛表述，更不要写占位符。'

/** 清洗参考草稿：先按行清掉占位符残留，再把清空后的章节整节删掉。 */
function cleanDraft(draft: string): string {
  return pruneEmptySections(scrubPlaceholders(draft))
}

/** 「## 项目事实与确定性草稿」段：模块文档也用同一标题，并在正文里注明模块路径。 */
function draftSection(input: DocPromptInput, module: ProjectModule | undefined): string {
  let rendered: string
  if (input.kind === 'module' && module !== undefined) {
    rendered = renderModuleDoc(module).text
  } else {
    rendered = renderProjectDoc(input.facts, {
      modules: input.facts.modules ?? [],
      moduleDocs: input.moduleDocs ?? [],
    }).text
  }
  const blocks = ['## 项目事实与确定性草稿']
  blocks.push(DRAFT_NOTE)
  if (input.kind === 'module' && module !== undefined) {
    blocks.push(`本段草稿针对模块 \`${normalizeRelPath(module.path)}\`。`)
  }
  const draft = cleanDraft(rendered).trimEnd()
  blocks.push(draft === '' ? '（没有可用的草稿内容）' : draft)
  return blocks.join('\n\n')
}

/** 「## 现有文档正文」段：逐字放入现有文档，并约束未受影响章节不得改写。 */
function existingDocSection(existingDoc: string): string {
  return [
    '## 现有文档正文',
    '下面是仓库里现有的文档全文。未标记为受影响的章节必须逐字保留：不要重写、不要调整顺序、不要改标题。',
    existingDoc,
  ].join('\n\n')
}

/** 「## 代码与文档摘录」段：每段是 `### <relative path>` 加一个代码块。 */
function excerptsSection(excerpts: readonly Excerpt[]): string {
  const blocks = ['## 代码与文档摘录']
  if (excerpts.length === 0) {
    blocks.push('（没有可用的代码或文档摘录）')
    return blocks.join('\n\n')
  }
  for (const excerpt of excerpts) {
    blocks.push([`### ${excerpt.path}`, ['```', excerpt.text, '```'].join('\n')].join('\n\n'))
  }
  return blocks.join('\n\n')
}

/** 「## 变更文件列表」段：只在有变更时出现，逐行列出。 */
function changedFilesSection(changedFiles: readonly string[]): string | undefined {
  const paths: string[] = []
  for (const file of changedFiles) {
    const path = normalizeRelPath(file)
    if (path === '' || paths.includes(path)) continue
    paths.push(path)
  }
  if (paths.length === 0) return undefined
  return ['## 变更文件列表', paths.map((path) => `- \`${path}\``).join('\n')].join('\n\n')
}

/** 硬截断：超过 {@link DOC_CONTEXT_TOTAL_LIMIT} 时在文末追加截断标记并切到上限。 */
function clampTotal(user: string): string {
  if (user.length <= DOC_CONTEXT_TOTAL_LIMIT) return user
  const budget = Math.max(0, DOC_CONTEXT_TOTAL_LIMIT - DOC_CONTEXT_TRUNCATED_MARK.length)
  return `${user.slice(0, budget)}${DOC_CONTEXT_TRUNCATED_MARK}`
}

/**
 * 组装一次模型调用的 system + user。
 *
 * user 的章节顺序固定：`## 模块`（仅模块级）→ `## 项目事实与确定性草稿` → `## 现有文档正文`
 * （仅有 existingDoc 时）→ `## 代码与文档摘录` → `## 变更文件列表`（仅有变更时）。草稿段先经
 * {@link scrubPlaceholders} 清掉占位符残留、再经 {@link pruneEmptySections} 删掉空章节，只作参考。
 * `input.sections` 非空时透传给 system，只要求模型写本批章节；user 段与不分批时一致。
 * 组装完成后统一做长度兜底，结果长度不超过 {@link DOC_CONTEXT_TOTAL_LIMIT}。
 */
export async function buildDocPrompt(input: DocPromptInput): Promise<DocPrompt> {
  const module = input.module
  if (input.kind === 'module' && module === undefined) {
    throw new Error('buildDocPrompt: kind 为 module 时必须提供 module')
  }

  const blocks: string[] = []
  if (input.kind === 'module' && module !== undefined) blocks.push(moduleSection(module))
  blocks.push(draftSection(input, module))

  const existingDoc = input.existingDoc ?? ''
  if (existingDoc.trim() !== '') blocks.push(existingDocSection(existingDoc))

  const excerpts = await collectExcerpts(input)
  blocks.push(excerptsSection(excerpts))

  const changed = changedFilesSection(input.changedFiles ?? [])
  if (changed !== undefined) blocks.push(changed)

  return {
    system: buildSystemPrompt(input.kind, input.sections),
    user: clampTotal(blocks.join('\n\n')),
  }
}
