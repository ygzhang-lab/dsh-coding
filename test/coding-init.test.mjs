/**
 * `/coding init` 测试：参数解析与四分支、git 变更基线（tag / 最近时间窗口 / 工作区）、
 * 非 git 时按根文档 mtime 取本地变更的 fallback、fs 服务的 createIfAbsent / replaceIfVersion
 * 写入与版本过期回执、本地 mtime 扫描、项目扫描、文档渲染与防幻觉、章节合并保护、
 * 模块路径归属、命令四条分支与注册动作、有界源码枚举、文档提示词上下文组装与长度上限、
 * 模型直连调用的成功与失败路径（假 llm）、模型章节的占位符清洗 / 空章节裁剪 / 白名单合并、
 * 命令层的模型注入（空项目闸门、模块逐模块按批调用、项目级按章分批、两阶段写盘、
 * 任一批失败零写盘、未注入模型默认失败）。
 *
 * 本轮语义（断言按它写）：**生成不再套模板** —— 项目级文档 = 插件标题行 + 模型返回的 `##`
 * 章节（保留模型顺序）+ 末尾由插件回写的「模块索引」表，模型没返回的模板章节一律不补；
 * **写出的文档零占位符** —— 占位符整行删除、清空后的章节整节移除，回执也不再统计待补充数量；
 * **更新按新合并语义** —— 只替换允许集合里的已有标题，未受影响的章节逐字保留，骨架里没有的
 * 模型章节按模型顺序追加到末尾。
 *
 * 分批语义（断言按它写）：单篇文档不再一次调用写完 —— `planSectionBatches` 把本次允许撰写的
 * 章节按每批 4 章切开，逐批调用模型、每批 system 只列本批章节，各批正文按批次顺序用空行拼接
 * （项目级 12 章 → 3 批，模块级 10 章 → 3 批，`-update` 只按受影响章节批次数调用）；任一批失败
 * 立即整体失败且零写盘，回执 reason 以「第 N/M 批：」开头。
 *
 * 断言对象是构建产物（`lib/lib/*.js`、`lib/commands/*.js`），不是 `src/` 源码。
 * 所有涉及文件的用例只在 `mkdtemp` 出的临时目录里建 fixture，测试结束即递归删除；
 * git 一律注入 fake `GitRunner` 或 `getChangedFiles`，不调用真实 git，也不联网。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { GitError, getChangedFiles } from '../lib/lib/git.js'
import {
  detectPackageManager,
  getFilesModifiedSince,
  listSourceFiles,
  matchGlob,
  scanProject,
} from '../lib/lib/project-scan.js'
import {
  BATCH_MAX_SECTIONS,
  MAX_DOC_LINES,
  MODULE_SECTIONS,
  PROJECT_SECTIONS,
  PROJECT_WRITABLE_SECTIONS,
  TODO_PLACEHOLDER,
  affectedProjectSections,
  applyModelSections,
  composeGeneratedDoc,
  countTodoPlaceholders,
  isEmptyDocBody,
  matchModuleForFile,
  mergeSections,
  moduleIndexTable,
  modulePathsFromIndex,
  parentLinkFor,
  parseModelSections,
  planSectionBatches,
  pruneEmptySections,
  renderModuleDoc,
  renderProjectDoc,
  scrubPlaceholders,
  sectionBody,
  splitSections,
  truncateToMaxLines,
} from '../lib/lib/agents-doc.js'
import {
  DOC_CONTEXT_EXCERPT_CHARS,
  DOC_CONTEXT_TOTAL_LIMIT,
  DOC_CONTEXT_TRUNCATED_MARK,
  buildDocPrompt,
  excerptOf,
} from '../lib/lib/doc-context.js'
import { generateDoc } from '../lib/lib/doc-model.js'
import {
  branchFor,
  createCodingInitHandler,
  parseCodingInitArgs,
} from '../lib/commands/coding-init.js'

/** 建一个临时项目根目录，测试结束自动递归删除。 */
async function makeRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'coding-init-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  return root
}

/** 写入一个 UTF-8 文件（自动建父目录），返回绝对路径。 */
async function putFile(root, relPath, text) {
  const target = join(root, relPath)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, text, 'utf8')
  return target
}

/** 路径是否存在；与命令层一致：`access` 成功即存在。 */
async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** JSON 文件内容：稳定缩进 + 行尾换行。 */
function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

/**
 * 假 fs 服务：内容与版本只存在内存里，写入连 `expected` 守卫一起记账，真实磁盘不会被动过。
 *
 * `resolve` 用路径本身当句柄，`stat` 不存在时返回 `undefined`（命令层据此选
 * `createIfAbsent`），已存在时返回当前版本（命令层据此用 `replaceIfVersion`）。
 */
function createFakeFs(seed = new Map()) {
  const files = new Map()
  const writes = []
  let versionCounter = 0
  const nextVersion = () => {
    versionCounter += 1
    return `v${versionCounter}`
  }
  for (const [path, content] of seed) {
    files.set(path, { content, version: nextVersion() })
  }

  return {
    files,
    writes,
    resolve(path) {
      return { targetKey: path, displayPath: path }
    },
    async stat(target) {
      const record = files.get(target.targetKey)
      return record === undefined ? undefined : { version: record.version, type: 'file' }
    },
    async readText(target) {
      const record = files.get(target.targetKey)
      assert.ok(record !== undefined, `假 fs 里没有 ${String(target.targetKey)}，读之前应先写进 seed`)
      return record.content
    },
    async writeText(target, content, expected, _signal, policy) {
      const key = target.targetKey
      writes.push({ key, content, expected, policy })
      const version = nextVersion()
      files.set(key, { content, version })
      return { operation: 'update', version, before: null, after: content }
    },
  }
}

/** 假模型：把当前事实草稿原样返回；既保留模板断言，又证明写盘来自模型输出。 */
const fakeGenerate = async (request) => ({ ok: true, text: request.draft, route: 'fake/model' })

/** 带假模型的命令工厂；用例仍可覆盖其它依赖。 */
function handlerWith(deps = {}) {
  return createCodingInitHandler({ generate: fakeGenerate, ...deps })
}

