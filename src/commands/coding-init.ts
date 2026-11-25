/**
 * `/coding init` 子命令：先调模型、再统一写盘 —— 生成或增量更新项目级 / 模块级 AGENTS.md。
 * 入口在 `preset.ts` 的 `/coding` 命令里，本模块只提供处理器与作用域解析 helper。
 *
 * 三条硬约束决定了这个文件的结构：
 *
 * 1. **四分支写死在 {@link branchFor} 里**：根文档不存在就生成；存在且没有 `-update`
 *    就跳过并提示；存在且有 `-update` 才做章节级增量更新；不存在却带了 `-update`
 *    降级为生成。
 * 2. **正文来自模型，插件只管结构**：每篇文档先用 `docgen/agents-doc` 从 `docgen/project-scan`
 *    的 {@link ProjectFacts} 渲染出确定性草稿，再把草稿、现有文档与 `docgen/doc-context`
 *    组装的有界材料交给注入的 {@link DocGenerate}。**新建**不套模板：`composeGeneratedDoc`
 *    只拼插件前置块（标题行 / 上级引用）与模型返回的 `##` 章节，模型顺序即写入顺序，末尾的
 *    「模块索引」由插件生成；模型没返回的模板章节一律不补。**更新**则用 `applyModelSections`
 *    只替换受影响章节，其余章节逐字保留。模型不可用、调用失败或没给出可应用章节时一律返回
 *    error 回执且零写盘，**绝不静默回退成模板**。
 *    单篇文档不再一次性生成：{@link ask} 用 `planSectionBatches` 把本次允许撰写的章节切成
 *    每批至多 `BATCH_MAX_SECTIONS` 个，逐批调用模型（提示词只列本批章节），再把各批正文按
 *    批次顺序用空行拼成一段 Markdown 交给上层。任一批失败即整体失败（reason 前缀写明第几批）。
 * 3. **先算完所有文档，再统一写盘**：所有模型调用先在 `pending` 里排队，任一失败就一个
 *    文件都不写；全部成功后才按「模块文档 → 项目级文档」的顺序落盘。
 *
 * 空项目闸门排在一切之前：`docgen/project-scan` 的 `listSourceFiles` 找不到任何源码文件时
 * 只回一句提示，既不扫描模块，也不读写文档、不调用模型。
 *
 * I/O 与变更来源全部可注入：文档读写优先走 DSH 内置 fs 服务（`ctx.fs` 的
 * `resolve` / `stat` / `readText` / `writeText`），服务缺失时回退 `node:fs/promises`；
 * 变更文件列表默认走 `docgen/git` 的 `getChangedFiles`（内部用 `spawn` + 固定 argv，不经 shell）。
 * 测试可以整体替换 `resolveFs` / `statFile` / `modifiedSince` / `getChangedFiles` /
 * `generate` / `listSources`，命令本身也从不抛错 —— 异常统一收成 `{ kind: 'error' }` 回执。
 *
 * 文档写入一律整篇 `writeText`，不走本插件的 apply_patch：apply_patch / patchText 需要工具
 * 执行上下文（actor）与 hunks，而命令 handler 没有该上下文；`mergeSections` 已经产出完整
 * 文档，整篇原子写 + `replaceIfVersion` 守卫（生成期间文档被人改过就报 FS_STALE_VERSION、
 * 不覆盖）既简单又不会覆盖手工改动。
 *
 * `-update` 的变更来源：git 可用就用 `getChangedFiles` 的基线与文件列表；git 不可用（例如
 * 非 git 仓库）**不报错**，改用根文档的 mtime 当基线、扫描其后修改过的本地文件，回执里说明
 * 未使用 diff；连 mtime 都读不到才返回错误，并且一个文件都不写。
 *
 * 本模块只在 Host 侧使用（依赖 `node:fs/promises` 作为回退），客户端不导入它。
 *
 * @module dsh-coding/commands/coding-init
 */
