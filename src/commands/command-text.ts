/**
 * `/coding` 命令的提示与回执文案：按会话语言（{@link PromptLanguage}）给出
 * 命令描述、input hint、以及每一条回执的措辞；同一模块还带 `/coding init`
 * 的回执、后台通知与文档前置行（{@link InitText}）。
 *
 * 只本地化「用户看得到的命令输出」：英文文案是既有回执的逐字文本（既有测试断言它们），
 * 中文为翻译；模型面向的契约不走这张表——`contract.ts`、`stageContext`、
 * `controlMessage` 注入正文（阶段/模式切换、archived handoff）保持英文。
 *
 * 本模块是纯函数表：无 I/O、无宿主依赖、不读时钟与环境，Host 与测试都可以直接导入。
 *
 * @module dsh-coding/commands/command-text
 */

import type { PromptLanguage } from '../language/language.js'

/** 一门语言的 `/coding` 文案集合；函数只做纯字符串拼接。 */
export interface CommandText {
  /** /coding 命令描述（注册时按语言取一次）。 */
  readonly description: string
  /** /coding 的 input hint；两种语言相同（纯语法）。 */
  readonly hint: string
  /** 本会话没有运行 dsh-coding 预设。 */
  readonly notCodingSession: string
  /** 状态回执的「阶段路径」标签。 */
  readonly stagesLabel: string
  /** 命令异常且读不到状态机时的处理办法。 */
  readonly noStateAction: string
  /** /coding reset 回执。 */
  reset(status: string): string
  /** /coding memory 写入收据。 */
  memoryWritten(path: string, sessionId: string): string
  /** /coding memory open 读取收据。 */
  memoryLoaded(path: string): string
  /** 未知阶段。 */
  unknownStage(target: string, stages: string): string
  /** 未知模式。 */
  unknownMode(target: string, modes: string): string
  /** 阶段设置成功。 */
  stageSet(stage: string, status: string): string
  /** 模式设置成功。 */
  modeSet(mode: string, status: string): string
  /** /coding stage 被门禁拒绝（reason 原文不翻译）。 */
  stageRefused(reason: string): string
  /** 命令异常：reason — action。 */
  commandFailed(reason: string, action: string): string
  /** memory：宿主没有 fs 服务。 */
  readonly memoryMissingFs: string
  readonly memoryMissingFsAction: string
  /** memory：会话没有 cwd。 */
  readonly memoryMissingCwd: string
  readonly memoryMissingCwdAction: string
  /** memory：目录里没有合格文档。 */
  readonly memoryEmptyArchive: string
  readonly memoryEmptyArchiveAction: string
  /** memory：没有匹配关键词的文档。 */
  memoryNoMatch(keyword: string): string
  /** memory：写盘失败的处理办法。 */
  readonly memoryWriteFailedAction: string
  /** memory：读盘失败的处理办法。 */
  readonly memoryReadFailedAction: string
  /** memory open：宿主没有 fs 服务时的处理办法。 */
  readonly memoryMissingFsReadAction: string
  /** memory open：会话没有 cwd 时的处理办法。 */
  readonly memoryMissingCwdReadAction: string
}

/** input hint 只描述语法，两种语言共用一行。 */
const HINT = 'auto | consult | review | codex | set <auto|consult|review|codex>'
  + ' | stage <requirements|plan|implement|verify|deliver> | reset | memory'
  + ' | memory open [keyword] | init [-update] [-modules]'