/** 任务要求的 fixture：pnpm workspace，只有一个 packages/core 模块。 */
async function createFixture(root) {
  await putFile(
    root,
    'package.json',
    jsonText({
      name: 'demo',
      version: '0.1.0',
      scripts: { build: 'tsc', test: 'node --test', typecheck: 'tsc --noEmit' },
      workspaces: ['packages/*'],
    }),
  )
  await putFile(root, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n")
  await putFile(root, 'pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n")
  await putFile(
    root,
    'packages/core/package.json',
    jsonText({ name: '@demo/core', main: 'src/index.js', scripts: { test: 'node --test' } }),
  )
  await putFile(root, 'packages/core/src/index.ts', 'export const answer = 42\n')
  await putFile(root, 'README.md', '# Demo project\n\nA demo repository for tests.\n')
}

/** 在 fixture 上再挂一个 packages/utils 模块。 */
async function addUtilsModule(root) {
  await putFile(root, 'packages/utils/package.json', jsonText({ name: '@demo/utils' }))
  await putFile(root, 'packages/utils/src/index.ts', 'export const util = 1\n')
}

/** 最小模块对象：只保留归属与受影响章节判定用到的字段。 */
function minimalModule() {
  return {
    name: 'core',
    path: 'packages/core',
    kind: 'node',
    entries: [],
    dependencies: [],
    dependents: [],
  }
}

/** 1. 参数解析：只认 `-update` 与 `-modules`。 */
test('parseCodingInitArgs：只认 -update 与 -modules', () => {
  assert.deepEqual(parseCodingInitArgs(undefined), { update: false, modules: false }, '无参数时两个开关都为 false')
  assert.deepEqual(parseCodingInitArgs(''), { update: false, modules: false }, '空串视为无参数')
  assert.deepEqual(parseCodingInitArgs('-update'), { update: true, modules: false }, '-update 只打开 update')
  assert.deepEqual(parseCodingInitArgs('-modules'), { update: false, modules: true }, '-modules 只打开 modules')
  assert.deepEqual(
    parseCodingInitArgs('  -update   -modules '),
    { update: true, modules: true },
    '多余空白与顺序不影响解析',
  )
  assert.deepEqual(parseCodingInitArgs('--update'), { update: false, modules: false }, '--update 不是受支持参数')
  assert.deepEqual(parseCodingInitArgs('reset'), { update: false, modules: false }, '未知参数直接忽略')
})

/** 1. 四分支表：不存在就生成，存在但没 -update 就跳过。 */
test('branchFor：四分支硬编码', () => {
  assert.equal(branchFor(false, false), 'generate', '不存在且无 -update 应生成')
  assert.equal(branchFor(false, true), 'generate', '不存在但带 -update 应降级为生成')
  assert.equal(branchFor(true, false), 'skip', '存在且无 -update 应跳过')
  assert.equal(branchFor(true, true), 'update', '存在且带 -update 应增量更新')
})

/** 2. git 全部命令失败：收成结果对象，不抛错。 */
test('getChangedFiles：git 命令报错时返回空列表', async () => {
  const failingGit = async (root, args) => {
    throw new GitError(`git ${args[0]} exited with 1`, 'git-failed', args.join(' '), '')
  }

  const result = await getChangedFiles('/virtual/not-a-repo', { git: failingGit })

  assert.equal(result.ok, false, '全部命令失败应返回 ok:false')
  assert.deepEqual(result.files, [], '失败时文件列表为空')
})

/** 2. 按 args 分支返回固定输出：三条命令的结果合并去重排序。 */
test('getChangedFiles：合并 log / diff / ls-files 并去重排序', async () => {
  const fakeGit = async (root, args) => {
    const head = args[0]
    if (head === 'rev-parse') return 'true'
    if (head === 'log') return 'a.ts\nb/c.ts'
    if (head === 'diff') return 'a.ts'
    if (head === 'ls-files') return './b/c.ts\n'
    return ''
  }

  const result = await getChangedFiles('/virtual/repo', { git: fakeGit })

  assert.equal(result.ok, true, '在 git 仓库内应返回 ok:true')
  assert.deepEqual(result.files, ['a.ts', 'b/c.ts'], '路径应去掉 ./ 前缀、去重并按字典序排序')
})

/** 2. tag 基线：describe 拿到 tag 就用 `tag..HEAD` 比对，工作区为空时不改基线。 */
test('getChangedFiles：有 tag 时以 tag..HEAD 为基线', async () => {
  const calls = []
  const fakeGit = async (root, args) => {
    calls.push(args)
    if (args[0] === 'rev-parse') return 'true'
    if (args[0] === 'describe') return 'v1.2.3'
    if (args[0] === 'diff') return args[1] === '--name-only' && args[2] === 'v1.2.3..HEAD' ? 'a.ts' : ''
    return ''
  }

  const result = await getChangedFiles('/virtual/repo', { git: fakeGit })

  assert.equal(result.ok, true, '有 tag 的仓库应返回 ok:true')
  assert.ok(result.files.includes('a.ts'), 'tag..HEAD 里的文件应被收录')
  assert.equal(result.baseline, 'tag:v1.2.3', '基线应写成 tag:<tag>')
  assert.deepEqual(
    calls.find((args) => args[2] === 'v1.2.3..HEAD'),
    ['diff', '--name-only', 'v1.2.3..HEAD'],
    'tag 基线的 diff 参数应为 [diff --name-only <tag>..HEAD]',
  )
})

/** 2. 无 tag：回退到最近 7 天的提交时间窗口，baseline 以 `recent:` 开头。 */
test('getChangedFiles：没有 tag 时回退最近 7 天', async () => {
  const calls = []
  const fakeGit = async (root, args) => {
    calls.push(args)
    if (args[0] === 'rev-parse') return 'true'
    // 这里用致命错误模拟：工作区命令照常返回空串，走默认分支。
    if (args[0] === 'describe') {
      throw new GitError('no names found', 'git-failed', args.join(' '), 'fatal: no names found')
    }
    if (args[0] === 'log') return 'b.ts'
    return ''
  }

  const result = await getChangedFiles('/virtual/repo', { git: fakeGit })

  assert.equal(result.ok, true, '没有 tag 但 log 可用时应返回 ok:true')
  assert.ok(result.files.includes('b.ts'), '时间窗口内的文件应被收录')
  assert.ok(
    typeof result.baseline === 'string' && result.baseline.startsWith('recent:'),
    '基线应以 recent: 开头',
  )
  assert.equal(result.baseline, 'recent:7 days ago', '默认时间窗口是最近 7 天')
  assert.ok(
    calls.some((args) => args[0] === 'log' && args.includes('--since=7 days ago')),
    'log 应带上 --since=7 days ago',
  )
  assert.ok(
    !calls.some((args) => args[0] === 'diff' && typeof args[2] === 'string' && args[2].includes('..HEAD')),
    '没有 tag 时不应执行 tag..HEAD 的 diff',
  )
})

/** 2. 空仓库：describe / log / diff HEAD 全失败，只有 ls-files 能给出未跟踪文件。 */
test('getChangedFiles：空仓库只有未跟踪文件时基线为 worktree', async () => {
  const fakeGit = async (root, args) => {
    if (args[0] === 'rev-parse') return 'true'
    if (args[0] === 'ls-files') return 'new.md\n'
    throw new GitError('fatal: bad revision', 'git-failed', args.join(' '), '')
  }

  const result = await getChangedFiles('/virtual/repo', { git: fakeGit })

  assert.equal(result.ok, true, '只有工作区信息时也算成功')
  assert.ok(result.files.includes('new.md'), '未跟踪文件应被收录')
  assert.equal(result.baseline, 'worktree', '没有提交基线时 baseline 应为 worktree')
})

/** 3. 项目扫描：显式 workspace 声明、模块事实、命令与 README 摘要。 */
test('scanProject：读取 workspace 模块、包管理器与可复制命令', async (t) => {
  const root = await makeRoot(t)
  await createFixture(root)

  const facts = await scanProject(root)

  assert.equal(facts.explicitWorkspace, true, 'package.json workspaces 应算显式声明')
  assert.equal(facts.modules.length, 1, '应只检测到 packages/core 一个模块')
  const module = facts.modules[0]
  assert.equal(module.path, 'packages/core', '模块路径应相对项目根')
  assert.equal(module.packageName, '@demo/core', '模块包名取自模块 package.json')
  assert.equal(module.testCommand, 'pnpm --filter @demo/core test', '模块测试命令应可直接复制')
  assert.equal(facts.packageManager, 'pnpm', 'pnpm-lock.yaml 决定包管理器为 pnpm')
  assert.equal(facts.commands.build, 'pnpm build', '构建命令来自根 scripts.build')
  assert.equal(facts.commands.test, 'pnpm test', '测试命令来自根 scripts.test')
  assert.ok((facts.readmeSummary ?? '').includes('demo repository'), 'README 摘要应取标题后第一段原文')
  assert.equal(facts.moduleNotice, undefined, '未超过模块上限时不应给出提示')
})

/** 3. 模块边界只到二级：`src/http/{lib,test,api}` 收敛成一个 `src/http` 模块。 */
test('scanProject：三级候选目录收敛为二级模块', async (t) => {
  const root = await makeRoot(t)
  // 三个三级子目录各自都有 5 个以上 .ts，但它们必须算同一个 src/http 模块。
  for (const subdir of ['lib', 'test', 'api']) {
    for (let index = 0; index < 5; index += 1) {
      await putFile(
        root,
        `src/http/${subdir}/file-${String(index)}.ts`,
        `export const n = ${String(index)}\n`,
      )
    }
  }

  const facts = await scanProject(root)

  assert.equal(facts.modules.length, 1, 'src/http/{lib,test,api} 应只算一个模块')
  const module = facts.modules[0]
  assert.equal(module.path, 'src/http', '模块路径应收敛到二级目录 src/http')
  assert.equal(module.name, 'http', '模块名取路径最后一段')
  assert.equal(module.kind, 'unknown', 'src/http 没有 manifest，类型应是 unknown')
  assert.deepEqual(module.entries, [], 'src/http 没有 manifest 入口，entries 应为空')
  for (const item of facts.modules) {
    const segments = item.path.split('/').filter((segment) => segment !== '')
    assert.ok(segments.length <= 2, `模块路径不应超过两级：${item.path}`)
  }
})

/** 3. 纯函数：workspace glob 匹配与锁文件判定。 */
test('matchGlob 与 detectPackageManager：纯函数边界', () => {
  assert.equal(matchGlob('packages/*', 'packages/core'), true, '单星号应匹配一级目录')
  assert.equal(matchGlob('packages/*', 'packages/core/src'), false, '单星号不跨路径分隔符')
  assert.equal(detectPackageManager(['yarn.lock']), 'yarn', 'yarn.lock 应判定为 yarn')
})

/** 3. 本地 mtime 扫描：只收基线之后修改过的文件，且不把基线来源 AGENTS.md 算作改动。 */
test('getFilesModifiedSince：只收基线之后的本地文件', async (t) => {
  const root = await makeRoot(t)
  const oldPath = await putFile(root, 'old.txt', 'old\n')
  await putFile(root, 'new.txt', 'new\n')
  await putFile(root, 'AGENTS.md', '# AGENTS.md\n')
  await utimes(oldPath, new Date(1000), new Date(1000))

  const result = await getFilesModifiedSince(root, Date.now() - 60_000)

  assert.ok(result.files.includes('new.txt'), '基线之后改过的文件应被收录')
  assert.ok(!result.files.includes('old.txt'), '基线之前的旧文件不应被收录')
  assert.ok(!result.files.includes('AGENTS.md'), '根 AGENTS.md 是基线本身，不应算改动')
  assert.equal(result.truncated, false, '少量文件不应触发截断')
})

/** 4. 项目级渲染：标题、章节顺序、真实命令与占位符计数。 */
test('renderProjectDoc：章节顺序即固定表、命令来自证据、占位符计数自洽', async (t) => {
  const root = await makeRoot(t)
  await createFixture(root)
  const facts = await scanProject(root)

  const rendered = renderProjectDoc(facts, { modules: facts.modules, moduleDocs: [] })
  const { text } = rendered

  assert.ok(text.startsWith('# AGENTS.md'), '文档应以一级标题开头')
  assert.ok(text.includes('pnpm build'), '应含由 scripts 推导的构建命令')
  assert.ok(text.includes('pnpm test'), '应含由 scripts 推导的测试命令')
  assert.equal(rendered.todoCount, countTodoPlaceholders(text), 'todoCount 应等于占位符出现次数')
  assert.ok(
    text.split('\n').length <= MAX_DOC_LINES,
    `文档行数应不超过 ${MAX_DOC_LINES}`,
  )

  // 出现的章节必须按 PROJECT_SECTIONS 的顺序排（可以是子序列，缺失章节省略）。
  let cursor = 0
  for (const section of splitSections(text).sections) {
    const index = PROJECT_SECTIONS.indexOf(section.title, cursor)
    assert.ok(index >= cursor, `章节「${section.title}」不在固定顺序中`)
    cursor = index + 1
  }
})

/** 4. 模块级渲染：顶部引用上级文档，去掉模块索引，补模块入口。 */
test('renderModuleDoc：上级链接与模块章节', async (t) => {
  const root = await makeRoot(t)
  await createFixture(root)
  const facts = await scanProject(root)
  const module = facts.modules[0]
  assert.ok(module !== undefined, 'fixture 应扫描出一个模块')

  assert.equal(parentLinkFor('packages/core'), '../../AGENTS.md', '上级链接按路径深度生成')
  const rendered = renderModuleDoc(module)
  const firstLine = rendered.text.split('\n')[0]
  assert.ok(firstLine.startsWith('> 上级：'), '首行应是上级文档引用')
  assert.ok(firstLine.includes('../../AGENTS.md'), '引用路径应指回项目级 AGENTS.md')
  assert.ok(!rendered.text.includes('## 模块索引'), '模块文档不应出现模块索引')
  assert.ok(rendered.text.includes('## 模块入口'), '模块文档应有模块入口章节')
})

/** 4. 防幻觉：空项目里不编造日期与版本号，缺证据只留占位符。 */
test('空项目的文档不编造日期与版本号', async (t) => {
  const root = await makeRoot(t)
  const facts = await scanProject(root)

  const rendered = renderProjectDoc(facts)

  assert.ok(!/\b\d{4}-\d{2}-\d{2}\b/u.test(rendered.text), '不应出现任何日期')
  assert.ok(!/\bv?\d+\.\d+\.\d+\b/u.test(rendered.text), '不应出现任何版本号')
  assert.ok(rendered.text.includes(TODO_PLACEHOLDER), '缺证据处应写占位符')
  assert.ok(rendered.todoCount > 0, '空项目的待补充数量应大于 0')
})

/** 4. 截断：超长文档收敛到行数上限。 */
test('truncateToMaxLines：长文档收敛到上限', () => {
  const lines = []
  for (let index = 0; index < 200; index += 1) {
    lines.push(index % 20 === 0 ? `## section ${index}` : `第 ${index} 行正文`)
  }
  const long = `${lines.join('\n')}\n`

  const truncated = truncateToMaxLines(long)

  assert.ok(
    truncated.split('\n').length <= MAX_DOC_LINES,
    `截断后行数应不超过 ${MAX_DOC_LINES}`,
  )
})

/** 5. 章节合并：只替换给出标题，未提及章节逐字保留。 */
test('mergeSections：只改给出的章节', () => {
  const existing = '# X\n\n## 快速开始\n\n旧内容\n\n## 项目背景\n\n手写背景\n\n## 项目目标\n\n人工目标\n'

  const merged = mergeSections(existing, new Map([['快速开始', '新内容']]))

  assert.ok(merged.changed.includes('快速开始'), '「快速开始」应被记为已修改')
  assert.ok(merged.text.includes('## 项目背景\n\n手写背景'), '「项目背景」原文应保留')
  assert.ok(merged.text.includes('## 项目目标\n\n人工目标'), '「项目目标」原文应保留')
})

/** 5. 章节合并：内容没变化时不重写。 */
test('mergeSections：内容相同时不改写也不记改动', () => {
  const existing = '# X\n\n## 快速开始\n\n旧内容\n\n## 项目背景\n\n手写背景\n\n## 项目目标\n\n人工目标\n'

  const merged = mergeSections(existing, new Map([['项目背景', '手写背景']]))

  assert.equal(merged.changed.length, 0, '内容一致时不应记录改动')
  assert.equal(merged.text, existing, '文本应逐字节保持原样')
})

/** 5. 占位符清洗：只删「整行只剩占位符」的行，正文里的 TODO 与真实表格数据保留。 */
test('scrubPlaceholders：删占位行，保留正文里的 TODO 与真实表格行', () => {
  const input = [
    '## 协作流程',
    '',
    '<!-- TODO: 待补充 -->',
    '- 分支命名：TODO',
    '| TODO | TODO |',
    '- 里程碑 | 2026-01',
    '- TODO 列表接口待实现',
    '',
    '| 模块 | 路径 | 文档 |',
    '| --- | --- | --- |',
    '| core | `packages/core` | — |',
  ].join('\n')

  const cleaned = scrubPlaceholders(input)

  assert.ok(!cleaned.includes(TODO_PLACEHOLDER), '含 <!-- TODO: 待补充 --> 的整行应被删除')
  assert.ok(!cleaned.includes('分支命名'), '「- 分支命名：TODO」这种纯占位行应被删除')
  assert.ok(!cleaned.includes('| TODO | TODO |'), '单元格全是占位符的表格行应被删除')
  assert.ok(cleaned.includes('- 里程碑 | 2026-01'), '正文里的日期不应被误删')
  assert.ok(cleaned.includes('- TODO 列表接口待实现'), '正文句子里出现 TODO 不应被误删')
  assert.ok(cleaned.includes('| 模块 | 路径 | 文档 |'), '表头应保留')
  assert.ok(cleaned.includes('| --- | --- | --- |'), '表格分隔行应保留')
  assert.ok(cleaned.includes('| core | `packages/core` | — |'), '真实表格数据行应保留')
})

/** 5. 空正文判定：只有空行与表头不算内容，出现任何正文行或数据行就算有内容。 */
test('isEmptyDocBody：空行与表头不算正文，数据行才算', () => {
  assert.equal(isEmptyDocBody('- 正文'), false, '有正文行时不是空章节')
  assert.equal(isEmptyDocBody('| a | b |\n| --- | --- |'), true, '只有表头与分隔行应视为空')
  assert.equal(
    isEmptyDocBody('| a | b |\n| --- | --- |\n| c | d |'),
    false,
    '出现数据行即视为有内容',
  )
  assert.equal(isEmptyDocBody('  \n\n'), true, '只有空行应视为空')
})

/** 5. 空章节裁剪：只剩占位符的章节整节删除，preamble 与有正文章节保留，结尾单换行。 */
test('pruneEmptySections：删掉只剩占位符的章节并规范结尾换行', () => {
  const input = [
    '# AGENTS.md — demo',
    '',
    '## 项目目标',
    '',
    '<!-- TODO: 待补充 -->',
    '',
    '## 快速开始',
    '',
    '- 安装：`pnpm install`',
    '',
  ].join('\n')

  const pruned = pruneEmptySections(input)

  assert.ok(pruned.startsWith('# AGENTS.md — demo\n\n'), 'preamble 应原样保留')
  assert.ok(!pruned.includes('## 项目目标'), '只剩占位符的章节应整节删除')
  assert.ok(pruned.includes('## 快速开始\n\n- 安装：`pnpm install`'), '有正文章节应原样保留')
  assert.ok(pruned.endsWith('`\n'), '结果只留一个结尾换行')
  assert.ok(!pruned.endsWith('\n\n'), '结尾不应有多余空行')
})

/** 5. 生成文档组装：前置块 → 模型章节（模型顺序）→ 插件表格，不按固定章节表重排。 */
test('composeGeneratedDoc：前置块 + 模型顺序章节 + 插件表格在最后', () => {
  const modelText = [
    '这一行前言会被丢弃。',
    '',
    '## 项目背景',
    '',
    '模型的背景。',
    '',
    '## 快速开始',
    '',
    '- 安装：`pnpm install`',
    '',
  ].join('\n')
  const table = {
    title: '模块索引',
    body: ['| 模块 | 路径 | 文档 |', '| --- | --- | --- |', '| core | `packages/core` | — |'].join(
      '\n',
    ),
  }

  const result = composeGeneratedDoc({ preamble: ['# AGENTS.md — demo'], modelText, table })

  assert.deepEqual(
    splitSections(result.text).sections.map((item) => item.title),
    ['项目背景', '快速开始', '模块索引'],
    '章节顺序是模型顺序 + 末尾插件表格，不按 PROJECT_SECTIONS 重排',
  )
  assert.deepEqual(result.applied, ['项目背景', '快速开始'], 'applied 是模型顺序')
  assert.equal(result.text.split('\n')[0], '# AGENTS.md — demo', '第一行是插件前置块')
  assert.ok(!result.text.includes('前言'), '模型前言不应写进文档')
  assert.ok(result.text.includes('| core | `packages/core` | — |'), '插件表格应写进文档')
})

/** 5. 生成文档组装：同名章节只留一次、模型自带的「模块索引」被插件表格接管。 */
test('composeGeneratedDoc：同名去重、丢弃模型自带的模块索引', () => {
  const modelText = [
    '## 快速开始',
    '',
    '- 安装：`pnpm install`',
    '',
    '## 快速开始',
    '',
    '- 重复的第二节',
    '',
    '## 模块索引',
    '',
    '| 模型 | 瞎写 |',
    '',
    '## 项目背景',
    '',
    'Demo 项目。',
    '',
  ].join('\n')

  const result = composeGeneratedDoc({
    preamble: ['# AGENTS.md — demo'],
    modelText,
    table: {
      title: '模块索引',
      body: ['| 模块 | 路径 | 文档 |', '| --- | --- | --- |', '| core | `packages/core` | — |'].join(
        '\n',
      ),
    },
  })

  assert.deepEqual(result.applied, ['快速开始', '项目背景'], '只有真正写入的模型章节进 applied')
  assert.ok(result.dropped.includes('快速开始'), '同名重复章节应记入 dropped')
  assert.ok(result.dropped.includes('模块索引'), '模型自带的「模块索引」应记入 dropped')
  assert.equal(result.text.split('## 快速开始').length - 1, 1, '同名章节只写一次')
  assert.ok(!result.text.includes('重复的第二节'), '重复章节的正文不应进入文档')
  assert.ok(!result.text.includes('瞎写'), '模型写的「模块索引」被插件表格接管')
  assert.equal(result.text.split('## 模块索引').length - 1, 1, '模块索引只在末尾出现一次')
})

/** 5. 生成文档组装：模型没有可用章节时只剩前置块，applied 为空、连表格都不追加。 */
test('composeGeneratedDoc：模型没有章节时只留前置块', () => {
  const result = composeGeneratedDoc({
    preamble: ['# AGENTS.md — demo'],
    modelText: '模型只给了一段没有章节的文字。',
    table: { title: '模块索引', body: '| 模块 | 路径 | 文档 |' },
  })

  assert.equal(result.text, '# AGENTS.md — demo\n', 'text 只含前置块')
  assert.deepEqual(result.applied, [], '没有可用章节时 applied 为空')
  assert.ok(!result.text.includes('模块索引'), '没有模型章节时不追加插件表格')
})

/** 5. 生成文档组装：超长模型正文同样收敛到 MAX_DOC_LINES，被截断的章节不计入 applied。 */
test('composeGeneratedDoc：超长模型正文不超过 MAX_DOC_LINES', () => {
  const longBody = Array.from({ length: 260 }, (_, index) => `- 第 ${index} 行`).join('\n')
  const modelText = ['## 概览', '', '简短概览。', '', '## 明细', '', longBody, ''].join('\n')

  const result = composeGeneratedDoc({ preamble: ['# AGENTS.md — demo'], modelText })

  assert.ok(
    result.text.split('\n').length <= MAX_DOC_LINES,
    `组装结果行数应不超过 ${MAX_DOC_LINES}`,
  )
  assert.ok(result.applied.includes('概览'), '截断前的章节仍应写入')
  assert.ok(!result.applied.includes('明细'), '被截断的章节不计入 applied')
  assert.ok(!result.text.includes('- 第 259 行'), '末尾被截断的正文不应出现')
})

/** 5. 分批计划：按章切片、不重排不丢章，非法批大小回退默认值。 */
test('planSectionBatches：按章切片且不丢章，非法批大小回退默认值', () => {
  assert.equal(BATCH_MAX_SECTIONS, 4, '默认每批最多 4 章')
  assert.equal(
    PROJECT_WRITABLE_SECTIONS.length,
    PROJECT_SECTIONS.length - 1,
    '项目级可写章节只去掉一项',
  )
  assert.ok(!PROJECT_WRITABLE_SECTIONS.includes('模块索引'), '「模块索引」不交给模型撰写')

  assert.deepEqual(
    planSectionBatches(PROJECT_WRITABLE_SECTIONS).map((batch) => batch.length),
    [4, 4, 4],
    '项目级可写章节 12 章应切成 4/4/4',
  )
  assert.deepEqual(
    planSectionBatches(MODULE_SECTIONS).map((batch) => batch.length),
    [4, 4, 2],
    '模块级 10 章应切成 4/4/2',
  )
  assert.deepEqual(planSectionBatches([]), [], '空数组返回空计划')
  assert.deepEqual(planSectionBatches(['快速开始']), [['快速开始']], '单元素只切一批')
  assert.deepEqual(
    planSectionBatches(PROJECT_WRITABLE_SECTIONS, 0).map((batch) => batch.length),
    [4, 4, 4],
    'maxPerBatch 传 0 时回退到默认值',
  )

  // 各批按顺序拼接后等于入参顺序：不重排、不丢章、不重叠。
  const flattened = planSectionBatches(PROJECT_WRITABLE_SECTIONS).flat()
  assert.deepEqual(flattened, [...PROJECT_WRITABLE_SECTIONS], '各批拼接后应等于入参顺序')
  assert.equal(new Set(flattened).size, flattened.length, '各批章节不应重叠')
})

/** 6. 模块归属：最长前缀 + `/` 边界，目录本身不算模块内文件。 */
test('matchModuleForFile：按 / 边界做最长前缀匹配', () => {
  const modules = [minimalModule()]

  assert.equal(
    matchModuleForFile(modules, 'packages/core/src/a.ts')?.path,
    'packages/core',
    '模块内文件应归属该模块',
  )
  assert.equal(
    matchModuleForFile(modules, 'packages/core-utils/src/a.ts'),
    undefined,
    'packages/core-utils 不应被 packages/core 吞掉',
  )
  assert.equal(matchModuleForFile(modules, 'packages/core'), undefined, '与模块同名的目录不是模块内文件')
})

/** 6. 受影响章节：模块内文件不动项目级，根配置与 CI 只影响对应章节。 */
test('affectedProjectSections：按证据类型映射到章节', () => {
  const modules = [minimalModule()]
  const previous = ['packages/core']

  assert.equal(
    affectedProjectSections(['packages/core/src/a.ts'], modules, previous).size,
    0,
    '只有模块内变更时项目级章节为空',
  )
  assert.ok(
    affectedProjectSections(['package.json'], modules, previous).has('快速开始'),
    '根 package.json 变更应影响「快速开始」',
  )
  assert.ok(
    affectedProjectSections(['.github/workflows/ci.yml'], modules, previous).has('验收标准'),
    'CI 变更应影响「验收标准」',
  )
  assert.ok(
    affectedProjectSections(['README.md'], modules, previous).has('项目背景'),
    'README 变更应影响「项目背景」',
  )
})

/** 7. 生成分支：不套模板 —— 只写模型返回的章节（模型顺序），无模板章节、无占位符。 */
test('无 AGENTS.md 时生成项目级文档', async (t) => {
  const root = await makeRoot(t)
  await createFixture(root)

  const modelText = [
    '## 快速开始',
    '',
    '- 安装：`pnpm install`',
    '',
    '- 构建：`pnpm build`',
    '',
    '- 测试：`pnpm test`',
    '',
    '## 项目背景',
    '',
    'Demo 项目。',
    '',
    '## 自定义约定',
    '',
    '不要提交 `node_modules`。',
    '',
  ].join('\n')
  const handler = handlerWith({
    generate: async () => ({ ok: true, text: modelText, route: 'fake/model' }),
  })

  const result = await handler({ agent: { session: { header: { cwd: root } } }, rawInput: '' })

  assert.equal(result.kind, 'success', '生成分支应返回 success')
  const docPath = join(root, 'AGENTS.md')
  assert.equal(await exists(docPath), true, '应写出项目级 AGENTS.md')
  const text = await readFile(docPath, 'utf8')

  assert.equal(text.split('\n')[0], '# AGENTS.md — demo', '首行应是插件写的前置标题行')
  assert.ok(text.includes('## 快速开始'), '模型返回的章节应写进文档')
  assert.ok(text.includes('## 自定义约定'), '模型自定义的章节同样应写进文档')
  assert.ok(
    text.indexOf('## 快速开始') < text.indexOf('## 项目背景') &&
      text.indexOf('## 项目背景') < text.indexOf('## 自定义约定'),
    '章节顺序应保持模型返回的顺序',
  )
  for (const title of ['## 关键里程碑', '## 边界', '## 协作流程']) {
    assert.ok(!text.includes(title), `模型未返回的模板章节「${title}」不应被补写`)
  }
  assert.ok(text.includes('## 模块索引'), '有模块时末尾仍由插件回写模块索引表')
  assert.ok(!text.includes(TODO_PLACEHOLDER), `写出的文档不应含 ${TODO_PLACEHOLDER}`)
  assert.ok(!text.includes('待补充'), '写出的文档不应出现「待补充」字样')
  assert.match(result.text, /已生成 AGENTS\.md（模型 fake\/model）/u, '回执应写明生成与模型路由')
  assert.ok(!result.text.includes('待人工补充'), '回执不再统计待补充数量')
})

/** 7. 跳过分支：已有文档且无参数时一个字节都不写。 */
test('已有 AGENTS.md 且无参数时只提示 -update', async (t) => {
  const root = await makeRoot(t)
  await createFixture(root)
  const docPath = join(root, 'AGENTS.md')
  const existing = '# hand written\n\n## 项目背景\n\n人工内容\n'
  await putFile(root, 'AGENTS.md', existing)

  const result = await handlerWith()({ agent: { session: { header: { cwd: root } } }, rawInput: '' })

  assert.equal(result.kind, 'success', '跳过分支应返回 success')
  assert.match(result.text, /已存在/u, '回执应说明文档已存在')
  assert.match(result.text, /-update/u, '回执应提示使用 -update')
  const after = await readFile(docPath)
  assert.ok(after.equals(Buffer.from(existing, 'utf8')), '已有文档不应被修改')
})

/** 8. 只有模块内变更：项目级文档不变，只给出模块文档建议。 */
test('-update 只有模块内变更时项目级文档字节不变', async (t) => {
  const root = await makeRoot(t)
  await createFixture(root)

  // 手写两章：项目背景 + 与真实扫描一致的模块索引（否则 -update 会补写该章节）。
  const facts = await scanProject(root)
  const existing = [
    '# 手写文档',
    '',
    '## 项目背景',
    '',
    '人工内容',
    '',
    '## 模块索引',
    '',
    moduleIndexTable(facts.modules, []),
    '',
  ].join('\n')
  await putFile(root, 'AGENTS.md', existing)

  const handler = handlerWith({
    getChangedFiles: async () => ({ ok: true, files: ['packages/core/src/a.ts'] }),
  })
  const result = await handler({ agent: { session: { header: { cwd: root } } }, rawInput: '-update' })

  assert.equal(result.kind, 'success', '只有模块内变更不应失败')
  assert.ok(result.text.includes('packages/core'), '回执应提示为该模块创建文档')
  const after = await readFile(join(root, 'AGENTS.md'))
  assert.ok(after.equals(Buffer.from(existing, 'utf8')), '项目级文档应逐字节不变')
})

/** 8. 非 git 且根文档之后没有本地改动：回报无需更新，一个字节都不写。 */
test('-update 在非 git 且无本地改动时回报无需更新且不写文件', async (t) => {
  const root = await makeRoot(t)
  await createFixture(root)
  const existing = '# 手写文档\n\n## 快速开始\n\n人工写的旧步骤\n\n## 项目背景\n\n人工背景\n'
  const docPath = await putFile(root, 'AGENTS.md', existing)

  const handler = handlerWith({
    getChangedFiles: async () => ({ ok: false, files: [], reason: 'not a git repository' }),
    modifiedSince: async () => ({ files: [] }),
  })
  const result = await handler({ agent: { session: { header: { cwd: root } } }, rawInput: '-update' })

  assert.equal(result.kind, 'success', '非 git 不再直接报错，应返回 success')
  assert.ok(result.text.includes('非 git'), '回执应说明这是非 git 的本地比对')
  assert.ok(result.text.includes('无需更新'), '没有晚于根文档的改动时应回报无需更新')
  const after = await readFile(docPath)
  assert.ok(after.equals(Buffer.from(existing, 'utf8')), 'AGENTS.md 应逐字节不变')
})

/** 8. 非 git 但有本地改动：按根文档 mtime 当基线，只更新受影响的证据章节。 */
test('-update 在非 git 时按根文档 mtime 应用本地改动', async (t) => {
  const root = await makeRoot(t)
  await createFixture(root)
  const docPath = await putFile(
    root,
    'AGENTS.md',
    '# 手写文档\n\n## 快速开始\n\n人工写的旧步骤\n\n## 项目背景\n\n人工背景\n',
  )

  // 根 scripts 增加 lint：它会出现在「快速开始」里，也是本次的变更证据。
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  manifest.scripts.lint = 'eslint .'
  await putFile(root, 'package.json', jsonText(manifest))

  const handler = handlerWith({
    getChangedFiles: async () => ({ ok: false, files: [], reason: 'not a git repository' }),
    modifiedSince: async () => ({ files: ['package.json'] }),
  })
  const result = await handler({ agent: { session: { header: { cwd: root } } }, rawInput: '-update' })

  assert.equal(result.kind, 'success', '本地 mtime 变更应能驱动 -update')
  assert.ok(result.text.includes('非 git'), '回执应说明未使用 diff')
  const doc = await readFile(docPath, 'utf8')
  assert.ok((sectionBody(doc, '快速开始') ?? '').includes('lint'), '「快速开始」应带上新增的 lint 脚本')
  assert.equal(sectionBody(doc, '项目背景'), '人工背景', '未受影响的手写章节应逐字保留')
})

/** 8. 非 git 且读不到根文档 mtime：返回可读错误，且一个文件（含模块文档）都不写。 */
test('-update 在非 git 且读不到根文档 mtime 时报错且不写文件', async (t) => {
  const root = await makeRoot(t)
  await createFixture(root)
  const existing = '# hand written\n\n## 项目背景\n\n人工内容\n'
  const docPath = await putFile(root, 'AGENTS.md', existing)

  const handler = handlerWith({
    getChangedFiles: async () => ({ ok: false, files: [], reason: 'not a git repository' }),
    statFile: async () => {
      throw new Error('stat failed')
    },
    modifiedSince: async () => ({ files: ['package.json'] }),
  })
  const result = await handler({ agent: { session: { header: { cwd: root } } }, rawInput: '-update -modules' })

  assert.equal(result.kind, 'error', '连 mtime 都读不到应返回错误回执')
  assert.ok(result.text.includes('无法读取'), '回执应说明读不到修改时间')
  const after = await readFile(docPath)
  assert.ok(after.equals(Buffer.from(existing, 'utf8')), 'AGENTS.md 应保持不变')
  assert.equal(await exists(join(root, 'packages/core/AGENTS.md')), false, '不应生成任何模块文档')
})

/** 9. 增量更新：根 scripts 变更只重写「快速开始」，其余章节逐字保留。 */
test('-update 只重写受影响的「快速开始」章节', async (t) => {
  const root = await makeRoot(t)
  await createFixture(root)
  const docPath = join(root, 'AGENTS.md')

  // 先用生成分支产出 doc1，作为“上一版文档”。
  const generated = await handlerWith()({ agent: { session: { header: { cwd: root } } }, rawInput: '' })
  assert.equal(generated.kind, 'success', '生成分支应成功')
  const doc1 = await readFile(docPath, 'utf8')

  // 改根 package.json 的 scripts（新增 lint），渲染内容随之变化。
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  manifest.scripts.lint = 'eslint .'
  await putFile(root, 'package.json', jsonText(manifest))
  await putFile(root, 'AGENTS.md', doc1)

  const handler = handlerWith({
    getChangedFiles: async () => ({ ok: true, files: ['package.json'] }),
  })
  const result = await handler({ agent: { session: { header: { cwd: root } } }, rawInput: '-update' })

  assert.equal(result.kind, 'success', '-update 应成功')
  const doc2 = await readFile(docPath, 'utf8')

  const quickStart1 = sectionBody(doc1, '快速开始')
  const quickStart2 = sectionBody(doc2, '快速开始')
  assert.notEqual(quickStart2, quickStart1, '「快速开始」应被更新')
  assert.ok((quickStart2 ?? '').includes('lint'), '新增的 lint 脚本应出现在「快速开始」')

  for (const title of ['项目背景', '项目目标', '关键里程碑', '边界']) {
    assert.equal(sectionBody(doc2, title), sectionBody(doc1, title), `章节「${title}」不应变化`)
  }

  const before = new Map(splitSections(doc1).sections.map((item) => [item.title, item.raw]))
  for (const item of splitSections(doc2).sections) {
    if (item.title === '快速开始') continue
    assert.equal(item.raw, before.get(item.title), `章节「${item.title}」原文应逐字保留`)
  }
})

/** 10. -modules：生成模块文档、把链接回写进模块索引，重复执行不再重写。 */
test('-modules 生成模块文档并回写模块索引', async (t) => {
  const root = await makeRoot(t)
  await createFixture(root)
  await addUtilsModule(root)

  const handler = handlerWith()
  const result = await handler({ agent: { session: { header: { cwd: root } } }, rawInput: '-modules' })

  assert.equal(result.kind, 'success', '-modules 应成功')
  const rootDoc = join(root, 'AGENTS.md')
  assert.equal(await exists(rootDoc), true, '根 AGENTS.md 应被生成')
  assert.equal(await exists(join(root, 'packages/core/AGENTS.md')), true, 'core 模块文档应生成')
  assert.equal(await exists(join(root, 'packages/utils/AGENTS.md')), true, 'utils 模块文档应生成')

  const rootText = await readFile(rootDoc, 'utf8')
  assert.ok(rootText.includes('[AGENTS.md](packages/core/AGENTS.md)'), '模块索引应链接 core 文档')
  assert.ok(rootText.includes('[AGENTS.md](packages/utils/AGENTS.md)'), '模块索引应链接 utils 文档')
  const paths = modulePathsFromIndex(rootText)
  assert.ok(paths.includes('packages/core'), '模块索引应能解析出 packages/core')
  assert.ok(paths.includes('packages/utils'), '模块索引应能解析出 packages/utils')

  const coreText = await readFile(join(root, 'packages/core/AGENTS.md'), 'utf8')
  const utilsText = await readFile(join(root, 'packages/utils/AGENTS.md'), 'utf8')
  for (const [modulePath, moduleText] of [
    ['packages/core', coreText],
    ['packages/utils', utilsText],
  ]) {
    assert.ok(
      moduleText.startsWith('> 上级：[项目级 AGENTS.md]('),
      `${modulePath} 的模块文档应以插件写的上级引用行开头`,
    )
    assert.ok(!moduleText.includes('## 模块索引'), `${modulePath} 的模块文档不应出现模块索引`)
  }
  assert.ok(
    coreText.startsWith('> 上级：[项目级 AGENTS.md](../../AGENTS.md)'),
    'packages/core 的上级链接应是 ../../AGENTS.md',
  )

  // 再跑一次（根文档已存在、无 -update）：只提示已存在，不重写文件。
  const before = await readFile(rootDoc)
  const again = await handler({ agent: { session: { header: { cwd: root } } }, rawInput: '-modules' })
  assert.equal(again.kind, 'success', '第二次 -modules 应成功')
  assert.match(again.text, /已存在/u, '回执应说明文档已存在')
  const after = await readFile(rootDoc)
  assert.ok(after.equals(before), '根文档不应被重写')
})

/** 10. 只在模块文档变化时：模块结果排第一，项目级另起一句说明，且不重复「没有需要更新的项目级章节」。 */
test('-update -modules 只更新模块文档时首行是模块结果', async (t) => {
  const root = await makeRoot(t)
  await createFixture(root)

  // 先生成根文档与模块文档，作为“上一版”。
  const generated = await handlerWith()({ agent: { session: { header: { cwd: root } } }, rawInput: '-modules' })
  assert.equal(generated.kind, 'success', '首次 -modules 应成功')
  const moduleDocPath = join(root, 'packages/core/AGENTS.md')
  const moduleBefore = await readFile(moduleDocPath, 'utf8')

  // 模块 package.json 加依赖：这是模块证据章节（依赖关系）的变化，项目级不受影响。
  const moduleManifest = JSON.parse(await readFile(join(root, 'packages/core/package.json'), 'utf8'))
  moduleManifest.dependencies = { 'left-pad': '^1.0.0' }
  await putFile(root, 'packages/core/package.json', jsonText(moduleManifest))

  const handler = handlerWith({
    getChangedFiles: async () => ({ ok: true, files: ['packages/core/package.json'], baseline: 'tag:v1' }),
  })
  const result = await handler({ agent: { session: { header: { cwd: root } } }, rawInput: '-update -modules' })

  assert.equal(result.kind, 'success', '-update -modules 应成功')
  const lines = result.text.split('\n')
  assert.equal(
    lines[0],
    '已更新模块文档：packages/core（模型 fake/model）。',
    '首行应是带模型路由的模块更新结果，而不是「无需更新」',
  )
  assert.ok(result.text.includes('项目级 AGENTS.md 无需更新。'), '应单独说明项目级文档没有变化')
  assert.ok(!result.text.includes('没有需要更新的项目级章节。'), '首行已说明无需更新，不应再重复该 note')
  const moduleAfter = await readFile(moduleDocPath, 'utf8')
  assert.ok(
    (sectionBody(moduleAfter, '依赖关系') ?? '').includes('left-pad'),
    '模块「依赖关系」章节应写入新依赖',
  )
  assert.notEqual(moduleAfter, moduleBefore, '模块文档应实际变化')
})

/** 16. 空项目闸门：没有源码文件时只回一句提示，不扫描模块、不读写文档、不调模型。 */
test('空项目：没有源码文件时只提示且不扫描、不写盘、不调模型', async (t) => {
  const root = await makeRoot(t)
  await putFile(root, 'package.json', jsonText({ name: 'empty-demo', version: '0.0.0' }))
  await putFile(root, 'README.md', '# Empty\n\n只有文档，没有源码。\n')

  let scanCalls = 0
  let generateCalls = 0
  const handler = handlerWith({
    scanProject: async (target) => {
      scanCalls += 1
      return await scanProject(target)
    },
    generate: async () => {
      generateCalls += 1
      return { ok: true, text: '', route: 'fake/model' }
    },
  })

  for (const rawInput of ['', '-update', '-modules', '-update -modules']) {
    const result = await handler({ agent: { session: { header: { cwd: root } } }, rawInput })
    const label = rawInput === '' ? '(无参数)' : rawInput
    assert.equal(result.kind, 'success', `${label} 应返回 success`)
    assert.equal(result.text.split('\n').length, 1, `${label} 应只回一行提示`)
    assert.ok(result.text.includes('未检测到代码文件'), `${label} 的提示应说明没有代码文件`)
  }

  assert.equal(scanCalls, 0, '空项目不应扫描模块')
  assert.equal(generateCalls, 0, '空项目不应调用模型')
  assert.equal(await exists(join(root, 'AGENTS.md')), false, '不应写出根 AGENTS.md')
  assert.equal(await exists(join(root, 'packages/core/AGENTS.md')), false, '不应写出任何模块文档')
})

/**
 * 16. 生成分支：按章节分批调用模型。
 *
 * 断言批次与 `planSectionBatches(PROJECT_WRITABLE_SECTIONS)` 一致、每批只要求本批章节，
 * 并保留原有的 user 段断言与写盘 / 回执断言；写出的章节顺序等于三批拼接后的顺序。
 */
test('生成分支：按章节分批调用模型，写盘来自三批拼接的模型输出', async (t) => {
  const root = await makeRoot(t)
  await createFixture(root)
  const requests = []
  const handler = handlerWith({
    generate: async (request) => {
      requests.push(request)
      // 只写本批章节：正文带本章标题，方便核对拼接后的写盘顺序。
      const text = request.sections
        .map((title) =>
          title === '项目背景'
            ? `## ${title}\n\n模型补充的背景`
            : `## ${title}\n\n模型写的「${title}」正文`,
        )
        .join('\n\n')
      return { ok: true, text, route: 'fake/model' }
    },
  })

  const result = await handler({ agent: { session: { header: { cwd: root } } }, rawInput: '' })

  assert.equal(result.kind, 'success', '生成分支应成功')

  // 批次数由 planSectionBatches 推导（12 章 / 每批 4 章 = 3 批），不写死。
  const batches = planSectionBatches(PROJECT_WRITABLE_SECTIONS)
  assert.ok(batches.length > 1, '项目级生成必须切成多批')
  assert.equal(requests.length, batches.length, `项目级生成应按 ${batches.length} 批调用模型`)

  // 每个 request 都带本批 sections：非空、逐批等于计划、拼接后不重叠也不丢章。
  for (const [index, request] of requests.entries()) {
    assert.equal(request.kind, 'project-create', 'kind 应为 project-create')
    assert.ok(Array.isArray(request.sections) && request.sections.length > 0, '每批 sections 都应非空')
    assert.deepEqual(request.sections, batches[index], `第 ${index + 1} 批的 sections 应与分批计划一致`)
  }
  const flattened = requests.flatMap((request) => request.sections)
  assert.deepEqual(flattened, [...PROJECT_WRITABLE_SECTIONS], '各批 sections 拼接后应等于全部可写章节')
  assert.equal(new Set(flattened).size, flattened.length, '各批 sections 不应重叠')

  // 每批 system 只列本批章节：含本批标题，不含其它批的标题。
  for (const [index, request] of requests.entries()) {
    assert.ok(typeof request.system === 'string' && request.system.length > 0, 'system 不应为空')
    for (const title of request.sections) {
      assert.ok(request.system.includes(title), `第 ${index + 1} 批 system 应包含本批章节「${title}」`)
    }
    for (const title of PROJECT_WRITABLE_SECTIONS) {
      if (request.sections.includes(title)) continue
      assert.ok(
        !request.system.includes(title),
        `第 ${index + 1} 批 system 不应出现其它批的章节「${title}」`,
      )
    }
    assert.ok(request.system.includes('分批'), '分批调用的 system 应说明这是分批撰写')
  }
  assert.ok(!requests[0].system.includes('常见问题 FAQ'), '首批 system 不应出现末批的「常见问题 FAQ」')

  const request = requests[0]
  assert.match(request.user, /## 项目事实与确定性草稿/u, 'user 应包含确定性草稿段')
  assert.match(request.user, /## 代码与文档摘录/u, 'user 应包含代码与文档摘录段')
  assert.ok(request.user.includes('packages/core/src/index.ts'), '模块入口应进入代码摘录')
  assert.ok(request.user.includes('A demo repository for tests.'), 'README 内容应进入提示词')
  assert.ok(request.user.includes('pnpm build'), '由 scripts 推导的命令应进入提示词')

  const text = await readFile(join(root, 'AGENTS.md'), 'utf8')
  assert.ok(text.includes('模型补充的背景'), '写盘内容应包含模型补充的正文')
  const written = splitSections(text).sections.map((item) => item.title)
  assert.deepEqual(
    written,
    [...PROJECT_WRITABLE_SECTIONS, '模块索引'],
    '写出章节顺序应等于三批拼接后的顺序，「模块索引」由插件回写在最后',
  )
  assert.ok(!text.includes('TODO'), '写出的文档不应残留 TODO 占位符')
  assert.ok(!text.includes('待补充'), '写出的文档不应残留「待补充」字样')
  assert.ok(text.split('\n').length <= MAX_DOC_LINES, `文档行数应不超过 ${MAX_DOC_LINES}`)
  assert.ok(
    result.text.includes('已生成 AGENTS.md（模型 fake/model）'),
    '回执应写明文档由哪个模型路由生成',
  )
})

/** 16. -update：模型收到现有文档正文与变更文件列表。 */
test('-update：模型收到现有文档正文与变更文件列表', async (t) => {
  const root = await makeRoot(t)
  await createFixture(root)
  await putFile(
    root,
    'AGENTS.md',
    '# 手写文档\n\n## 快速开始\n\n人工写的旧步骤\n\n## 项目背景\n\n人工背景\n',
  )
  const requests = []
  const handler = handlerWith({
    generate: async (request) => {
      requests.push(request)
      return { ok: true, text: request.draft, route: 'fake/model' }
    },
    getChangedFiles: async () => ({ ok: true, files: ['package.json'], baseline: 'tag:v1' }),
  })

  const result = await handler({ agent: { session: { header: { cwd: root } } }, rawInput: '-update' })

  assert.equal(result.kind, 'success', '-update 应成功')
  assert.equal(requests.length, 1, '-update 应调用一次模型')
  const request = requests[0]
  assert.equal(request.kind, 'project-update', 'kind 应为 project-update')
  assert.match(request.user, /## 现有文档正文/u, 'user 应包含现有文档正文段')
  assert.ok(request.user.includes('人工写的旧步骤'), '现有文档应逐字进入提示词')
  assert.match(request.user, /## 变更文件列表/u, 'user 应包含变更文件列表段')
  assert.ok(request.user.includes('- `package.json`'), '变更文件应逐条列在列表段里')
})

/** 16. -modules：每个模块按章分批调用模型，模块文档写入模型输出。 */
test('-modules：每个模块按章分批调用模型并写入模型输出', async (t) => {
  const root = await makeRoot(t)
  await createFixture(root)
  await addUtilsModule(root)
  const requests = []
  const handler = handlerWith({
    generate: async (request) => {
      requests.push(request)
      return { ok: true, text: `${request.draft}\n模型标记`, route: 'fake/model' }
    },
  })

  const result = await handler({ agent: { session: { header: { cwd: root } } }, rawInput: '-modules' })

  assert.equal(result.kind, 'success', '-modules 应成功')
  // 批次数由 planSectionBatches 推导（模块级 10 章 / 每批 4 章 = 3 批），不写死。
  const batches = planSectionBatches(MODULE_SECTIONS)
  assert.ok(batches.length > 1, '模块级生成必须切成多批')
  const moduleRequests = requests.filter((request) => request.kind === 'module')
  assert.equal(
    moduleRequests.length,
    2 * batches.length,
    `两个模块应各调用 ${batches.length} 批模型（共 ${2 * batches.length} 次）`,
  )
  for (const modulePath of ['packages/core', 'packages/utils']) {
    const own = moduleRequests.filter((request) =>
      request.user.includes(`- 模块路径：\`${modulePath}\``),
    )
    assert.equal(own.length, batches.length, `${modulePath} 应有 ${batches.length} 批请求`)
    for (const request of own) {
      assert.ok(Array.isArray(request.sections) && request.sections.length > 0, '每批 sections 都应非空')
    }
    assert.deepEqual(
      own.flatMap((request) => request.sections),
      [...MODULE_SECTIONS],
      `${modulePath} 各批 sections 拼接后应等于模块章节表`,
    )
  }
  for (const modulePath of ['packages/core', 'packages/utils']) {
    const text = await readFile(join(root, modulePath, 'AGENTS.md'), 'utf8')
    assert.ok(text.includes('模型标记'), `${modulePath} 的模块文档应写入模型输出`)
  }
})

/** 16. 模型失败：两阶段写盘，任一模型调用失败时一个文件都不写（含模块文档）。 */
test('模型失败：一个文件都不写（含模块文档）', async (t) => {
  const root = await makeRoot(t)
  await createFixture(root)
  await addUtilsModule(root)

  const failing = handlerWith({
    generate: async () => ({ ok: false, reason: 'provider down', action: '稍后重试' }),
  })
  const result = await failing({ agent: { session: { header: { cwd: root } } }, rawInput: '-modules' })

  assert.equal(result.kind, 'error', '模型失败应返回 error 回执')
  assert.ok(result.text.includes('provider down'), '回执应带上模型给出的原因')
  const batchCount = planSectionBatches(MODULE_SECTIONS).length
  assert.ok(
    result.text.includes(`第 1/${batchCount} 批`),
    '首批失败时回执应写明第几批（第 1/3 批）',
  )
  assert.equal(await exists(join(root, 'AGENTS.md')), false, '不应写出根 AGENTS.md')
  assert.equal(await exists(join(root, 'packages/core/AGENTS.md')), false, '不应写出 core 模块文档')
  assert.equal(await exists(join(root, 'packages/utils/AGENTS.md')), false, '不应写出 utils 模块文档')

  // 第 1 次成功、第 2 次失败：已生成的模块文档只在 pending 里排队，仍应零写盘。
  let calls = 0
  const secondFails = handlerWith({
    generate: async (request) => {
      calls += 1
      if (calls >= 2) return { ok: false, reason: 'provider down', action: '稍后重试' }
      return { ok: true, text: request.draft, route: 'fake/model' }
    },
  })
  const partial = await secondFails({
    agent: { session: { header: { cwd: root } } },
    rawInput: '-modules',
  })

  assert.equal(partial.kind, 'error', '第 2 次模型调用失败也应返回 error')
  assert.equal(calls, 2, '失败发生在第 2 次模型调用')
  assert.ok(
    partial.text.includes(`第 2/${batchCount} 批`),
    '任一批失败时回执应写明批次（第 2/3 批）',
  )
  assert.equal(await exists(join(root, 'AGENTS.md')), false, '两阶段写盘：根 AGENTS.md 不应被写出')
  assert.equal(
    await exists(join(root, 'packages/core/AGENTS.md')),
    false,
    '两阶段写盘：core 模块文档不应被写出',
  )
  assert.equal(
    await exists(join(root, 'packages/utils/AGENTS.md')),
    false,
    '两阶段写盘：utils 模块文档不应被写出',
  )
})

/** 16. 未注入模型：默认 generate 直接失败，不回退模板、不写文件。 */
test('未注入模型时返回 error 且不回退模板', async (t) => {
  const root = await makeRoot(t)
  await createFixture(root)

  const result = await createCodingInitHandler()({
    agent: { session: { header: { cwd: root } } },
    rawInput: '',
  })

  assert.equal(result.kind, 'error', '没有模型时应返回 error 回执')
  assert.ok(result.text.includes('模型'), '回执应说明缺少模型服务')
  assert.equal(await exists(join(root, 'AGENTS.md')), false, '不应回退成模板写盘')
})

/** 12. fs 服务：根文档不存在时用 createIfAbsent 新建，真实磁盘不动。 */
test('fs 服务：生成分支用 createIfAbsent 写入且不落真实文件', async (t) => {
  const root = await makeRoot(t)
  await createFixture(root)
  const fake = createFakeFs()

  const handler = handlerWith({
    resolveFs: () => fake,
    getChangedFiles: async () => ({ ok: true, files: ['package.json'], baseline: 'tag:v1' }),
  })
  const result = await handler({ agent: { session: { header: { cwd: root } } }, rawInput: '' })

  assert.equal(result.kind, 'success', '生成分支应成功')
  const creates = fake.writes.filter((write) => write.expected?.kind === 'createIfAbsent')
  assert.ok(creates.length >= 1, '至少应有一次 createIfAbsent 写入')
  assert.equal(creates[0].key, join(root, 'AGENTS.md'), '写入目标应是根 AGENTS.md')
  assert.ok(creates[0].content.startsWith('# AGENTS.md'), '写进服务的内容应是渲染出的项目级文档')
  assert.equal(
    await exists(join(root, 'AGENTS.md')),
    false,
    '写入应走 fs 服务，真实磁盘不应生成 AGENTS.md',
  )
  assert.ok(
    fake.writes.every((write) => write.policy === undefined),
    '没有 resolvePolicy 时不应凭空传策略',
  )
})

/** 12. fs 服务：写盘时透传本会话的沙箱策略。 */
test('fs 服务：writeText 收到 resolvePolicy 解析出的沙箱策略', async (t) => {
  const root = await makeRoot(t)
  await createFixture(root)
  const fake = createFakeFs()
  const policy = { mode: 'workspace-write', workspaceRoot: root }

  const handler = handlerWith({
    resolveFs: () => fake,
    resolvePolicy: async () => policy,
  })
  const result = await handler({ agent: { session: { header: { cwd: root } } }, rawInput: '' })

  assert.equal(result.kind, 'success', '生成分支应成功')
  assert.ok(fake.writes.length >= 1, '应至少写入一次')
  assert.deepEqual(fake.writes[0].policy, policy, 'writeText 第 5 个参数应是被解析出的沙箱策略')
})

/** 12. fs 服务：根文档已存在时用 replaceIfVersion 带版本覆盖。 */
test('fs 服务：已有文档用 replaceIfVersion 守卫更新', async (t) => {
  const root = await makeRoot(t)
  await createFixture(root)
  const docPath = join(root, 'AGENTS.md')
  const existing = '# 手写文档\n\n## 快速开始\n\n人工写的旧步骤\n\n## 项目背景\n\n人工背景\n'
  const fake = createFakeFs(new Map([[docPath, existing]]))

  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  manifest.scripts.lint = 'eslint .'
  await putFile(root, 'package.json', jsonText(manifest))

  const handler = handlerWith({
    resolveFs: () => fake,
    getChangedFiles: async () => ({ ok: true, files: ['package.json'], baseline: 'tag:v1' }),
  })
  const result = await handler({ agent: { session: { header: { cwd: root } } }, rawInput: '-update' })

  assert.equal(result.kind, 'success', '-update 应成功')
  const replaces = fake.writes.filter((write) => write.expected?.kind === 'replaceIfVersion')
  assert.ok(replaces.length >= 1, '已存在文档应走 replaceIfVersion')
  assert.equal(replaces[0].expected.version, 'v1', '守卫版本应来自 stat 读到的版本')
  assert.ok(
    (sectionBody(replaces[0].content, '快速开始') ?? '').includes('lint'),
    '写回的内容应带上新增的 lint 脚本',
  )
  assert.equal(await exists(docPath), false, '真实磁盘上本没有 AGENTS.md，也不应被创建')
})

/** 12. fs 服务：写守卫报 FS_STALE_VERSION 时收成可读回执，不向外抛错。 */
test('fs 服务：FS_STALE_VERSION 收成错误回执而不抛错', async (t) => {
  const root = await makeRoot(t)
  await createFixture(root)
  const fake = createFakeFs()
  fake.writeText = async () => {
    throw Object.assign(new Error('stale'), { code: 'FS_STALE_VERSION' })
  }

  const handler = handlerWith({ resolveFs: () => fake })
  let result
  await assert.doesNotReject(async () => {
    result = await handler({ agent: { session: { header: { cwd: root } } }, rawInput: '' })
  }, 'handler 不应把 FS_STALE_VERSION 抛给调用方')

  assert.ok(result !== undefined, 'handler 应返回回执对象')
  assert.equal(result.kind, 'error', '版本过期应返回 error 回执')
  assert.match(result.text, /FS_STALE_VERSION|被修改/u, '回执应提示文件在生成期间被修改')
  assert.equal(await exists(join(root, 'AGENTS.md')), false, '失败时不应写真实文件')
})

/** 13. 回归：工作区根取自 DSH 契约字段 `agent.session.header.cwd`。 */
test('工作区根取自 agent.session.header.cwd', async (t) => {
  const root = await makeRoot(t)
  await createFixture(root)

  const result = await handlerWith()({
    agent: { session: { header: { cwd: root } } },
    rawInput: '',
  })

  assert.equal(result.kind, 'success', '生成分支应返回 success')
  assert.equal(
    await exists(join(root, 'AGENTS.md')),
    true,
    'AGENTS.md 应落在 session cwd 指向的目录',
  )
  assert.ok(
    (await readFile(join(root, 'AGENTS.md'), 'utf8')).startsWith('# AGENTS.md'),
    '写出的应是渲染出的项目级文档',
  )
})

/** 13. 回归：本地扫描放行 `.github/` 子树，其它点目录与排除目录仍然跳过。 */
test('getFilesModifiedSince：收录 .github/workflows 但继续排除其它点目录', async (t) => {
  const root = await makeRoot(t)
  await putFile(root, '.github/workflows/ci.yml', 'name: ci\non: push\n')
  await putFile(root, 'node_modules/x.js', 'module.exports = 1\n')
  await putFile(root, '.git/HEAD', 'ref: refs/heads/main\n')
  await putFile(root, '.vscode/settings.json', '{}\n')

  const result = await getFilesModifiedSince(root, Date.now() - 60_000)

  assert.ok(result.files.includes('.github/workflows/ci.yml'), 'CI 改动应被收录')
  assert.ok(!result.files.includes('node_modules/x.js'), 'node_modules 仍应排除')
  assert.ok(!result.files.includes('.git/HEAD'), '.git 仍应排除')
  assert.ok(!result.files.includes('.vscode/settings.json'), '其它点目录仍应排除')
})

/** 13. 回归：非 git 项目里后加的 CI 改动能触发「验收标准」章节更新。 */
test('-update 在非 git 项目里识别 .github/workflows 的改动', async (t) => {
  const root = await makeRoot(t)
  await createFixture(root)
  const agent = { session: { header: { cwd: root } } }

  // 只注入 git 判定为“非仓库”，modifiedSince 走真实的 mtime 扫描。
  const handler = handlerWith({
    getChangedFiles: async () => ({ ok: false, files: [], reason: 'not a git repository' }),
  })

  // 第一次 -update：此时还没有 AGENTS.md，降级为生成。
  const first = await handler({ agent, rawInput: '-update' })
  assert.equal(first.kind, 'success', '首次 -update 应生成文档')
  const docPath = join(root, 'AGENTS.md')
  const doc1 = await readFile(docPath, 'utf8')
  assert.ok(
    !(sectionBody(doc1, '验收标准') ?? '').includes('.github/workflows/ci.yml'),
    '生成时 CI 文件还不存在，不应出现在「验收标准」里',
  )

  // 之后才出现 CI 文件：它比根文档晚，应被本地 mtime 扫描收录。
  const ciPath = await putFile(root, '.github/workflows/ci.yml', 'name: ci\non: push\n')
  // 显式把 mtime 推后一秒：避免与刚写出的 AGENTS.md 落在同一毫秒而被判成“不晚于基线”。
  const later = new Date(Date.now() + 1000)
  await utimes(ciPath, later, later)

  const second = await handler({ agent, rawInput: '-update' })

  assert.equal(second.kind, 'success', '-update 应成功')
  assert.match(second.text, /已更新/u, '回执应说明文档已更新')
  const doc2 = await readFile(docPath, 'utf8')
  assert.notEqual(sectionBody(doc2, '验收标准'), sectionBody(doc1, '验收标准'), '「验收标准」章节应变化')
  assert.ok(
    (sectionBody(doc2, '验收标准') ?? '').includes('.github/workflows/ci.yml'),
    '「验收标准」应写入 CI 文件路径',
  )
})

/** 13. 回归：本地扫描被截断时回执要明说，不能静默丢掉其余文件。 */
test('本地扫描截断时回执出现截断提示', async (t) => {
  const root = await makeRoot(t)
  await createFixture(root)
  await putFile(root, 'AGENTS.md', '# 手写文档\n\n## 快速开始\n\n人工写的旧步骤\n')

  const handler = handlerWith({
    getChangedFiles: async () => ({ ok: false, files: [], reason: 'not a git repository' }),
    modifiedSince: async () => ({ files: ['package.json'], truncated: true }),
  })
  const result = await handler({
    agent: { session: { header: { cwd: root } } },
    rawInput: '-update',
  })

  assert.equal(result.kind, 'success', '截断不应让命令失败')
  assert.match(result.text, /截断/u, '回执应包含「截断」字样')
  assert.ok(
    result.text.includes('仅比对前 1 个文件'),
    '回执应说明只比对了前 files.length 个文件',
  )
})

/** 14. 源码枚举：只收源码扩展名，跳过排除目录与点目录，结果排序且不抛错。 */
test('listSourceFiles：只返回源码文件并跳过 node_modules / dist / .git / docs', async (t) => {
  const root = await makeRoot(t)
  await putFile(root, 'src/a.ts', 'export const a = 1\n')
  await putFile(root, 'src/b.js', 'module.exports = 2\n')
  await putFile(root, 'node_modules/x/y.js', 'module.exports = 3\n')
  await putFile(root, 'dist/z.ts', 'export const z = 4\n')
  await putFile(root, '.git/q.ts', 'export const q = 5\n')
  await putFile(root, 'docs/r.md', '# r\n')

  const result = await listSourceFiles(root)

  assert.deepEqual(result.files, ['src/a.ts', 'src/b.js'], '只留源码扩展名，且按字典序排序')
  assert.equal(result.truncated, false, '未超过 maxFiles 时不应截断')

  const shallow = await listSourceFiles(root, { depth: 1 })
  assert.deepEqual(shallow.files, [], 'depth 限制在根目录时不应下探 src')
})

/** 14. 源码枚举的有界与不抛错：maxFiles 截断、空目录、不存在的 root。 */
test('listSourceFiles：maxFiles 截断且空目录/不存在的 root 不抛错', async (t) => {
  const root = await makeRoot(t)
  await putFile(root, 'src/a.ts', 'export const a = 1\n')
  await putFile(root, 'src/b.js', 'module.exports = 2\n')

  const limited = await listSourceFiles(root, { maxFiles: 1 })
  assert.equal(limited.files.length, 1, 'maxFiles 为 1 时只返回 1 个文件')
  assert.equal(limited.truncated, true, '还有候选文件未收录时应置 truncated')

  const empty = await makeRoot(t)
  assert.deepEqual(await listSourceFiles(empty), { files: [], truncated: false }, '空目录返回空结果')
  assert.deepEqual(
    await listSourceFiles(join(empty, 'nope')),
    { files: [], truncated: false },
    '不存在的 root 返回空结果且不抛错',
  )
})

/** 14. excerptOf：短文本原样返回，超长文本带截断标记且不超过上限。 */
test('excerptOf：按字符上限截断并追加截断标记', () => {
  assert.equal(excerptOf('short text'), 'short text', '未超限时原样返回')

  const cut = excerptOf('a'.repeat(100), 20)
  assert.ok(cut.length <= 20, '截断结果不超过 maxChars')
  assert.ok(cut.endsWith(DOC_CONTEXT_TRUNCATED_MARK), '截断结果以截断标记结尾')
  assert.equal(
    cut,
    `${'a'.repeat(20 - DOC_CONTEXT_TRUNCATED_MARK.length)}${DOC_CONTEXT_TRUNCATED_MARK}`,
    '标记本身也占预算',
  )

  const defaultCut = excerptOf('b'.repeat(DOC_CONTEXT_EXCERPT_CHARS + 10))
  assert.equal(defaultCut.length, DOC_CONTEXT_EXCERPT_CHARS, '默认上限是 DOC_CONTEXT_EXCERPT_CHARS')
  assert.ok(defaultCut.endsWith(DOC_CONTEXT_TRUNCATED_MARK), '默认上限同样追加标记')
})

/** 14. 提示词组装 helper：真实扫描事实 + 真实文件，读文件走注入的 readFile。 */
async function promptFixture(root) {
  await createFixture(root)
  await putFile(root, 'src/app.ts', 'export const app = true\n')
  await putFile(root, 'docs/guide.md', '# 指南\n\n使用说明。\n')
  const facts = await scanProject(root)
  const sourceFiles = (await listSourceFiles(root)).files
  const readText = async (relPath) => await readFile(join(root, relPath), 'utf8')
  return { facts, sourceFiles, readText }
}

/** 14. project-create：草稿与摘录齐全，system 只把章节当参考、要求省略并禁用占位符。 */
test('buildDocPrompt：project-create 组装草稿、摘录与章节表', async (t) => {
  const root = await makeRoot(t)
  const { facts, sourceFiles, readText } = await promptFixture(root)

  const prompt = await buildDocPrompt({
    kind: 'project-create',
    facts,
    sourceFiles,
    readFile: readText,
  })

  assert.match(prompt.user, /## 项目事实与确定性草稿/u, 'user 应包含确定性草稿段')
  assert.match(prompt.user, /## 代码与文档摘录/u, 'user 应包含代码与文档摘录段')
  assert.ok(prompt.user.includes('### src/app.ts'), '源码摘录应以 ### <relative path> 出现')
  assert.ok(prompt.user.includes('### docs/guide.md'), 'docs 文档也应进入摘录')
  assert.ok(prompt.user.includes('packages/core/src/index.ts'), '模块入口应作为摘录候选')
  assert.ok(!prompt.user.includes('## 现有文档正文'), '新建时不应出现现有文档段')
  assert.ok(!prompt.user.includes('## 变更文件列表'), '没有变更时不出现变更文件列表')
  assert.ok(
    !prompt.user.includes(TODO_PLACEHOLDER),
    '参考草稿要先清掉占位符，绝不把占位符交给模型',
  )
  assert.ok(!prompt.user.includes('待补充'), 'user 里不应残留「待补充」字样')

  assert.match(prompt.system, /只输出 Markdown 正文/u, 'system 应约束只输出正文')
  assert.ok(prompt.system.includes(String(MAX_DOC_LINES)), 'system 应写明 150 行上限')
  assert.ok(prompt.system.includes('参考'), 'system 应说明章节清单只是参考')
  assert.ok(prompt.system.includes('省略'), 'system 应要求材料不足时省略章节')
  assert.ok(prompt.system.includes('占位符'), 'system 应禁止写占位符')
  assert.ok(prompt.system.includes('模块索引'), 'system 应说明模块索引由插件回写')

  // 「TODO: 待补充」只允许出现在「禁止占位符」那一条规则里，不再要求逐字照抄章节表。
  const placeholderRule = prompt.system
    .split('\n')
    .find((line) => line.includes('TODO: 待补充'))
  assert.ok(placeholderRule !== undefined, 'system 只用一条规则提到占位符字样')
  assert.ok(placeholderRule.includes('绝不写'), '提到占位符的那条规则必须是禁止语气')
})

/** 14. project-update：带现有文档与变更列表，changedFiles 优先。 */
test('buildDocPrompt：project-update 带现有文档与变更文件列表', async (t) => {
  const root = await makeRoot(t)
  const { facts, sourceFiles, readText } = await promptFixture(root)

  const prompt = await buildDocPrompt({
    kind: 'project-update',
    facts,
    existingDoc: '# AGENTS.md — demo\n\n## 快速开始\n\n人工写的旧步骤\n',
    changedFiles: ['src/app.ts'],
    sourceFiles,
    readFile: readText,
  })

  assert.match(prompt.user, /## 现有文档正文/u, '更新时应放入现有文档')
  assert.ok(prompt.user.includes('人工写的旧步骤'), '现有文档应逐字放入')
  assert.match(prompt.user, /## 变更文件列表/u, '更新时应列出变更文件')
  assert.ok(prompt.user.includes('src/app.ts'), '变更文件列表应包含变更文件名')
  assert.ok(
    prompt.user.indexOf('### src/app.ts') < prompt.user.indexOf('### packages/core/src/index.ts'),
    'changedFiles 应优先于模块入口进入摘录',
  )
  assert.match(prompt.system, /只输出需要修改的章节/u, '更新时 system 应要求只输出受影响章节')
})

/** 14. module：user 有「## 模块」段与模块路径，章节表来自 MODULE_SECTIONS。 */
test('buildDocPrompt：module 写入模块路径并优先本模块文件', async (t) => {
  const root = await makeRoot(t)
  const { facts, sourceFiles, readText } = await promptFixture(root)
  const module = facts.modules.find((item) => item.path === 'packages/core')
  assert.ok(module !== undefined, 'fixture 应扫描出 packages/core 模块')

  const prompt = await buildDocPrompt({
    kind: 'module',
    facts,
    module,
    sourceFiles,
    readFile: readText,
  })

  assert.match(prompt.user, /## 模块/u, '模块级 user 必须有「## 模块」段')
  assert.ok(prompt.user.includes('packages/core'), 'user 里必须出现模块路径')
  assert.match(prompt.user, /## 项目事实与确定性草稿/u, '模块文档同样使用草稿段标题')
  assert.ok(prompt.user.includes('### packages/core/src/index.ts'), '本模块入口应进入摘录')
  for (const title of MODULE_SECTIONS) {
    assert.ok(prompt.system.includes(title), `章节表应逐字包含「${title}」`)
  }
  assert.ok(!prompt.system.includes('快速开始'), '模块级章节表不应含项目级章节')
})

/** 14. 上限：大量长源码与超长 README 时 user 不超过 DOC_CONTEXT_TOTAL_LIMIT。 */
test('buildDocPrompt：超长材料被硬截断到 DOC_CONTEXT_TOTAL_LIMIT', async (t) => {
  const root = await makeRoot(t)
  await putFile(
    root,
    'package.json',
    jsonText({ name: 'big-demo', version: '0.1.0', scripts: { test: 'node --test' } }),
  )
  const chunk = `${'const value = 1\n'.repeat(200)}\n`
  for (let index = 0; index < 25; index += 1) {
    await putFile(root, `src/gen-${index}.ts`, chunk)
  }
  // 超过 10 万字符的单个源码文件：摘录必须按 DOC_CONTEXT_EXCERPT_CHARS 截断。
  await putFile(root, 'src/huge.ts', `${'const huge = 1\n'.repeat(8000)}\n`)
  await putFile(root, 'README.md', `# Demo\n\n${'很长的说明文字 '.repeat(20000)}\n`)
  await putFile(root, 'docs/long.md', `# 长文档\n\n${'说明 '.repeat(30000)}\n`)

  const facts = await scanProject(root)
  const sourceFiles = (await listSourceFiles(root)).files
  const readText = async (relPath) => await readFile(join(root, relPath), 'utf8')

  const prompt = await buildDocPrompt({
    kind: 'project-create',
    facts,
    sourceFiles,
    readFile: readText,
  })

  assert.ok(
    prompt.user.length <= DOC_CONTEXT_TOTAL_LIMIT,
    `user.length 应不超过 ${DOC_CONTEXT_TOTAL_LIMIT}`,
  )
  assert.ok(prompt.user.endsWith(DOC_CONTEXT_TRUNCATED_MARK), '硬截断后文末应有截断标记')
})

/** 14. 读文件失败只跳过该文件，不影响其余摘录。 */
test('buildDocPrompt：readFile 抛错时跳过该文件', async (t) => {
  const root = await makeRoot(t)
  const { facts, sourceFiles, readText } = await promptFixture(root)

  const prompt = await buildDocPrompt({
    kind: 'project-create',
    facts,
    sourceFiles,
    readFile: async (relPath) => {
      if (relPath === 'src/app.ts') throw new Error('EACCES')
      return await readText(relPath)
    },
  })

  assert.ok(!prompt.user.includes('### src/app.ts'), '读失败的文件不应出现摘录段')
  assert.ok(prompt.user.includes('packages/core/src/index.ts'), '其余文件仍应进入摘录')
})

/** 15. 模型章节解析：只认 `##` 且有正文，占位符整行删除，`###` 与前言都不产生章节。 */
test('parseModelSections：只取有正文的 ## 章节', () => {
  const text = [
    '这是模型的前言，应该被丢弃。',
    '',
    '## 快速开始',
    '',
    '- 安装：`pnpm install`',
    '',
    '### 子标题',
    '',
    '子标题的正文',
    '',
    '## 空章节',
    '',
    '## 项目背景',
    '背景正文',
    '',
    '<!-- TODO: 待补充 -->',
  ].join('\n')

  const sections = parseModelSections(text)

  assert.deepEqual(
    sections.map((item) => item.title),
    ['快速开始', '项目背景'],
    '应只保留有正文的 ## 章节，前言与空 body 章节被丢弃',
  )
  assert.ok(
    !sections.some((item) => item.title === '子标题'),
    '`###` 不产生章节',
  )
  assert.ok(sections[0].raw.includes('### 子标题'), '`###` 子标题留在所属章节的原文里')
  assert.ok(!sections[0].raw.startsWith('这是模型的前言'), '第一个 ## 之前的前言不应进入章节原文')
  assert.ok(
    !sections.some((item) => item.raw.includes(TODO_PLACEHOLDER)),
    `含 ${TODO_PLACEHOLDER} 的整行应被删除`,
  )
  assert.ok(!sections.some((item) => item.raw.includes('待补充')), '解析结果不应残留占位符字样')
  assert.ok(sections[1].raw.includes('背景正文'), '占位符旁边的真实正文应保留')
})

/** 15. 模型章节合并：只替换允许集合里的已有标题，其余逐字保留，新标题追加到末尾。 */
test('applyModelSections：只改白名单章节，其余章节原文逐字保留', () => {
  const skeleton = [
    '# AGENTS.md — demo',
    '',
    '## 快速开始',
    '',
    '人工写的旧步骤',
    '',
    '## 项目背景',
    '',
    '人工背景',
    '',
    '## 项目目标',
    '',
    '<!-- TODO: 待补充 -->',
    '',
  ].join('\n')
  const modelText = [
    '先说明一句，这一行是前言。',
    '',
    '## 快速开始',
    '',
    '- 安装：`pnpm install`',
    '',
    '## 不存在的章节',
    '',
    '模型自己编的章节',
    '',
    '## 项目背景',
    '',
    '模型乱改的背景',
    '',
    '## 安全须知',
    '',
    '不要提交密钥。',
    '',
  ].join('\n')

  const result = applyModelSections(skeleton, modelText, ['快速开始'])

  assert.deepEqual(
    result.applied,
    ['快速开始', '不存在的章节', '安全须知'],
    '被替换的旧标题按模型顺序在前，新标题按模型顺序追加',
  )
  assert.ok(result.dropped.includes('项目背景'), '不在允许集合里的已有标题应记入 dropped')

  const before = new Map(splitSections(skeleton).sections.map((item) => [item.title, item.raw]))
  const after = new Map(splitSections(result.text).sections.map((item) => [item.title, item.raw]))

  assert.ok((after.get('快速开始') ?? '').includes('pnpm install'), '「快速开始」应换成模型正文')
  assert.ok(
    !(after.get('快速开始') ?? '').includes('人工写的旧步骤'),
    '「快速开始」的旧正文应被替换',
  )
  assert.equal(after.get('项目背景'), before.get('项目背景'), '「项目背景」原文应逐字保留')
  assert.ok(after.has('不存在的章节'), '模型新造的标题应被追加，而不是丢弃')
  assert.ok(
    (after.get('不存在的章节') ?? '').includes('模型自己编的章节'),
    '追加的新章节应保留模型正文',
  )
  assert.ok(!after.has('项目目标'), '正文只剩占位符的「项目目标」应整节移除')
  assert.equal(
    splitSections(result.text).sections.at(-1)?.title,
    '安全须知',
    '骨架里没有的标题应按模型顺序追加到末尾',
  )
  assert.ok(!result.text.includes('前言'), '模型前言不应进入文档')
  assert.ok(!result.text.includes('模型乱改的背景'), '不允许替换的章节不应写入模型正文')
  assert.ok(!result.text.includes('TODO'), '合并结果不应残留 TODO')
  assert.ok(!result.text.includes('待补充'), '合并结果不应残留占位符')
})

/** 15. 模型章节合并：没有可用 `##` 章节时原样返回骨架，一个字符都不动。 */
test('applyModelSections：模型没有 ## 章节时原样返回骨架', () => {
  const skeleton = '# AGENTS.md — demo\n\n## 快速开始\n\n人工写的旧步骤\n'

  const result = applyModelSections(skeleton, '模型只回了一段没有章节的文字。', PROJECT_SECTIONS)

  assert.deepEqual(result.applied, [], '没有可应用章节时 applied 为空')
  assert.deepEqual(result.dropped, [], '没有 ## 章节时 dropped 也为空')
  assert.equal(result.text, skeleton, '文本应与骨架逐字相同')

  // 有 `##` 标题但清洗后没有正文，也按「无可用章节」处理。
  const emptyModel = applyModelSections(skeleton, '## 只有标题\n\n<!-- TODO: 待补充 -->\n', ['快速开始'])
  assert.equal(emptyModel.text, skeleton, '模型章节清洗后为空时同样原样返回骨架')
  assert.deepEqual(emptyModel.applied, [], '清洗后无正文时 applied 为空')
  assert.deepEqual(emptyModel.dropped, [], '清洗后无正文时 dropped 也为空')
})

/** 15. 模型章节合并：超长正文合并后仍受 MAX_DOC_LINES 约束。 */
test('applyModelSections：超长正文合并后行数不超过 MAX_DOC_LINES', () => {
  const skeleton = '# AGENTS.md — demo\n\n## 快速开始\n\n旧步骤\n\n## 项目背景\n\n人工背景\n'
  const longBody = Array.from({ length: 260 }, (_, index) => `- 第 ${index} 行`).join('\n')

  const result = applyModelSections(skeleton, `## 快速开始\n\n${longBody}\n`, PROJECT_SECTIONS)

  assert.deepEqual(result.applied, ['快速开始'], '超长正文仍应被应用')
  assert.ok(
    result.text.split('\n').length <= MAX_DOC_LINES,
    `合并结果行数应不超过 ${MAX_DOC_LINES}`,
  )
})

/** 15. 假 llm：按需回放块序列，或在 prepareCall / 流迭代里抛错。 */
function createFakeLlm({ chunks = [], prepareError, streamError } = {}) {
  const prepareCalls = []
  const streamCalls = []
  return {
    prepareCalls,
    streamCalls,
    async prepareCall(requestConfig, signal) {
      prepareCalls.push({ config: requestConfig, signal })
      if (prepareError !== undefined) throw new Error(prepareError)
      return {
        config: { ...requestConfig },
        async *stream(request) {
          streamCalls.push(request)
          if (streamError !== undefined) throw new Error(streamError)
          for (const chunk of chunks) yield chunk
        },
      }
    },
  }
}

/** 断言 generateDoc 收成失败结果：不抛错，reason / action 都是可读文案。 */
async function expectDocFailure(request, pattern) {
  let result
  await assert.doesNotReject(async () => {
    result = await generateDoc(request)
  }, 'generateDoc 不应把异常抛给调用方')
  assert.ok(result !== undefined, 'generateDoc 应返回结果对象')
  assert.equal(result.ok, false, '失败路径应返回 ok:false')
  assert.equal(typeof result.reason, 'string', 'reason 应是字符串')
  assert.ok(result.reason.length > 0, 'reason 应是可读文案')
  assert.match(result.reason, pattern, `reason 应说明 ${String(pattern)}`)
  assert.equal(typeof result.action, 'string', 'action 应是字符串')
  assert.ok(result.action.length > 0, 'action 应给出下一步动作')
  return result
}

/** 15. generateDoc 成功路径：prepareCall 入参、stream 请求与 BlockAssembler 组装。 */
test('generateDoc：用本会话模型路由组装正文并回带 route', async () => {
  const system = '你是文档助手，只输出 Markdown 正文。'
  const user = '## 项目事实与确定性草稿\n\n- 包 `demo`'
  const agent = { model: { current: () => ({ provider: 'p', model: 'm' }) } }
  const llm = createFakeLlm({
    chunks: [
      { type: 'text-delta', index: 0, text: '## 快速开始' },
      { type: 'text-delta', index: 0, text: '\n\n- 安装：`pnpm install`' },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  })

  const result = await generateDoc({ agent, llm, system, user })

  assert.equal(result.ok, true, '正常结束应返回 ok:true')
  assert.equal(
    result.text,
    '## 快速开始\n\n- 安装：`pnpm install`',
    '正文按块的顺序拼接后 trim',
  )
  assert.equal(result.route, 'p/m', 'route 应写成 provider/model')

  assert.equal(llm.prepareCalls.length, 1, 'prepareCall 只调用一次')
  assert.deepEqual(
    llm.prepareCalls[0].config,
    { provider: 'p', model: 'm', maxTokens: 8000 },
    'prepareCall 应收到 {provider, model, maxTokens: 8000}',
  )

  assert.equal(llm.streamCalls.length, 1, 'stream 只派发一次')
  const streamRequest = llm.streamCalls[0]
  assert.equal(streamRequest.provider, 'p', 'stream 的 provider 应与 prepared.config 一致')
  assert.equal(streamRequest.model, 'm', 'stream 的 model 应与 prepared.config 一致')
  assert.equal(streamRequest.maxTokens, 8000, 'stream 沿用 prepared.config 的 maxTokens')
  assert.equal(streamRequest.system, system, 'system 应原样透传')
  assert.ok(
    Array.isArray(streamRequest.messages) && streamRequest.messages.length > 0,
    'messages 不应为空',
  )
  assert.equal(streamRequest.messages[0].content[0].text, user, 'user 文本应进入 messages')
})

/** 15. generateDoc：显式 maxTokens 覆盖默认值。 */
test('generateDoc：maxTokens 显式给出时覆盖默认 8000', async () => {
  const agent = { model: { current: () => ({ provider: 'p', model: 'm' }) } }
  const llm = createFakeLlm({
    chunks: [
      { type: 'text-delta', index: 0, text: '正文' },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  })

  const result = await generateDoc({ agent, llm, system: 's', user: 'u', maxTokens: 4096 })

  assert.equal(result.ok, true, '显式上限不影响成功路径')
  assert.equal(llm.prepareCalls[0].config.maxTokens, 4096, 'prepareCall 应收到显式上限')
})

/** 15. generateDoc：宿主/模型/prepareCall/流/结束原因/空正文的失败全部收成 ok:false，且不回退为模板。 */
test('generateDoc：宿主、模型、流与正文的失败都收成 ok:false', async () => {
  const agent = { model: { current: () => ({ provider: 'p', model: 'm' }) } }
  const noModel = { model: {} }

  const noLlm = await expectDocFailure(
    { agent, llm: undefined, system: 's', user: 'u' },
    /模型服务/u,
  )
  assert.match(noLlm.action, /DSH/u, '缺模型服务时应提示升级/重启 DSH')

  await expectDocFailure(
    { agent: noModel, llm: createFakeLlm(), system: 's', user: 'u' },
    /读不到本会话当前模型/u,
  )

  await expectDocFailure(
    { agent, llm: createFakeLlm({ prepareError: 'prepare boom' }), system: 's', user: 'u' },
    /prepare boom/u,
  )

  await expectDocFailure(
    {
      agent,
      llm: createFakeLlm({
        chunks: [
          {
            type: 'finish',
            reason: { kind: 'error', failure: { message: 'rate limited by provider', code: 'AUTH' } },
          },
        ],
      }),
      system: 's',
      user: 'u',
    },
    /rate limited by provider/u,
  )

  await expectDocFailure(
    { agent, llm: createFakeLlm({ streamError: 'stream boom' }), system: 's', user: 'u' },
    /stream boom/u,
  )

  await expectDocFailure(
    {
      agent,
      llm: createFakeLlm({
        chunks: [
          { type: 'text-delta', index: 0, text: '   \n' },
          { type: 'finish', reason: { kind: 'stop' } },
        ],
      }),
      system: 's',
      user: 'u',
    },
    /没有返回内容/u,
  )

  await expectDocFailure(
    {
      agent,
      llm: createFakeLlm({ chunks: [{ type: 'finish', reason: { kind: 'max-tokens' } }] }),
      system: 's',
      user: 'u',
    },
    /max-tokens/u,
  )
})

/** 15. 约束：doc-model.ts 不 import node:fs，文档模型层不碰磁盘。 */
test('doc-model.ts 不 import node:fs', async () => {
  const source = await readFile(new URL('../src/lib/doc-model.ts', import.meta.url), 'utf8')

  assert.ok(!source.includes('node:fs'), 'src/lib/doc-model.ts 不得出现 node:fs')
  assert.ok(!source.includes("from 'node:"), 'src/lib/doc-model.ts 不得 import 内置模块')
})