import {
  access as nodeAccess,
  readFile as nodeReadFile,
  stat as nodeStat,
  writeFile as nodeWriteFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { initText, type InitText } from './command-text.js'
import {
  affectedProjectSections,
  applyModelSections,
  composeGeneratedDoc,
  mergeSections,
  moduleIndexTable,
  modulePathsFromIndex,
  modulePathsWithChanges,
  MODULE_SECTIONS,
  parentLinkFor,
  planSectionBatches,
  PROJECT_WRITABLE_SECTIONS,
  renderModuleDoc,
  renderProjectDoc,
  sectionBody,
} from '../docgen/agents-doc.js'
import { buildDocPrompt } from '../docgen/doc-context.js'
import { getChangedFiles as defaultGetChangedFiles, type ChangedFilesResult } from '../docgen/git.js'
import {
  getFilesModifiedSince,
  listSourceFiles,
  scanProject as defaultScanProject,
  type ProjectFacts,
  type ProjectModule,
} from '../docgen/project-scan.js'
import type { PromptLanguage } from '../language/language.js'

/**
 * 空项目提示：一个源码文件都没有时只回这一句。
 * 处理器与异步提交器都直接取 `initText(...).emptyProject`；这个导出只为兼容既有 import。
 * @param language - 会话语言（调用方缺省按 `zh`）。
 * @returns 该语言的空项目提示。
 */
export function emptyProjectText(language: PromptLanguage): string {
  return initText(language).emptyProject
}

/** 解析后的开关；不识别其它参数，多余 token 直接忽略。 */
export interface CodingInitFlags {
  readonly update: boolean
  readonly modules: boolean
}

/**
 * 命令入参：工作区根取自 DSH `CommandInvocation.agent` 的契约字段
 * `Agent.session.header.cwd`，缺省用 `process.cwd()`。
 */
export interface CodingInitPayload {
  readonly agent?: {
    readonly session?: { readonly header?: { readonly cwd?: string } }
  }
  readonly rawInput?: unknown
  readonly signal?: AbortSignal
}

/** 一次模型生成请求：提示词由 `docgen/doc-context` 组装，`draft` 是同一份草稿供调用方核对。 */
export interface DocGenerateRequest {
  readonly agent: unknown
  readonly signal?: AbortSignal
  readonly kind: 'project-create' | 'project-update' | 'module'
  readonly system: string
  readonly user: string
  /** 确定性草稿（同时已包含在 user 中），供调用方核对。 */
  readonly draft: string
  /** 本批要求撰写的章节标题；一次模型调用只写这几章，缺省表示不分批。 */
  readonly sections?: readonly string[]
}

/** 模型生成结果：成功带正文与路由，失败带原因与建议动作。 */
export type DocGenerateResult =
  | { readonly ok: true; readonly text: string; readonly route: string }
  | { readonly ok: false; readonly reason: string; readonly action: string }

/**
 * 模型生成器。真正的模型调用在宿主侧接线（本会话当前模型），命令本身只负责组装请求、
 * 合并章节与写盘；缺省实现直接失败，不回退模板。
 */
export type DocGenerate = (request: DocGenerateRequest) => Promise<DocGenerateResult>

/**
 * 把草稿与可选材料按章节分批交给模型。
 *
 * `sections` 是本次允许撰写的全部章节标题；内部切成多批逐批调用，失败时 reason 前缀写明
 * 是第几批。模块级用 `module`，更新用 `existingDoc` / `changedFiles`。
 */
type AskDoc = (
  kind: DocGenerateRequest['kind'],
  draft: string,
  sections: readonly string[],
  extra: {
    readonly module?: ProjectModule
    readonly existingDoc?: string
    readonly changedFiles?: readonly string[]
  },
) => Promise<DocGenerateResult>

/** 命令回执；`kind` 与 DSH 命令契约一致，只有 mtime 读不到与捕获异常才是 `error`。 */
export interface CodingInitResult {
  readonly kind: 'success' | 'error'
  readonly text: string
}

/** fs 服务解析出的写入目标；本模块只需要 `targetKey` 当句柄，`displayPath` 仅用于展示。 */
export interface CodingInitTarget {
  readonly targetKey: unknown
  readonly displayPath?: string
}

/**
 * DSH 内置 fs 服务的形状（只声明本模块用到的四个方法）。
 *
 * `stat` 返回 `undefined` 表示目标不存在；`writeText` 的 `expected` 是写入守卫：
 * `createIfAbsent` 用于新建，`replaceIfVersion` 用于覆盖已有文件（版本不匹配时抛
 * `FS_STALE_VERSION`）。`policy` 与 `memory.ts` 一样原样透传。
 */
export interface CodingInitFileSystem {
  resolve(
    path: string,
    options?: { readonly cwd?: string; readonly signal?: AbortSignal },
  ): Promise<CodingInitTarget>
  stat(
    target: CodingInitTarget,
    signal?: AbortSignal,
  ): Promise<{ readonly version: unknown; readonly type: string } | undefined>
  readText(target: CodingInitTarget, signal?: AbortSignal): Promise<string>
  writeText(
    target: CodingInitTarget,
    content: string,
    expected?: { kind: 'createIfAbsent' } | { kind: 'replaceIfVersion'; version: unknown },
    signal?: AbortSignal,
    policy?: unknown,
  ): Promise<unknown>
}

/** 可注入的 I/O 与探测函数；生产环境全部缺省，测试可整体替换。 */
export interface CodingInitDeps {
  readonly access?: (path: string) => Promise<unknown>
  readonly readFile?: (path: string, encoding: 'utf8') => Promise<string>
  readonly writeFile?: (path: string, data: string, encoding: 'utf8') => Promise<unknown>
  readonly getChangedFiles?: (root: string) => Promise<ChangedFilesResult>
  readonly scanProject?: (root: string) => Promise<ProjectFacts>
  /** fs 服务解析器：给定 agent 返回服务；返回 `undefined` 就走 `node:fs/promises` 回退。 */
  readonly resolveFs?: (agent: unknown) => CodingInitFileSystem | undefined
  /** 解析本次写入使用的沙箱策略；缺省不传策略（宿主没有 sandboxPolicy 服务时）。 */
  readonly resolvePolicy?: (agent: unknown) => unknown | Promise<unknown>
  /** 单文件 mtime 读取（非 git 的 `-update` 用它当基线）；缺省用 `node:fs/promises.stat`。 */
  readonly statFile?: (path: string) => Promise<{ readonly mtimeMs: number }>
  /** 取基线之后修改过的本地文件；缺省用 `docgen/project-scan` 的 `getFilesModifiedSince`。 */
  readonly modifiedSince?: (
    root: string,
    baselineMs: number,
  ) => Promise<{ readonly files: readonly string[]; readonly truncated?: boolean }>
  /** 模型生成器；缺省返回「没有接入模型服务」，绝不回退成模板。 */
  readonly generate?: DocGenerate
  /** 有界源码文件枚举（空项目闸门 + 模型上下文的代码来源）；缺省用 `listSourceFiles`。 */
  readonly listSources?: (root: string) => Promise<{ readonly files: readonly string[]; readonly truncated: boolean }>
  /** 会话语言；缺省 `zh`（既有中文回执逐字不变）。 */
  readonly language?: () => PromptLanguage
}

/** 项目级文档文件名。 */
const ROOT_DOC_NAME = 'AGENTS.md'

/** 模块索引章节标题；回写与增量更新都以它为准。 */
const MODULE_INDEX_TITLE = '模块索引'

/**
 * 没有注入 `generate` 时的缺省实现：直接失败，绝不回退成模板。
 * 生产接线在 `preset.ts` 的 `/coding init` 处理器里完成。
 * @param copy - 本次调用的文案表（失败原因与处理办法按语言出文）。
 * @returns 一个总是失败的生成器。
 */
const noModelGenerate = (copy: InitText): DocGenerate => async () => ({
  ok: false,
  reason: copy.noGeneratorReason,
  action: copy.noGeneratorAction,
})

/** 依赖补齐默认实现后的内部形状：所有字段都必填。 */
interface ResolvedDeps {
  readonly access: (path: string) => Promise<unknown>
  readonly readFile: (path: string, encoding: 'utf8') => Promise<string>
  readonly writeFile: (path: string, data: string, encoding: 'utf8') => Promise<unknown>
  readonly getChangedFiles: (root: string) => Promise<ChangedFilesResult>
  readonly scanProject: (root: string) => Promise<ProjectFacts>
  readonly resolveFs?: (agent: unknown) => CodingInitFileSystem | undefined
  resolvePolicy: (agent: unknown) => Promise<unknown>
  readonly statFile: (path: string) => Promise<{ readonly mtimeMs: number }>
  readonly modifiedSince: (
    root: string,
    baselineMs: number,
  ) => Promise<{ readonly files: readonly string[]; readonly truncated?: boolean }>
  readonly listSources: (root: string) => Promise<{ readonly files: readonly string[]; readonly truncated: boolean }>
  /** 会话语言；每次调用入口取一次，缺省 `zh`。 */
  readonly language?: () => PromptLanguage
}

/** 文档读写器的工作区上下文：`cwd` 供策略判定，`policy` 原样透传给 `writeText`。 */
interface DocStoreContext {
  readonly cwd: string
  readonly policy: unknown
}

/**
 * 文档读写的内部抽象：根文档与所有模块文档的 exists / read / write / mtime 都走它。
 * 有 fs 服务时由 {@link serviceDocStore} 实现，缺失时由 {@link nodeDocStore} 回退。
 */
interface DocStore {
  exists(path: string): Promise<boolean>
  read(path: string): Promise<string>
  write(path: string, content: string): Promise<void>
  mtime(path: string): Promise<number>
}

/** 一次运行的变更来源：git 结果，或非 git 时按根文档 mtime 扫出的本地改动。 */
interface ChangeSource {
  readonly changed: ChangedFilesResult
  readonly localBaseline: boolean
}

/** 变更来源的解析结果：不可用时直接带上要返回的 error 回执。 */
type ChangeSourceOutcome =
  | { readonly ok: true; readonly source: ChangeSource }
  | { readonly ok: false; readonly result: CodingInitResult }

/** 不需要变更来源的分支（生成 / 跳过）用的占位结果。 */
const NOT_REQUESTED_CHANGES: ChangedFilesResult = { ok: false, files: [], reason: 'not requested' }

/** 本地 mtime 基线的标记，写进 `ChangedFilesResult.baseline` 便于回执说明。 */
const LOCAL_BASELINE = 'local-mtime'

/** fs 服务的“版本已过期”错误码：说明文档在本次生成期间被人改过。 */
const STALE_VERSION_CODE = 'FS_STALE_VERSION'

/**
 * 解析命令参数：按空白切分，只认 `-update` 与 `-modules`。
 * @param rawInput - `commands.register` 传来的原始行。
 * @returns 两个开关；非字符串或空串都是 `false`。
 */
export function parseCodingInitArgs(rawInput?: unknown): CodingInitFlags {
  const text = typeof rawInput === 'string' ? rawInput.trim() : ''
  const tokens: string[] = text === '' ? [] : text.split(/\s+/)
  return { update: tokens.includes('-update'), modules: tokens.includes('-modules') }
}

/**
 * 决定项目级文档走哪条分支。
 * @param rootExists - `AGENTS.md` 是否已存在。
 * @param update - 是否带 `-update`。
 * @returns `generate`（不存在，含“带 -update 但不存在”的降级）、`update`（存在且带
 *   `-update`）、`skip`（存在且不带 `-update`）。
 */
export function branchFor(rootExists: boolean, update: boolean): 'generate' | 'skip' | 'update' {
  if (!rootExists) return 'generate'
  return update ? 'update' : 'skip'
}

/**
 * 构造命令处理器：把依赖固定下来，返回只接收 payload 的异步函数。
 *
 * 处理器内部整体 try/catch，任何异常都变成 `{ kind: 'error' }` 回执，绝不 throw。
 * @param deps - 可选的注入实现；缺省用 Node 原生 fs/promises 与 lib 的默认实现。
 * @returns 处理一次 `/coding init` 调用的函数。
 */
export function createCodingInitHandler(
  deps: CodingInitDeps = {},
): (payload: CodingInitPayload) => Promise<CodingInitResult> {
  const resolved: ResolvedDeps = {
    access: deps.access ?? (async (path: string) => await nodeAccess(path)),
    readFile: deps.readFile ?? (async (path: string, encoding: 'utf8') => await nodeReadFile(path, encoding)),
    writeFile:
      deps.writeFile ??
      (async (path: string, data: string, encoding: 'utf8') => await nodeWriteFile(path, data, encoding)),
    getChangedFiles: deps.getChangedFiles ?? defaultGetChangedFiles,
    scanProject: deps.scanProject ?? defaultScanProject,
    ...(deps.resolveFs === undefined ? {} : { resolveFs: deps.resolveFs }),
    // 未注入时一律解析为「没有策略」：宿主缺少 sandboxPolicy 服务也走这条。
    resolvePolicy: async (agent: unknown) => await deps.resolvePolicy?.(agent),
    statFile: deps.statFile ?? (async (path: string) => await nodeStat(path)),
    modifiedSince:
      deps.modifiedSince ??
      (async (root: string, baselineMs: number) => await getFilesModifiedSince(root, baselineMs)),
    listSources: deps.listSources ?? (async (root: string) => await listSourceFiles(root)),
    ...(deps.language === undefined ? {} : { language: deps.language }),
  }

  return async (payload: CodingInitPayload): Promise<CodingInitResult> => {
    // 语言在入口只取一次，往下都以文案表传递，避免多处重复调用 deps.language。
    const copy = initText(resolved.language?.() ?? 'zh')
    const generate = deps.generate ?? noModelGenerate(copy)
    try {
      return await runCodingInit(payload, resolved, copy, generate)
    } catch (error) {
      return { kind: 'error', text: copy.runFailed(messageOf(error)) }
    }
  }
}

/**
 * 命令主流程：空项目闸门 → 扫描 → 变更来源 → 模块文档 → 项目级分支 → 统一写盘 → 组装回执。
 *
 * 顺序有讲究：模块处理必须在项目级分支之前完成（生成分支要把本次新建的模块文档写进
 * 「模块索引」，`-update` 分支要据此补该章节）；而变更来源又必须排在模块处理之前，
 * 因为非 git 的本地基线下“没有任何晚于根文档的改动”时不该新建任何模块文档。
 *
 * 写盘是两阶段的：模块级与项目级的正文先生成并排进 `pending`，任一模型调用失败就立刻
 * 返回 error —— 此时一个文件都还没写；全部成功后才按「模块文档 → 项目级文档」顺序落盘。
 */
async function runCodingInit(
  payload: CodingInitPayload,
  deps: ResolvedDeps,
  copy: InitText,
  generate: DocGenerate,
): Promise<CodingInitResult> {
  const flags = parseCodingInitArgs(payload.rawInput)
  const root = workspaceOf(payload)

  // 空项目闸门：一个源码文件都没有就只回一句提示，不扫模块、不读写文档、不调模型。
  const sources = await deps.listSources(root)
  if (sources.files.length === 0) {
    return { kind: 'success', text: copy.emptyProject }
  }

  const rootDoc = join(root, ROOT_DOC_NAME)
  const policy = await deps.resolvePolicy(payload.agent)
  const store = createDocStore(deps, payload.agent, { cwd: root, policy }, copy)
  const rootExists = await store.exists(rootDoc)
  const branch = branchFor(rootExists, flags.update)

  const facts = await deps.scanProject(root)

  // 已存在的模块文档按“模块路径”记账：模块索引表按它决定“文档”列写链接还是 —。
  const moduleDocs = new Set<string>()
  for (const module of facts.modules) {
    if (await store.exists(join(root, module.path, ROOT_DOC_NAME))) moduleDocs.add(module.path)
  }

  const notes: string[] = []

  // 只有根文档存在且带 -update 才需要变更来源：其它分支不读变更，也就不受 git 影响。
  const outcome: ChangeSourceOutcome =
    rootExists && flags.update
      ? await resolveChangeSource(deps, store, root, rootDoc, notes, copy)
      : { ok: true, source: { changed: NOT_REQUESTED_CHANGES, localBaseline: false } }
  if (!outcome.ok) return outcome.result
  const { changed, localBaseline } = outcome.source

  // 本地基线且一个文件都没变：整条命令什么也不写（含模块文档），只回报无需更新。
  const localNoChanges = localBaseline && changed.files.length === 0

  // 两阶段写盘：所有模型调用都成功后才按这里的顺序落盘（模块文档 → 项目级文档）。
  const pending: PendingDoc[] = []
  const createdModules: string[] = []
  const updatedModules: string[] = []
  // 模块路径 → 生成它的模型路由；回执要说明本次用的是哪条路由。
  const moduleRoutes = new Map<string, string>()

  if (facts.moduleNotice !== undefined) notes.push(facts.moduleNotice)
  if (flags.modules && facts.modules.length === 0) notes.push(copy.noModulesNote)

  const changedModulePaths = changed.ok
    ? modulePathsWithChanges(changed.files, facts.modules)
    : new Set<string>()

  // 相对路径读取：`buildDocPrompt` 要的是相对项目根的 posix 路径。
  const readRel = async (rel: string): Promise<string> => await store.read(join(root, rel))

  /**
   * 把草稿与上下文按章节分批交给模型；模型调用本身由注入的 `generate` 完成（宿主接线）。
   *
   * 每批只要求本批章节，各批正文按批次顺序用空行拼接成一段 Markdown。任一批失败就立即
   * 返回失败（reason 前缀写明第几批），此时调用方还没往 `pending` 写任何东西，仍然零写盘。
   * @param kind - 提示词种类。
   * @param draft - 确定性草稿（同时已包含在 user 里），供调用方核对。
   * @param sections - 本次允许撰写的全部章节标题。
   * @param extra - 模块、现有文档与变更文件等可选材料。
   * @returns 模型生成结果；失败由调用方统一转成 error 回执。
   */
  const ask: AskDoc = async (kind, draft, sections, extra) => {
    const batches = planSectionBatches(sections)
    const parts: string[] = []
    let route = ''
    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index]
      const prompt = await buildDocPrompt({
        kind,
        facts,
        ...(extra.module === undefined ? {} : { module: extra.module }),
        ...(extra.existingDoc === undefined ? {} : { existingDoc: extra.existingDoc }),
        ...(extra.changedFiles === undefined ? {} : { changedFiles: extra.changedFiles }),
        sections: batch,
        sourceFiles: sources.files,
        moduleDocs: [...moduleDocs],
        readFile: readRel,
      })
      const generated = await generate({
        agent: payload.agent,
        ...(payload.signal === undefined ? {} : { signal: payload.signal }),
        kind,
        system: prompt.system,
        user: prompt.user,
        draft,
        sections: batch,
      })
      if (!generated.ok) {
        return {
          ok: false,
          reason: copy.batchPrefix(index + 1, batches.length, generated.reason),
          action: generated.action,
        }
      }
      // 各批的路由相同（同一次运行、同一个会话模型），取首批的即可。
      if (index === 0) route = generated.route
      const text = generated.text.trim()
      if (text !== '') parts.push(text)
    }
    return { ok: true, text: parts.join('\n\n'), route }
  }

  // 模块级文档：新建一律生成；已存在时只在 -update 且有该模块内变更时才做章节级更新。
  if (flags.modules && !localNoChanges) {
    for (const module of facts.modules) {
      const docPath = join(root, module.path, ROOT_DOC_NAME)
      if (!moduleDocs.has(module.path)) {
        const draft = renderModuleDoc(module).text
        const generated = await ask('module', draft, MODULE_SECTIONS, { module })
        if (!generated.ok) return modelFailureOf(copy, generated.reason, generated.action)
        // 新建不套模板：只写插件前置块（上级引用 + 标题行）与模型给出的章节。
        const composed = composeGeneratedDoc({
          preamble: [
            copy.parentLink(parentLinkFor(module.path)),
            `# AGENTS.md — ${module.name}`,
          ],
          modelText: generated.text,
        })
        // 模型没有可用章节就失败：绝不回退成草稿，也不写任何文件。
        if (composed.applied.length === 0) {
          return modelFailureOf(copy, copy.noSectionsReason, copy.noSectionsAction)
        }
        pending.push({ path: docPath, text: composed.text, route: generated.route })
        moduleDocs.add(module.path)
        createdModules.push(module.path)
        moduleRoutes.set(module.path, generated.route)
        continue
      }

      if (!flags.update || !changed.ok) continue
      if (!changedModulePaths.has(module.path)) continue

      const previous = await store.read(docPath)
      const changedFiles = changed.files.filter(
        (file) => file === module.path || file.startsWith(`${module.path}/`),
      )
      // draft 统一表示「当前事实的模板草稿」，现有文档单独走 existingDoc。
      const draft = renderModuleDoc(module).text
      const generated = await ask('module', draft, MODULE_SECTIONS, {
        module,
        existingDoc: previous,
        changedFiles,
      })
      if (!generated.ok) return modelFailureOf(copy, generated.reason, generated.action)
      // 未受影响的章节由 applyModelSections 逐字保留；模型没给可应用章节就整篇不动。
      const merged = applyModelSections(previous, generated.text, MODULE_SECTIONS)
      if (merged.applied.length === 0) continue
      pending.push({ path: docPath, text: merged.text, route: generated.route })
      updatedModules.push(module.path)
      moduleRoutes.set(module.path, generated.route)
    }
  }

  // 没带 -modules 时只给建议：缺文档的模块不会在这里被创建。
  const adviceModules: string[] = []
  if (!flags.modules && changed.ok) {
    for (const module of facts.modules) {
      if (moduleDocs.has(module.path)) continue
      if (!changedModulePaths.has(module.path)) continue
      adviceModules.push(module.path)
    }
  }

  const branchOutcome = await runProjectBranch({
    branch,
    flags,
    facts,
    rootDoc,
    moduleDocs,
    changed,
    localBaseline,
    createdModules,
    store,
    pending,
    notes,
    ask,
    copy,
  })
  if (!branchOutcome.ok) return branchOutcome.result

  // 两阶段收尾：所有模型调用都成功，才按「模块文档 → 项目级文档」顺序统一写盘。
  for (const doc of pending) {
    await store.write(doc.path, doc.text)
  }

  const headline = branchOutcome.headline
  const moduleLines: string[] = []
  const createdLine = createdModules.length === 0
    ? undefined
    : copy.moduleSummary('created', createdModules, moduleRoutes)
  if (createdLine !== undefined) moduleLines.push(createdLine)
  const updatedLine = updatedModules.length === 0
    ? undefined
    : copy.moduleSummary('updated', updatedModules, moduleRoutes)
  if (updatedLine !== undefined) moduleLines.push(updatedLine)

  // 项目级文档没变、只动了模块文档时，模块结果必须排在最前：否则首行「无需更新」会被读成整条命令什么都没做。
  const projectUnchanged = headline === copy.noUpdateHeadline(ROOT_DOC_NAME)
  const lines: string[] = []
  if (projectUnchanged && moduleLines.length > 0) {
    lines.push(...moduleLines, copy.projectUnchangedNote(ROOT_DOC_NAME))
  } else {
    lines.push(headline, ...moduleLines)
  }
  if (adviceModules.length > 0) {
    lines.push(copy.moduleAdvice(adviceModules))
  }
  // 首行已经说明项目级文档无需更新，这条 note 就重复了。
  lines.push(...(projectUnchanged && moduleLines.length > 0
    ? notes.filter((note) => note !== copy.noSectionsToUpdateNote)
    : notes))
  if (pending.length > 0) lines.push(copy.writtenCount(pending.length))
  return { kind: 'success', text: lines.join('\n') }
}

