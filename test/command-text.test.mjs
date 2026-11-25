/**
 * `/coding` 文案表测试：中英两套字段一一对应、关键回执逐字一致，以及英文文案不含中文。
 *
 * 文案表是纯函数模块，直接导入构建产物断言，不挂宿主、不碰 I/O。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commandText, initText } from '../lib/commands/command-text.js'

/** 只描述语法的 hint，两种语言必须完全一致。 */
const HINT = 'auto | consult | review | codex | set <auto|consult|review|codex>'
  + ' | stage <requirements|plan|implement|verify|deliver> | reset | memory'
  + ' | memory open [keyword] | init [-update] [-modules]'

/** 固定字符串字段：每个都应非空，且英文里不能出现中文。 */
const FIXED_FIELDS = [
  'description',
  'hint',
  'notCodingSession',
  'stagesLabel',
  'noStateAction',
  'memoryMissingFs',
  'memoryMissingFsAction',
  'memoryMissingCwd',
  'memoryMissingCwdAction',
  'memoryEmptyArchive',
  'memoryEmptyArchiveAction',
  'memoryWriteFailedAction',
  'memoryReadFailedAction',
  'memoryMissingFsReadAction',
  'memoryMissingCwdReadAction',
]

/** 用一组固定样例参数把每条回执都调一遍，供逐条检查。 */
function calls(copy) {
  return {
    reset: copy.reset('S'),
    memoryWritten: copy.memoryWritten('D:/p/x.md', 's1'),
    memoryLoaded: copy.memoryLoaded('D:/p/x.md'),
    unknownStage: copy.unknownStage('x', 'a, b'),
    unknownMode: copy.unknownMode('x', 'a, b'),
    stageSet: copy.stageSet('plan', 'S'),
    modeSet: copy.modeSet('codex', 'S'),
    stageRefused: copy.stageRefused('gate says no'),
    commandFailed: copy.commandFailed('r', 'a'),
    memoryNoMatch: copy.memoryNoMatch('logo'),
  }
}

const CJK = /[\u4e00-\u9fff]/u

test('英文描述与 input hint 保持既有文案', () => {
  const en = commandText('en')
  assert.ok(en.description.startsWith("Show or set this session's Coding mode or stage:"))
  assert.ok(en.description.includes('/coding memory open [keyword]'))
  assert.equal(en.hint, HINT)
})

test('中文描述与 input hint 是给定翻译', () => {
  const zh = commandText('zh')
  assert.ok(zh.description.includes('查看或设置'))
  assert.ok(zh.description.includes('交接文档'))
  assert.equal(zh.hint, HINT)
})

test('关键词回执中英逐字一致', () => {
  const en = commandText('en')
  const zh = commandText('zh')
  assert.equal(en.unknownStage('x', 'a, b'), 'unknown stage "x"; use a, b')
  assert.equal(zh.unknownStage('x', 'a, b'), '未知阶段 "x"；可用值：a, b')
  assert.equal(en.unknownMode('x', 'a, b'), 'unknown mode "x"; use a, b')
  assert.equal(zh.unknownMode('x', 'a, b'), '未知模式 "x"；可用值：a, b')
  assert.equal(en.stageSet('plan', 'S'), 'stage set to plan; S')
  assert.equal(zh.stageSet('plan', 'S'), '阶段已设为 plan；S')
  assert.equal(en.modeSet('codex', 'S'), 'mode set to codex; S')
  assert.equal(zh.modeSet('codex', 'S'), '模式已设为 codex；S')
  assert.equal(en.reset('S'), 'verification retry budget reset; S')
  assert.equal(zh.reset('S'), '验证重试预算已重置；S')
  assert.equal(en.memoryWritten('D:/p/x.md', 's1'), 'handoff document written: D:/p/x.md (session s1)')
  assert.equal(zh.memoryWritten('D:/p/x.md', 's1'), '交接文档已写出：D:/p/x.md（会话 s1）')
  assert.equal(en.memoryLoaded('D:/p/x.md'), 'handoff document loaded: D:/p/x.md')
  assert.equal(zh.memoryLoaded('D:/p/x.md'), '已载入交接文档：D:/p/x.md')
  assert.equal(en.stageRefused('gate says no'), 'gate says no')
  assert.ok(zh.stageRefused('gate says no').startsWith('阶段请求被拒绝：'))
  assert.equal(en.commandFailed('r', 'a'), 'r — a')
  assert.equal(zh.commandFailed('r', 'a'), 'r — a')
})

test('memory 固定字段两语言非空且互不相同', () => {
  const six = [
    'memoryMissingFs',
    'memoryMissingFsAction',
    'memoryMissingCwd',
    'memoryMissingCwdAction',
    'memoryEmptyArchive',
    'memoryEmptyArchiveAction',
  ]
  for (const language of ['zh', 'en']) {
    const copy = commandText(language)
    const values = six.map(name => copy[name])
    values.forEach((value, index) => {
      assert.equal(typeof value, 'string')
      assert.ok(value.trim() !== '', `${language} ${six[index]} should not be empty`)
    })
    assert.equal(new Set(values).size, six.length, `${language} 的六个固定字段应互不相同`)
  }
})

test('memory 无匹配回执中英各自成形', () => {
  const en = commandText('en')
  const zh = commandText('zh')
  assert.equal(en.memoryNoMatch('logo'), 'no handoff document matches "logo"')
  assert.ok(zh.memoryNoMatch('logo').includes('logo'))
  assert.ok(zh.memoryNoMatch('logo').includes('交接文档'))
})