/** 按语言索引的文案表。 */
const TABLE: Record<PromptLanguage, CommandText> = {
  zh: {
    description: '查看或设置本会话的 Coding 模式或阶段：/coding <auto|consult|review|codex>、'
      + '/coding set <模式>（静默，不启动新一轮）、/coding stage <阶段>。'
      + '/coding memory 把本轮交接文档写到项目根 .agents/memory；'
      + '/coding memory open [关键词] 从 .agents/memory 载入最新一篇交接文档'
      + '（可按文件名关键词过滤）到本会话。'
      + '/coding init [-update] [-modules] 用本会话当前模型生成或更新项目级、模块级 AGENTS.md。'
      + '/coding init 在后台执行，完成后回报结果。',
    hint: HINT,
    notCodingSession: '本会话没有运行 dsh-coding 预设。',
    stagesLabel: '阶段路径',
    noStateAction: '按错误信息处理，然后重试命令。',
    reset: status => `验证重试预算已重置；${status}`,
    memoryWritten: (path, sessionId) => `交接文档已写出：${path}（会话 ${sessionId}）`,
    memoryLoaded: path => `已载入交接文档：${path}`,
    unknownStage: (target, stages) => `未知阶段 "${target}"；可用值：${stages}`,
    unknownMode: (target, modes) => `未知模式 "${target}"；可用值：${modes}`,
    stageSet: (stage, status) => `阶段已设为 ${stage}；${status}`,
    modeSet: (mode, status) => `模式已设为 ${mode}；${status}`,
    stageRefused: reason => `阶段请求被拒绝：${reason}`,
    commandFailed: (reason, action) => `${reason} — ${action}`,
    memoryMissingFs: '当前宿主没有提供 fs 服务',
    memoryMissingFsAction: '把 Coding 预设挂到提供文件系统服务的 DSH 宿主上，再重试 /coding memory',
    memoryMissingCwd: '本会话没有工作目录',
    memoryMissingCwdAction: '为本会话设置工作目录，再重试 /coding memory',
    memoryEmptyArchive: '`.agents/memory` 下还没有交接文档',
    memoryEmptyArchiveAction: '先用 /coding memory 写一篇，或去掉关键词重试 /coding memory open',
    memoryNoMatch: keyword => `没有匹配 "${keyword}" 的交接文档`,
    memoryWriteFailedAction: '修复报告的文件系统问题，再重试 /coding memory',
    memoryReadFailedAction: '修复报告的文件系统问题，再重试 /coding memory open',
    memoryMissingFsReadAction: '把 Coding 预设挂到提供文件系统服务的 DSH 宿主上，再重试 /coding memory open',
    memoryMissingCwdReadAction: '为本会话设置工作目录，再重试 /coding memory open',
  },
  en: {
    description: 'Show or set this session\'s Coding mode or stage: /coding <auto|consult|review|codex>, '
      + '/coding set <mode> (silent, no Turn), or /coding stage <name>. '
      + '/coding memory writes a handoff document for this turn under .agents/memory at the project root; '
      + '/coding memory open [keyword] loads the newest archived handoff document '
      + '(optionally filtered by a filename keyword) from .agents/memory into this session. '
      + '/coding init [-update] [-modules] generates or updates the project or module AGENTS.md '
      + 'with this session\'s current model. '
      + '/coding init runs in the background and reports its result when finished.',
    hint: HINT,
    notCodingSession: 'this session is not running the dsh-coding preset',
    stagesLabel: 'stages',
    noStateAction: 'Fix the reported error, then retry the command.',
    reset: status => `verification retry budget reset; ${status}`,
    memoryWritten: (path, sessionId) => `handoff document written: ${path} (session ${sessionId})`,
    memoryLoaded: path => `handoff document loaded: ${path}`,
    unknownStage: (target, stages) => `unknown stage "${target}"; use ${stages}`,
    unknownMode: (target, modes) => `unknown mode "${target}"; use ${modes}`,
    stageSet: (stage, status) => `stage set to ${stage}; ${status}`,
    modeSet: (mode, status) => `mode set to ${mode}; ${status}`,
    stageRefused: reason => reason,
    commandFailed: (reason, action) => `${reason} — ${action}`,
    memoryMissingFs: 'this Host does not expose the fs service',
    memoryMissingFsAction: 'keep the Coding preset mounted in a DSH host that provides the filesystem service, '
      + 'then retry /coding memory',
    memoryMissingCwd: 'the session has no working directory',
    memoryMissingCwdAction: 'set a working directory for this session, then retry /coding memory',
    memoryEmptyArchive: 'no handoff document under .agents/memory',
    memoryEmptyArchiveAction: 'write one with /coding memory first, '
      + 'or retry /coding memory open without a keyword',
    memoryNoMatch: keyword => `no handoff document matches "${keyword}"`,
    memoryWriteFailedAction: 'fix the reported filesystem problem, then retry /coding memory',
    memoryReadFailedAction: 'fix the reported filesystem problem, then retry /coding memory open',
    memoryMissingFsReadAction: 'keep the Coding preset mounted in a DSH host that provides the filesystem '
      + 'service, then retry /coding memory open',
    memoryMissingCwdReadAction: 'set a working directory for this session, then retry /coding memory open',
  },
}