/** 待统一写盘的文档：模块文档先进 pending，项目级文档最后进。 */
interface PendingDoc {
  readonly path: string
  readonly text: string
  /** 生成这篇文档的模型路由；插件自己回写（例如「模块索引」）时是空串。 */
  readonly route: string
}

/** 项目级分支的参数清单；只在本文件内部使用。 */
interface ProjectBranchInput {
  readonly branch: 'generate' | 'skip' | 'update'
  readonly flags: CodingInitFlags
  readonly facts: ProjectFacts
  readonly rootDoc: string
  readonly moduleDocs: ReadonlySet<string>
  readonly changed: ChangedFilesResult
  readonly localBaseline: boolean
  readonly createdModules: readonly string[]
  readonly store: DocStore
  readonly pending: PendingDoc[]
  readonly notes: string[]
  readonly ask: AskDoc
  /** 本次调用的文案表。 */
  readonly copy: InitText
}

/** 项目级分支的结果：成功给回执首行，失败原样带上要返回的 error 回执。 */
type ProjectBranchOutcome =
  | { readonly ok: true; readonly headline: string }
  | { readonly ok: false; readonly result: CodingInitResult }

/**
 * 执行项目级分支，返回回执首行（主操作说明）；本次要写的正文 push 进 `pending`。
 *
 * 三个分支对根文档的处置互不相同：生成分支整体覆盖（标题行 + 模型章节 + 插件「模块索引」，
 * 不含模型未返回的模板章节）；跳过分支默认不动根文档，唯一的例外是本次新建了模块文档时
 * 回写「模块索引」；更新分支只让模型改受影响的章节，其余章节由 `applyModelSections` 逐字保留。
 */