test('英文全部文案不含中文', () => {
  const en = commandText('en')
  for (const field of FIXED_FIELDS) {
    assert.equal(typeof en[field], 'string')
    assert.ok(!CJK.test(en[field]), `en.${field} 不应含中文`)
  }
  for (const [name, text] of Object.entries(calls(en))) {
    assert.equal(typeof text, 'string')
    assert.ok(!CJK.test(text), `en.${name}() 不应含中文`)
  }
})

test('中文关键回执含中文', () => {
  const zh = commandText('zh')
  for (const field of ['description', 'notCodingSession', 'stagesLabel']) {
    assert.ok(CJK.test(zh[field]), `zh.${field} 应为中文`)
  }
  for (const [name, text] of Object.entries(calls(zh))) {
    // commandFailed 两语言都只是 `reason — action`，不含固定中文；
    // stageRefused 的中文回执带固定前缀，reason 原文本身仍是英文。
    if (name === 'commandFailed') continue
    assert.ok(CJK.test(text), `zh.${name}() 应为中文`)
  }
})

/** `/coding init` 的固定字符串字段：每个都应非空，英文里不能出现中文。 */
const INIT_FIXED_FIELDS = [
  'emptyProject',
  'staleVersion',
  'noGeneratorReason',
  'noGeneratorAction',
  'noSectionsReason',
  'noSectionsAction',
  'inFlight',
  'noticeSummary',
  'noticeFooter',
  'detached',
  'moduleIndex',
  'noModulesNote',
  'moduleOnlyNote',
  'noSectionsToUpdateNote',
  'moduleIndexWritten',
]

/** 用一组固定样例参数把 `/coding init` 的每条回执都调一遍。 */
function initCalls(copy) {
  return {
    runFailed: copy.runFailed('E'),
    modelFailed: copy.modelFailed('r', 'a'),
    batchPrefix: copy.batchPrefix(1, 3, 'r'),
    statFailed: copy.statFailed('ENOENT', 'AGENTS.md'),
    noticeDone: copy.notice('done', 'x'),
    noticeFailed: copy.notice('failed', 'x'),
    started: copy.started('p/m'),
    parentLink: copy.parentLink('../../AGENTS.md'),
    skippedHeadline: copy.skippedHeadline('AGENTS.md'),
    moduleAdvice: copy.moduleAdvice(['src/a', 'src/b']),
    writtenCount: copy.writtenCount(2),
    unchangedHint: copy.unchangedHint('AGENTS.md'),
    generatedHeadline: copy.generatedHeadline('AGENTS.md', 'p/m'),
    noUpdateHeadline: copy.noUpdateHeadline('AGENTS.md'),
    projectUnchangedNote: copy.projectUnchangedNote('AGENTS.md'),
    updatedHeadline: copy.updatedHeadline('AGENTS.md', ['Overview', 'Quick start'], 'p/m'),
    updatedHeadlineNoModel: copy.updatedHeadline('AGENTS.md', ['Overview'], ''),
    missingRootNote: copy.missingRootNote('AGENTS.md'),
    baselineNote: copy.baselineNote('tag:v1'),
    nonGitNote: copy.nonGitNote('AGENTS.md', 3),
    truncatedNote: copy.truncatedNote(5),
    moduleSummaryCreated: copy.moduleSummary('created', ['src/a'], new Map([['src/a', 'p/m']])),
    moduleSummaryUpdated: copy.moduleSummary(
      'updated',
      ['src/a', 'src/b'],
      new Map([['src/a', 'p/m'], ['src/b', 'q/n']]),
    ),
    moduleSummaryNoRoute: copy.moduleSummary('created', ['src/a'], new Map()),
    modulePathNote: copy.modulePathNote('src/a', 'p/m'),
  }
}

test('init 空项目提示中英逐字一致', () => {
  assert.equal(
    initText('zh').emptyProject,
    '未检测到代码文件，已跳过：/coding init 需要项目里至少有一个源码文件。',
  )
  assert.equal(
    initText('en').emptyProject,
    'No source files detected; skipped: /coding init needs at least one source file in the project.',
  )
})

test('init 立即回执带模型路由', () => {
  const zh = initText('zh').started('p/m')
  assert.ok(zh.includes('已开始文档生成'), 'zh.started 应以「已开始文档生成」开头')
  assert.ok(zh.includes('p/m'), 'zh.started 应带模型路由')
  const en = initText('en').started('p/m')
  assert.ok(en.includes('Background document generation started'), 'en.started 应说明后台开始')
  assert.ok(en.includes('p/m'), 'en.started 应带模型路由')
})

test('init 后台通知的完成/失败前缀各自成形', () => {
  const zh = initText('zh')
  assert.ok(zh.notice('done', 'x').startsWith('文档生成完成'))
  assert.ok(zh.notice('failed', 'x').startsWith('文档生成失败'))
  const en = initText('en')
  assert.ok(en.notice('done', 'x').includes('completed'))
  assert.ok(en.notice('failed', 'x').includes('failed'))
})

test('init 英文全部文案不含中文', () => {
  const en = initText('en')
  for (const field of INIT_FIXED_FIELDS) {
    assert.equal(typeof en[field], 'string')
    assert.ok(!CJK.test(en[field]), `en.${field} 不应含中文`)
  }
  for (const [name, text] of Object.entries(initCalls(en))) {
    assert.equal(typeof text, 'string')
    assert.ok(!CJK.test(text), `en.${name}() 不应含中文`)
  }
})

test('init 中文关键回执含中文', () => {
  const zh = initText('zh')
  for (const field of ['emptyProject', 'staleVersion', 'inFlight', 'noticeSummary', 'moduleIndex']) {
    assert.ok(CJK.test(zh[field]), `zh.${field} 应为中文`)
  }
  for (const [name, text] of Object.entries(initCalls(zh))) {
    assert.ok(CJK.test(text), `zh.${name}() 应为中文`)
  }
})