/**
 * 取一门语言的 `/coding` 文案表。
 * @param language - 会话语言。
 * @returns 该语言的文案集合（未知输入按英文兜底）。
 */
export function commandText(language: PromptLanguage): CommandText {
  return language === 'zh' ? TABLE.zh : TABLE.en
}

/**
 * 一门语言的 `/coding init` 文案集合。
 *
 * 只覆盖插件自己说的话：模型返回的 reason / action 与 fs 抛错原文一律原样拼接，
 * 不在这里翻译。带参数的条目都是纯字符串拼接，`paths` / `sections` 的连接符也在
 * 模板内部处理（中文 `、`，英文 `, `）。
 */
export interface InitText {
  /** 空项目：没有源码文件。 */
  readonly emptyProject: string
  /** 文件在生成期间被改动（FS_STALE_VERSION）。 */
  readonly staleVersion: string
  /** 没有注入模型调用。 */
  readonly noGeneratorReason: string
  readonly noGeneratorAction: string
  /** 模型没有返回可用章节。 */
  readonly noSectionsReason: string
  readonly noSectionsAction: string
  /** 命令捕获异常。 */
  runFailed(error: string): string
  /** 模型生成失败回执。 */
  modelFailed(reason: string, action: string): string
  /** 分批调用模型时，失败原因前面的「第 N/M 批」。 */
  batchPrefix(index: number, total: number, reason: string): string
  /** 读不到根文档 mtime。 */
  statFailed(error: string, rootDoc: string): string
  /** 后台任务已在跑。 */
  readonly inFlight: string
  /** 后台通知的一行摘要。 */
  readonly noticeSummary: string
  /** 后台通知的固定尾巴。 */
  readonly noticeFooter: string
  /** 后台完成/失败通知（尾巴由调用方追加 {@link InitText.noticeFooter}）。 */
  notice(prefix: 'done' | 'failed', text: string): string
  /** 已开始文档生成（后台执行）。 */
  started(route: string): string
  /** 宿主忙时追加的说明。 */
  readonly detached: string
  /** 模块索引章节标题（回执用；文档结构仍用 `MODULE_INDEX_TITLE`）。 */
  readonly moduleIndex: string
  /** 模块文档首行指回项目级文档。 */
  parentLink(link: string): string
  /** 带了 -modules 但项目里没有模块。 */
  readonly noModulesNote: string
  /** 根文档已存在且没带 -update。 */
  skippedHeadline(rootDoc: string): string
  /** 建议为缺文档的模块创建文档。 */
  moduleAdvice(modules: readonly string[]): string
  /** 本次写入了多少篇文档。 */
  writtenCount(count: number): string
  /** 没有任何晚于根文档的本地改动。 */
  unchangedHint(rootDoc: string): string
  generatedHeadline(rootDoc: string, route: string): string
  noUpdateHeadline(rootDoc: string): string
  /** 只有模块文档变化时，单独说明项目级文档没变。 */
  projectUnchangedNote(rootDoc: string): string
  updatedHeadline(rootDoc: string, sections: readonly string[], route: string): string
  /** 只有模块内变更。 */
  readonly moduleOnlyNote: string
  /** 没有需要更新的项目级章节。 */
  readonly noSectionsToUpdateNote: string
  /** 回写了模块索引。 */
  readonly moduleIndexWritten: string
  /** 带 -update 但根文档不存在，按生成处理。 */
  missingRootNote(rootDoc: string): string
  /** 本次使用的变更基线。 */
  baselineNote(baseline: string): string
  /** 非 git 仓库按 mtime 比对。 */
  nonGitNote(rootDoc: string, files: number): string
  /** 本地改动超过扫描上限。 */
  truncatedNote(count: number): string
  /** 模块回执行：同一路由只写一次，路由不同就逐条列出。 */
  moduleSummary(
    label: 'created' | 'updated',
    paths: readonly string[],
    routes: ReadonlyMap<string, string>,
  ): string
  /** 模块回执行里的单个模块（带模型路由）。 */
  modulePathNote(path: string, route: string): string
}

/** 中文模块索引章节名；`moduleIndexWritten` 与 `moduleIndex` 共用，避免两处漂移。 */
const ZH_MODULE_INDEX = '模块索引'