async function runProjectBranch(input: ProjectBranchInput): Promise<ProjectBranchOutcome> {
  const {
    branch,
    flags,
    facts,
    rootDoc,
    moduleDocs,
    changed,
    localBaseline,
    createdModules,
    store,
    pending,
    notes,
    ask,
    copy,
  } = input

  if (branch === 'generate') {
    const draft = renderProjectDoc(facts, { modules: facts.modules, moduleDocs: [...moduleDocs] }).text
    const generated = await ask('project-create', draft, PROJECT_WRITABLE_SECTIONS, {})
    if (!generated.ok) {
      return { ok: false, result: modelFailureOf(copy, generated.reason, generated.action) }
    }
    // 生成不套模板：标题行 + 模型章节（模型顺序）+ 插件自己的「模块索引」表。
    const table = facts.modules.length === 0
      ? undefined
      : { title: MODULE_INDEX_TITLE, body: moduleIndexTable(facts.modules, [...moduleDocs]) }
    const composed = composeGeneratedDoc({
      preamble: [`# AGENTS.md — ${facts.name}`],
      modelText: generated.text,
      ...(table === undefined ? {} : { table }),
    })
    // 模型没有可用章节就失败：绝不回退成草稿，也不写任何文件。
    if (composed.applied.length === 0) {
      return {
        ok: false,
        result: modelFailureOf(copy, copy.noSectionsReason, copy.noSectionsAction),
      }
    }
    pending.push({ path: rootDoc, text: composed.text, route: generated.route })
    if (flags.update) notes.push(copy.missingRootNote(ROOT_DOC_NAME))
    return { ok: true, headline: copy.generatedHeadline(ROOT_DOC_NAME, generated.route) }
  }

  if (branch === 'skip') {
    // 根文档已存在且没带 -update：唯一允许的写入是「模块索引」的回写。
    if (flags.modules && createdModules.length > 0) {
      const previous = await store.read(rootDoc)
      const body = moduleIndexTable(facts.modules, [...moduleDocs])
      if (sectionBody(previous, MODULE_INDEX_TITLE) !== body) {
        const merged = mergeSections(previous, new Map([[MODULE_INDEX_TITLE, body]]))
        pending.push({ path: rootDoc, text: merged.text, route: '' })
        notes.push(copy.moduleIndexWritten)
      }
    }
    return { ok: true, headline: copy.skippedHeadline(ROOT_DOC_NAME) }
  }

  // 非 git 且没有任何晚于根文档的本地改动：直接回报无需更新，既不读也不写根文档。
  if (localBaseline && changed.files.length === 0) {
    notes.push(copy.unchangedHint(ROOT_DOC_NAME))
    return { ok: true, headline: copy.noUpdateHeadline(ROOT_DOC_NAME) }
  }

  // update：只让模型改受影响的章节，其余章节逐字保留（由 applyModelSections 保证）。
  const previous = await store.read(rootDoc)
  const previousModulePaths = modulePathsFromIndex(previous)
  const affected = affectedProjectSections(changed.files, facts.modules, previousModulePaths)
  // 本次新建的模块文档会改变「文档」列，所以强制回写「模块索引」。
  if (createdModules.length > 0) affected.add(MODULE_INDEX_TITLE)
  if (affected.size === 0) notes.push(copy.moduleOnlyNote)

  // 「模块索引」由插件表格生成：从模型白名单里剔掉，剔完为空就不调模型。
  const modelSections = [...affected].filter((title) => title !== MODULE_INDEX_TITLE)
  const rewriteIndex = affected.has(MODULE_INDEX_TITLE)

  let text = previous
  let route = ''
  const applied: string[] = []
  if (modelSections.length > 0) {
    // draft 是当前事实的模板草稿；现有文档经 existingDoc 传给模型，合并目标仍是 previous。
    const draft = renderProjectDoc(facts, { modules: facts.modules, moduleDocs: [...moduleDocs] }).text
    const generated = await ask('project-update', draft, modelSections, {
      existingDoc: previous,
      changedFiles: changed.files,
    })
    if (!generated.ok) {
      return { ok: false, result: modelFailureOf(copy, generated.reason, generated.action) }
    }
    const merged = applyModelSections(previous, generated.text, modelSections)
    text = merged.text
    applied.push(...merged.applied)
    route = generated.route
  }

  // 需要时在合并结果上再回写「模块索引」表格，并把它计入回执章节。
  let rewroteIndex = false
  if (rewriteIndex) {
    const body = moduleIndexTable(facts.modules, [...moduleDocs])
    if (sectionBody(text, MODULE_INDEX_TITLE) !== body) {
      text = mergeSections(text, new Map([[MODULE_INDEX_TITLE, body]])).text
      rewroteIndex = true
    }
  }

  if (applied.length === 0 && !rewroteIndex) {
    notes.push(copy.noSectionsToUpdateNote)
    return { ok: true, headline: copy.noUpdateHeadline(ROOT_DOC_NAME) }
  }

  pending.push({ path: rootDoc, text, route })
  const sections = rewroteIndex ? [...applied, MODULE_INDEX_TITLE] : applied
  return { ok: true, headline: copy.updatedHeadline(ROOT_DOC_NAME, sections, route) }
}

