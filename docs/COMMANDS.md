# `/coding` 命令使用指南

`/coding` 只在 Coding 预设会话里注册。它管四件事：看状态、切模式与阶段、重置验证预算、写读交接文档；另外能生成或更新项目级、模块级 `AGENTS.md`。本文件只讲怎么敲、敲完看到什么、报错怎么办。设计原理见 [设计思路与分层结构](DETAIL.md)。

## 前提

敲任何 `/coding` 子命令前，先确认三件事：

- 会话选中了 **Coding** 预设。其它会话执行任何子命令，回执都是 `本会话没有运行 dsh-coding 预设。`
- 命令只改当前会话的状态机：模式、阶段、任务单、验证预算、交接记录。换会话不继承。
- 子命令匹配不区分大小写，实现先把整行转小写再匹配；`init` 只看行首是不是 `init`。

## 语法总览

| 命令                                | 作用                                                       | 是否影响当前轮 |
| ----------------------------------- | ---------------------------------------------------------- | -------------- |
| `/coding`                           | 查看状态行与阶段路径                                       | 否             |
| `/coding auto\|consult\|review\|codex` | 切换模式，并经 `agent.followup()` 新开一轮              | 是             |
| `/coding set <模式>`                | 静默设置模式，不启动新一轮（卡片按钮与首页选择器使用）     | 否             |
| `/coding stage <阶段>`              | 在当前轮内推进阶段，经 `agent.steer()` 生效                | 否             |
| `/coding reset`                     | 重置验证重试预算                                           | 否             |
| `/coding memory`                    | 写出本轮任务交接文档到项目根 `.agents/memory`              | 否             |
| `/coding memory open [关键词]`      | 从 `.agents/memory` 载入最新一篇交接文档并注入本会话       | 否             |
| `/coding init [-update] [-modules]` | 后台用本会话当前模型生成或更新项目级、模块级 `AGENTS.md`   | 否（后台执行） |

- 模式取值：`auto`、`consult`、`review`、`codex`。
- 阶段取值：`requirements`、`plan`、`implement`、`verify`、`deliver`。
- 命令的 input hint 是固定语法串：`auto | consult | review | codex | set <auto|consult|review|codex> | stage <requirements|plan|implement|verify|deliver> | reset | memory | memory open [keyword] | init [-update] [-modules]`。

## 查看状态

用法：不带参数敲 `/coding`。

会看到两行：状态行、阶段路径。

```
stage verify of requirements → plan → implement → verify → deliver; mode codex | plan 2/4 done | verification FAILED (test/package, exit 1, attempt 2) | handoff goal=set, acceptance=3 | files changed 5
阶段路径: requirements → plan → implement → verify → deliver
```

状态行由 `|` 分隔，各字段含义：

| 字段                                                   | 含义                                              |
| ------------------------------------------------------ | ------------------------------------------------- |
| `stage <阶段> of <模式阶段路径>; mode <模式>`          | 当前阶段与模式，以及该模式的完整阶段路径          |
| `plan none` / `plan X/Y done`                          | 没有任务单，或已完成条目数/总条目数               |
| `verification not run`                                 | 尚未验证                                          |
| `verification passed (<kind>/<scope>, <ms>ms)`         | 最近一次验证通过                                  |
| `verification FAILED (<kind>/<scope>, exit <码>, attempt <N>)` | 最近一次验证失败与该轮尝试次数          |
| `verification BLOCKED after <N> attempts`              | 验证预算耗尽，阶段已被阻塞                        |
| `handoff goal=set\|missing, acceptance=<N>`            | 交接记录里是否已有目标、验收标准条数              |
| `files changed <N>`                                    | 本会话记录到的改动文件数                          |
| `delivery BLOCKED`                                     | 仅 deliver 阶段且预算耗尽时出现                   |
| `failure <point>`                                      | 最近一次阻断性异常的环节（恢复成功后消失）        |
| `<role>-worker <status>` / `planner <outcome>`         | 最近一次 worker 派发或 planner 派发结果           |