/** `/coding init` 的中英文案表。 */
const INIT_TABLE: Record<PromptLanguage, InitText> = {
  zh: {
    emptyProject: '未检测到代码文件，已跳过：/coding init 需要项目里至少有一个源码文件。',
    staleVersion: '文件在本次生成期间被修改（FS_STALE_VERSION），未覆盖；请重试 /coding init -update。',
    noGeneratorReason: '本命令没有接入模型服务（generate 未注入）',
    noGeneratorAction: '通过 /coding init 运行，或检查宿主接线。',
    noSectionsReason: '模型没有返回可用的 Markdown 章节',
    noSectionsAction: '重试 /coding init；插件不会用模板兜底。',
    runFailed: error => `命令失败：${error}`,
    modelFailed: (reason, action) => `模型生成失败：${reason} — ${action}`,
    batchPrefix: (index, total, reason) => `第 ${index}/${total} 批：${reason}`,
    statFailed: (error, rootDoc) =>
      `无法读取 ${rootDoc} 的修改时间（${error}），未修改任何文件；`
      + `请修复文件系统后重试，或删除 ${rootDoc} 重新生成。`,
    inFlight: '已有一个文档生成任务在运行；完成或失败后会在这里反馈，请稍后再试。',
    noticeSummary: '文档生成回执',
    noticeFooter: '\n\n（这是运行时回执，无需调用工具，也不要改动任何文件。）',
    notice: (prefix, text) => `${prefix === 'done' ? '文档生成完成' : '文档生成失败'}：${text}`,
    started: route => `已开始文档生成（后台执行；模型 ${route}）。完成或失败后会在会话里反馈。`,
    detached: '宿主正忙，已改用独立后台任务。',
    moduleIndex: ZH_MODULE_INDEX,
    parentLink: link =>
      `> 上级：[项目级 AGENTS.md](${link})（全局规则、构建命令、协作流程以此为准，本文不重复）`,
    noModulesNote: '未检测到模块，只处理项目级文档。',
    skippedHeadline: rootDoc =>
      `${rootDoc} 已存在，已跳过。如需更新请用 /coding init -update。`,
    moduleAdvice: modules =>
      `建议为以下模块创建文档（用 /coding init -modules）：${modules.join('、')}。`,
    writtenCount: count => `共写入 ${count} 篇文档。`,
    unchangedHint: rootDoc => `未发现晚于 ${rootDoc} 的本地改动。`,
    generatedHeadline: (rootDoc, route) => `已生成 ${rootDoc}（模型 ${route}）。`,
    noUpdateHeadline: rootDoc => `${rootDoc} 无需更新。`,
    projectUnchangedNote: rootDoc => `项目级 ${rootDoc} 无需更新。`,
    updatedHeadline: (rootDoc, sections, route) =>
      `已更新 ${rootDoc}（章节：${sections.join('、')}${route === '' ? '' : `；模型 ${route}`}）。`,
    moduleOnlyNote: '只有模块内变更，项目级文档未修改。',
    noSectionsToUpdateNote: '没有需要更新的项目级章节。',
    moduleIndexWritten: `已回写「${ZH_MODULE_INDEX}」。`,
    missingRootNote: rootDoc => `未找到 ${rootDoc}，已按生成处理。`,
    baselineNote: baseline => `变更基线：${baseline}。`,
    nonGitNote: (rootDoc, files) =>
      `非 git 仓库：未使用 diff，按 ${rootDoc} 的修改时间比对出 ${files} 个变更文件。`,
    truncatedNote: count => `本地改动超过扫描上限，已截断：仅比对前 ${count} 个文件。`,
    moduleSummary: (label, paths, routes) => {
      const head = label === 'created' ? '已生成模块文档' : '已更新模块文档'
      const values = [...new Set(paths.map(path => routes.get(path) ?? ''))]
      const listed = values.length === 1
        ? (values[0] === '' ? paths.join('、') : `${paths.join('、')}（模型 ${values[0]}）`)
        : paths.map((path) => {
          const route = routes.get(path) ?? ''
          return route === '' ? path : `${path}（模型 ${route}）`
        }).join('、')
      return `${head}：${listed}。`
    },
    modulePathNote: (path, route) => (route === '' ? path : `${path}（模型 ${route}）`),
  },
  en: {
    emptyProject:
      'No source files detected; skipped: /coding init needs at least one source file in the project.',
    staleVersion:
      'A file changed during this run (FS_STALE_VERSION); nothing was overwritten. Retry /coding init -update.',
    noGeneratorReason: 'this command is not wired to a model service (generate was not injected)',
    noGeneratorAction: 'Run it through /coding init, or check the host wiring.',
    noSectionsReason: 'the model did not return any usable Markdown sections',
    noSectionsAction: 'Retry /coding init; the plugin will not fall back to a template.',
    runFailed: error => `Command failed: ${error}`,
    modelFailed: (reason, action) => `Model generation failed: ${reason} — ${action}`,
    batchPrefix: (index, total, reason) => `batch ${index}/${total}: ${reason}`,
    statFailed: (error, rootDoc) =>
      `Could not read the modification time of ${rootDoc} (${error}); nothing was modified. `
      + `Fix the filesystem and retry, or delete ${rootDoc} and generate it again.`,
    inFlight: 'A document-generation task is already running; its result will be reported here. '
      + 'Try again later.',
    noticeSummary: 'Document generation report',
    noticeFooter: '\n\n(Runtime report only — no tool call is needed and no file should be changed.)',
    notice: (prefix, text) => `${prefix === 'done'
      ? 'Document generation completed'
      : 'Document generation failed'}: ${text}`,
    started: route => `Background document generation started (model ${route}). `
      + 'The result will be reported here when it finishes.',
    detached: 'The host was busy, so this runs as a detached background task.',
    moduleIndex: 'Module index',
    parentLink: link => `> Parent: [project AGENTS.md](${link})`
      + ' (global rules, build commands, and workflow there take precedence; '
      + 'this document does not repeat them)',
    noModulesNote: 'No modules detected; only the project document is handled.',
    skippedHeadline: rootDoc =>
      `${rootDoc} already exists; skipped. Use /coding init -update to update it.`,
    moduleAdvice: modules =>
      `Consider writing docs for these modules (use /coding init -modules): ${modules.join(', ')}.`,
    writtenCount: count => `Wrote ${count} documents.`,
    unchangedHint: rootDoc => `No local changes newer than ${rootDoc} were found.`,
    generatedHeadline: (rootDoc, route) => `Generated ${rootDoc} (model ${route}).`,
    noUpdateHeadline: rootDoc => `${rootDoc} needs no update.`,
    projectUnchangedNote: rootDoc => `The project-level ${rootDoc} needs no update.`,
    updatedHeadline: (rootDoc, sections, route) =>
      `Updated ${rootDoc} (sections: ${sections.join(', ')}`
      + `${route === '' ? '' : `; model ${route}`}).`,
    moduleOnlyNote: 'Only module-level changes were found; the project document was not modified.',
    noSectionsToUpdateNote: 'No project-level sections need updating.',
    moduleIndexWritten: 'Rewrote the "Module index" section.',
    missingRootNote: rootDoc => `${rootDoc} was not found; treated as a fresh generation.`,
    baselineNote: baseline => `Change baseline: ${baseline}.`,
    nonGitNote: (rootDoc, files) =>
      `Not a git repository: no diff was used; found ${files} changed files by comparing `
      + `against the modification time of ${rootDoc}.`,
    truncatedNote: count =>
      `Local changes exceed the scan limit and were truncated: only the first ${count} files `
      + 'were compared.',
    moduleSummary: (label, paths, routes) => {
      const head = label === 'created' ? 'Created module docs' : 'Updated module docs'
      const values = [...new Set(paths.map(path => routes.get(path) ?? ''))]
      const listed = values.length === 1
        ? (values[0] === '' ? paths.join(', ') : `${paths.join(', ')} (model ${values[0]})`)
        : paths.map((path) => {
          const route = routes.get(path) ?? ''
          return route === '' ? path : `${path} (model ${route})`
        }).join(', ')
      return `${head}: ${listed}.`
    },
    modulePathNote: (path, route) => (route === '' ? path : `${path} (model ${route})`),
  },
}

/**
 * 取一门语言的 `/coding init` 文案表。
 * @param language - 会话语言。
 * @returns 该语言的文案集合（未知输入按英文兜底）。
 */
export function initText(language: PromptLanguage): InitText {
  return language === 'zh' ? INIT_TABLE.zh : INIT_TABLE.en
}