/** 模型失败的统一回执：此时 pending 还没提交，一个文件都不会写。 */
function modelFailureOf(copy: InitText, reason: string, action: string): CodingInitResult {
  return { kind: 'error', text: copy.modelFailed(reason, action) }
}

/**
 * 工作区根目录：`agent.session.header.cwd` 是非空字符串就用它，否则用当前工作目录。
 * 对外导出：后续异步提交器要用同一套根目录解析。
 */
export function workspaceOf(payload: CodingInitPayload): string {
  const cwd = payload.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd !== '') return cwd
  return process.cwd()
}

/**
 * 确定本次运行的变更来源，并把基线说明追加进 `notes`。
 *
 * git 可用时原样使用 `getChangedFiles` 的结果（基线写 `tag:…` / `recent:…`）；git 不可用
 * （典型是非 git 仓库）不报错：读根文档的 mtime 当基线，扫描其后修改过的本地文件，得到
 * `baseline: 'local-mtime'` 的结果并说明未使用 diff。只有连 mtime 都读不到才返回 error
 * 回执 —— 那时一个文件都还没写过。
 */
async function resolveChangeSource(
  deps: ResolvedDeps,
  store: DocStore,
  root: string,
  rootDoc: string,
  notes: string[],
  copy: InitText,
): Promise<ChangeSourceOutcome> {
  const git = await deps.getChangedFiles(root)
  if (git.ok) {
    const baseline = git.baseline
    if (typeof baseline === 'string' && baseline !== '') notes.push(copy.baselineNote(baseline))
    return { ok: true, source: { changed: git, localBaseline: false } }
  }

  let baselineMs: number
  try {
    baselineMs = await store.mtime(rootDoc)
  } catch (error) {
    return {
      ok: false,
      result: {
        kind: 'error',
        text: copy.statFailed(messageOf(error), ROOT_DOC_NAME),
      },
    }
  }

  const local = await deps.modifiedSince(root, baselineMs)
  const files = [...local.files]
  notes.push(copy.nonGitNote(ROOT_DOC_NAME, files.length))
  // 扫描被截断时明说：只比对了前 files.length 个文件，剩下的没有被检查。
  if (local.truncated === true) {
    notes.push(copy.truncatedNote(files.length))
  }
  return { ok: true, source: { changed: { ok: true, files, baseline: LOCAL_BASELINE }, localBaseline: true } }
}