## 切换模式

用法：`/coding codex` 或 `/coding set codex`。把 `codex` 换成 `auto`、`consult`、`review` 是同样的写法。

- `/coding codex`：设置模式，按新模式的阶段表裁剪工具，再注入一条控制消息新开一轮。
- `/coding set codex`：只静默设置模式，不启动新一轮、不注入消息。卡片按钮与首页选择器走这条。

两种写法的回执相同：`模式已设为 codex；<状态行>`。

模式名不存在时回执：`未知模式 "<输入>"；可用值：auto, consult, review, codex`。照可用值改掉 `<输入>` 重试。

## 推进阶段

用法：`/coding stage implement`。把 `implement` 换成上面列出的任意阶段是同样的写法。

先过 `checkAdvance` 门禁。通过后设置阶段、重算工具表，并用 `agent.steer()` 把该阶段的契约注入当前轮。

成功回执：`阶段已设为 implement；<状态行>`。

门禁不放行时回执：`阶段请求被拒绝：<reason>`。`<reason>` 是门禁原文，通常是英文，不翻译；按它补齐前置条件后重试。用户手动推进本身不会额外触发拦截。

阶段名不存在时回执：`未知阶段 "<输入>"；可用值：requirements, plan, implement, verify, deliver`。

验证预算已耗尽时，手动推进到 `deliver` 仍按 BLOCKED 交付处理，状态行带 `delivery BLOCKED`。要放行，先用 `/coding reset` 重置预算，再让验证通过。

## 重置验证预算

用法：`/coding reset`。

回执：`验证重试预算已重置；<状态行>`。

重置只清预算。交接记录与最近一次验证结果保留。预算只有验证通过时才自动清零。

默认预算为 5 次失败、同一失败签名 2 次，由插件配置决定。这是防死循环的出口。

## 交接文档

### 写入：`/coding memory`

用法：`/coding memory`。

写到会话工作目录下的 `.agents/memory/`，文件名固定为 `<UTC YYYYMMDD-HHmmss>-<清洗后的会话标题>.md`。时间在前，按名字排序即时间序；已有同名文件不覆盖。

内容只取状态机与 `coding_handoff` 的交接记录：目标、约束、验收标准、交付记录、后续跟进、决策、发现、待答问题、任务清单、改动文件、验证、阶段轨迹。不回读对话正文。超过 20000 字符时截断到最后一个完整行并标注。

成功回执：`交接文档已写出：<path>（会话 <sessionId>）`。

失败回执是 `<原因> — <处理办法>`。常见原因：宿主没有 fs 服务、会话没有 cwd、写盘失败（如沙箱不允许）。按处理办法修好再敲一次。

### 读取：`/coding memory open [关键词]`

用法：`/coding memory open`，或带关键词 `/coding memory open 交接`。

取 `.agents/memory` 里文件名最大（即最新）的一篇。带关键词时先按文件名不区分大小写过滤；目录不存在按空存档处理。

成功回执：`已载入交接文档：<path>`。文档以只读存档快照注入当前会话，并声明实时状态以 `coding_handoff` 与状态机为准、不要重做已记录为交付的工作。它不改变 stage / mode，也不新增 Session 事件。

失败回执同样是 `<原因> — <处理办法>`，原因有五种：目录里没有交接文档、关键词没有匹配、宿主没有 fs 服务、会话没有 cwd、读盘失败。

## 生成或更新 `AGENTS.md`：`/coding init`

### 参数

用法：`/coding init`、`/coding init -update`、`/coding init -modules`。两个参数可以任意组合，顺序无关。