/**
 * 构造文档读写器：有 fs 服务就走服务，缺失时回退 `node:fs/promises`。
 *
 * 有服务时 `stat` 的 `undefined` 表示文件不存在（用 `createIfAbsent` 新建），存在且是普通
 * 文件才用 `replaceIfVersion` 带版本覆盖；存在但不是普通文件直接报错，不尝试写。`context`
 * 里的 `cwd` 与沙箱策略一并交给服务：`resolve` 只把 cwd 当策略判定依据，`writeText` 的
 * 第 5 个参数就是本会话的策略。
 */
function createDocStore(
  deps: ResolvedDeps,
  agent: unknown,
  context: DocStoreContext,
  copy: InitText,
): DocStore {
  const mtime = async (path: string): Promise<number> => (await deps.statFile(path)).mtimeMs
  const service = resolveFileSystem(deps, agent)
  return service === undefined
    ? nodeDocStore(deps, mtime)
    : serviceDocStore(service, mtime, context, copy)
}

/** 取 fs 服务；解析器本身抛错时按“没有服务”处理，继续走 node 回退。 */
function resolveFileSystem(deps: ResolvedDeps, agent: unknown): CodingInitFileSystem | undefined {
  if (deps.resolveFs === undefined) return undefined
  try {
    // 解析器来自宿主，运行期可能返回 null（JS 调用方），这里一并当作“没有服务”。
    const service: CodingInitFileSystem | null | undefined = deps.resolveFs(agent)
    return service === undefined || service === null ? undefined : service
  } catch {
    return undefined
  }
}

/** 基于 fs 服务的 DocStore：resolve → stat → readText / writeText（带版本守卫）。 */
function serviceDocStore(
  fs: CodingInitFileSystem,
  mtime: (path: string) => Promise<number>,
  context: DocStoreContext,
  copy: InitText,
): DocStore {
  return {
    async exists(path: string): Promise<boolean> {
      const target = await fs.resolve(path, { cwd: context.cwd })
      return (await fs.stat(target)) !== undefined
    },
    async read(path: string): Promise<string> {
      return await fs.readText(await fs.resolve(path, { cwd: context.cwd }))
    },
    async write(path: string, content: string): Promise<void> {
      const target = await fs.resolve(path, { cwd: context.cwd })
      const info = await fs.stat(target)
      if (info !== undefined && info.type !== 'file') {
        throw new Error(`not a regular file: ${path}`)
      }
      try {
        if (info === undefined) {
          await fs.writeText(target, content, { kind: 'createIfAbsent' }, undefined, context.policy)
          return
        }
        await fs.writeText(
          target,
          content,
          { kind: 'replaceIfVersion', version: info.version },
          undefined,
          context.policy,
        )
      } catch (error) {
        // 生成期间文档被人改过：换成可读回执，绝不覆盖；其它错误原样上抛。
        if (errorCodeOf(error) === STALE_VERSION_CODE) throw new Error(copy.staleVersion)
        throw error
      }
    },
    mtime,
  }
}