- `-update`：对已存在的项目级 `AGENTS.md` 做段落级增量更新，只重写受影响的章节，未受影响的章节逐字保留。不带 `-update` 且文档已存在时跳过，回执 `AGENTS.md 已存在，已跳过。如需更新请用 /coding init -update。`
- `-modules`：逐个模块生成或更新模块级 `AGENTS.md`。模块探测最多两级，`src/http/lib` 这类三级目录并入 `src/http`。模块文档带 `> 上级：[项目级 AGENTS.md](…)` 与「模块索引」表。
- 不带参数时：项目级文档不存在就生成，存在就跳过并提示 `-update`。

### 立即回执

敲下命令后只做轻量预检，其余在后台跑。五种情况的回执：

| 情况                             | 回执                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------ |
| 项目里没有任何源码文件           | `未检测到代码文件，已跳过：/coding init 需要项目里至少有一个源码文件。`（零操作、不调模型） |
| 读不到模型路由 / 会话没有可用模型 | 同步 error 回执，说明原因与处理办法                                                      |
| 正常提交                         | `已开始文档生成（后台执行；模型 <route>）。完成或失败后会在会话里反馈。`                   |
| 已有任务在跑                     | `已有一个文档生成任务在运行；完成或失败后会在这里反馈，请稍后再试。`                       |
| 宿主正忙，退回独立后台           | 在开始时回执后追加 `宿主正忙，已改用独立后台任务。`                                        |

### 后台通知

完成或失败后经 `agent.followup()` 再通知一次。

- 标题前缀是 `文档生成完成：` 或 `文档生成失败：`，末尾附 `（这是运行时回执，无需调用工具，也不要改动任何文件。）`。
- 失败通知含原因与处理办法。
- 模型按章节分批调用，每批至多 4 章，约 2-3k token。任一批失败整体失败、零写盘，原因前缀为 `第 N/M 批：`。

### 生成规则

- 文档正文只来自本会话当前模型：插件不套固定模板、不补写模型没返回的章节、不写占位符。模型失败或解析不出章节时不写任何文件，不用模板兜底。
- 书写风格：生成用的 system 提示词固定带六条书写风格规则（实现在 `src/docgen/doc-context.ts` 的 `buildSystemPrompt()`），这套写法是插件内置的，不需要用户配置。六条是：写给要接手这个仓库的人看、先写目标与可验收结果再写做法、说人话、每条规则给出理由或后果、不写「可能」「建议考虑」这类模糊表述、命令、路径与报错保持原文。
- 生成期间目标文件被外部修改，会以 `FS_STALE_VERSION` 拒绝覆盖，回执提示重试 `-update`。
- 非 git 仓库不用 diff，按 `AGENTS.md` 的修改时间比对出变更文件。
- 前置条件：会话已选模型、宿主提供 fs 服务、会话有工作目录。

## 语言

命令描述、input hint 与所有回执按会话语言输出中文或英文。

- 语言来源是插件 `language` 配置：`auto` 跟随 DSH 界面语言，其次系统语言，最后宿主 locale。
- 命令描述与 hint 在注册时定型。运行中切换界面语言，要重启 DSH 才会变。
- 回执在每次执行时按当前语言取文案。

## 排错速查

| 现象                               | 处理                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| `本会话没有运行 dsh-coding 预设。` | 切换到 Coding 预设后重试                                                               |
| `未知模式` / `未知阶段`            | 按回执里列出的可用值重试                                                               |
| `阶段请求被拒绝：<reason>`         | 按 reason 补齐前置条件（如先记录 goal / acceptance、先派发 planner），再推进            |
| `/coding memory` 失败              | 看回执的原因与处理办法：补 fs 服务、设置工作目录，或修复写盘错误后重试                  |
| `/coding memory open` 失败         | 确认 `.agents/memory` 有文档、关键词匹配文件名；必要时去掉关键词重试                    |
| `/coding init` 没有生成文档        | 先看立即回执（空项目 / 模型不可读 / 已在跑），再看后台「文档生成回执」的原因与处理办法 |
| 切换界面语言后命令描述没变         | 重启 DSH 后再看                                                                        |