/** 基于 `node:fs/promises` 的 DocStore：没有 fs 服务时的回退，行为与旧实现一致。 */
function nodeDocStore(deps: ResolvedDeps, mtime: (path: string) => Promise<number>): DocStore {
  return {
    async exists(path: string): Promise<boolean> {
      try {
        await deps.access(path)
        return true
      } catch {
        return false
      }
    },
    async read(path: string): Promise<string> {
      return await deps.readFile(path, 'utf8')
    },
    async write(path: string, content: string): Promise<void> {
      await deps.writeFile(path, content, 'utf8')
    },
    mtime,
  }
}

/** 取 agent 上的 ctx（agent 作用域看到的服务比插件作用域更全）；拿不到就是 `undefined`。 */
export function agentScopeOf(agent: unknown): any {
  if (typeof agent !== 'object' || agent === null) return undefined
  return Reflect.get(agent, 'ctx')
}

/**
 * 依次在 agent 作用域与插件作用域里找一个宿主服务（与 `memory.ts` 的 `serviceOf` 同义）。
 * @param primary - 优先作用域（通常是 `agent?.ctx`）。
 * @param fallback - 兜底作用域（插件 ctx）。
 * @param name - 服务名。
 * @returns 找到的服务，或 undefined。
 */
export function serviceOf(primary: any, fallback: any, name: string): any {
  for (const scope of [primary, fallback]) {
    if (scope === undefined || scope === null) continue
    try {
      const service = scope.get?.(name) ?? scope[name]
      if (service !== undefined) return service
    } catch {
      // 这个作用域读不到，换下一个。
    }
  }
  return undefined
}

/**
 * 解析沙箱策略。沙箱是可选服务：没有它的宿主照常写盘，解析失败一律当作「没有策略」。
 * @param primary - 优先作用域（通常是 agent?.ctx）。
 * @param fallback - 兜底作用域（插件 ctx）。
 * @param agent - 触发写入的 lead agent。
 * @returns 策略值，或 undefined。
 */
export async function sandboxPolicyOf(primary: any, fallback: any, agent: any): Promise<unknown> {
  const service = serviceOf(primary, fallback, 'sandboxPolicy')
  if (typeof service?.resolve !== 'function') return undefined
  try {
    return await service.resolve(agent === undefined ? {} : { session: agent?.session })
  } catch {
    return undefined
  }
}

/** 读取 errno 风格的 `code`；没有就返回空串。 */
function errorCodeOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) return ''
  const code: unknown = Reflect.get(error, 'code')
  return typeof code === 'string' ? code : ''
}

/** 把任意抛出物转成一行可读消息。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
