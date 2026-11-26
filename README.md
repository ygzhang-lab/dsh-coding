# DSH Coding 编程智能体

DSH Coding 是 DSH 的编程智能体插件，DSH 编程智能体插件，工程化任务编排机制，Codex 五段式契约层层推进，默认三个子代理跟随主代理当前模型（auto），可分别指定 planner/implement/verify 的模型，确保任务交付质量和 Token 价值最大化。DSH programming intelligent agent plugin, engineering task orchestration mechanism, Codex five-stage contract progressing layer by layer; the three sub-agents follow the lead's current model by default (auto), and the planner/implement/verify models can be set individually, ensuring task delivery quality and maximizing Token value.。

[![GitHub Repo stars](https://img.shields.io/github/stars/ygzhang-lab/dsh-coding?style=flat&logo=github)](https://github.com/ygzhang-lab/dsh-coding)
![GitHub License](https://img.shields.io/github/license/ygzhang-lab/dsh-coding)
[![NPM Version](https://img.shields.io/npm/v/dsh-coding)](https://www.npmjs.com/package/dsh-coding)
[![NPM Downloads](https://img.shields.io/npm/dy/dsh-coding)](https://www.npmjs.com/package/dsh-coding)
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/zh/plugins/ygzhang-lab/dsh-coding)



## 插件名和 NPM 包名

插件名是 `dsh-coding`，NPM 包名是 `dsh-coding`，在 DSH 中的插件显示名是 **DSH Coding**。源码与 issue 在 [ygzhang-lab/dsh-coding](https://github.com/ygzhang-lab/dsh-coding)。

## 什么时候适合用它

适合复杂任务开发/项目搭建/模块重构/Bug修复，或要跑测试或构建的工程任务：做完没做完有判断标准，验证要真实跑过。

不适合一句话问答。问一句答一句、查一段代码解释一下，用普通会话更快。

- 工程化流程：一次任务拆成 requirements → plan → implement → verify → deliver 五步，每步能不能往下走由插件判，不靠模型自觉说「做完了」。
- 交付质量：进入实现要有任务单，进入验证要有落盘编辑，交付要有跑过的验证命令；看起来做完但没跑检查，会被门禁拦下。
- Token 成本：主代理只做需求分析与拆单；编辑与核查在隔离子会话里进行；工具表按阶段裁剪，交接记录有界，不把整段对话塞给 worker。
- 过程可回溯：每轮一张会话控制卡片、每次工具调用一枚阶段胶囊，都从持久投影回放；刷新、重开、翻页看到的都是当时的真实状态。

## 特性

| 特性 | 说明 |
| --- | --- |
| 阶段门禁由插件判定 | 模型只能请求推进，`checkAdvance` 按事实放行：只读观察、任务单、落盘编辑、最近验证通过。 |
| 双层门禁 | `tools/pre-execute` waterfall 友好拒绝 + `ctx.tools.guard` 单调边界，共用 `checkTool`；用 `deny` 不用 `ask`。 |
| 工具按阶段裁剪 | implement 只剩 `delegate_implement`、`coding_handoff`、`todo_write`、`bash` / `pwsh` 与控制类工具；deliver 连命令也不给。 |
| 子代理隔离 | planner / implement / verify 各有独立上下文、工具白名单与路由，不继承主代理限制。 |
| 模型分工 | 三个 worker 字段默认 `auto` 跟随主代理当前模型，也可分别填 `provider/model`，例如 Pro 勘探 + Flash 干活。 |
| planner 门禁 | `requirePlanner` 默认 `complex`，任务单严格大于三条时 codex 必须先派发 `delegate_plan`；失败也算一次尝试；planner 为 `auto` 时跳过。 |
| 有界交接 | goal / constraints / acceptance / decisions / findings / open / tasks / changes / delivered / followUps 随 checkpoint 持久化，注入 worker 时按角色裁剪。 |
| 语义化验证 | `run_verification` 从 manifest 探测命令与包管理器（pnpm / npm / yarn / bun），命令级超时 `verificationTimeoutMs`。 |
| 防死循环 | 失败按签名计入 `maxVerifyAttempts` / `maxSameFailure`，预算耗尽后 `coding_stage(deliver)` 只放行一次 BLOCKED 交付，验证通过才自动清零。 |
| 状态可见 | 会话控制卡片 + 阶段胶囊，只读，控制动作走 `/coding` 命令。 |
| 交接文档与文档生成 | `/coding memory` 把本轮结果写成 Markdown；`/coding init` 用本会话模型生成或增量更新 `AGENTS.md`（正文带固定的六条书写风格规则）。 |

## 它怎么工作

五个阶段（requirements → plan → implement → verify → deliver）能不能往下走，由插件按事实判定：是否完成只读观察、是否有任务单、是否有落盘编辑、最近一次验证是否通过。模型只能提出推进请求，放不放行不参考它的说法。

实现阶段主代理的工具表被裁剪，编辑工具直接移除，改文件只能走 `delegate_implement`；交付阶段连命令也不给，只做只读汇报。planner / implement / verify 三个 worker 各有独立上下文与工具白名单，默认跟随主代理当前模型，也可以各填 `provider/model`。

阶段之间的结论写进 `coding_handoff`，交接记录与验证结果随整值 checkpoint 持久化，重启与翻页都能读回。会话控制卡片与阶段胶囊从持久投影回放，刷新、重开、历史翻页看到的都是当时的真实状态。

### 阶段工具与可见范围

| 阶段 | 主代理能用的工具 |
| --- | --- |
| 需求分析 requirements | 读文件、搜索、检查命令；不能改文件、不能验证、不能委派 |
| 规划 plan | 读 + `delegate_plan` + `todo_write`；先用 `coding_handoff` 记录 goal，再写任务单 |
| 实现 implement | `delegate_implement`、`coding_handoff`、`todo_write`、shell（`bash` / `pwsh`）与控制类工具 |
| 验证 verify | 读 + `run_verification` / `delegate_verify` + `todo_write`；临时命令只复现失败 |
| 交付 deliver | 只读汇报；可把已完成条目勾成 completed；预算耗尽时为 BLOCKED 交付 |

- plan 阶段没有任务单不能进入实现。任务单严格大于三条（多文件改动）时，未派发过 `delegate_plan` 不能进入实现——planner 为 `auto` 时门禁跳过，主 Agent 自身就是 planner 模型时同样跳过，单文件小改 1-3 条不强制。
- implement 阶段能自己跑安装、`git` 与一次性命令；编辑工具被移除，改文件仍走 `delegate_implement`。
- verify 阶段先记录验收标准，失败按预算重试；正式检查仍走验证工具，失败不能交付。

### 控制类工具

| 控制类工具                         | 作用                                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `coding_stage`                     | 查看或推进阶段；放行与否由插件判定                                                                                                                      |
| `coding_mode` / `coding_reasoning` | 选择工作流 / 调整推理等级                                                                                                                               |
| `coding_handoff`                   | 读写跨阶段交接记录（goal / constraints / acceptance / findings / decisions / open / tasks / changes）；`{ reset: true }` 只重置验证重试预算，不清空记录 |

命令行的完整用法（状态查看、模式与阶段切换、`/coding reset`、交接文档、`/coding init` 的参数与回执）见 [命令使用指南](docs/COMMANDS.md)。`/coding init` 按项目现有文档与代码摘录生成或增量更新 `AGENTS.md`（`-modules` 处理模块级、`-update` 只改受影响章节），`/coding memory` 生成交接文档。

实现细节、判定条件与边界情况见 [设计思路与分层结构](docs/DETAIL.md)。

## 安装

环境要求：Node.js ≥ 24.9.0（与 `package.json` 的 `engines.node` 一致；DSH 0.2.2-rc.5 内置 Node 24.21.0，满足该下限）、DSH ≥ 0.2.2-rc.5、pnpm 12+。

插件市场 / **插件** 页面：**添加插件** → 输入 `dsh-coding`（或本地目录绝对路径）。

```bash
dsh plugin --profile <profile> add dsh-coding
```

## 更新

DSH 桌面 / **插件** 页面：**DSH Coding** → **更新**。

或手动更新：卸载插件再重新安装。

> 注意：插件卸载或更新后，需要重新启动 DSH 。

## 使用

1. 新建会话，预设选择 **Coding**。worker 预设（共四个，含带仓库指令的 verify 变体）只用于 `delegate_*` 派发，不出现在预设列表。
2. 空白首页输入框旁可选**工作模式**（自动 / 问答 / 审查 / Codex）。默认**自动**先做需求分析，再用 `coding_mode` 选定后续工作流；不确定时回退到问答。
3. 正常提需求：需求分析 → 规划（planner worker 勘探现状并输出单一职责子任务）→ 任务单 → 实现（implement worker）→ 验证（verify worker）。三个 worker 默认跟随主代理当前模型（`auto`）。每个子任务写清目标、涉及文件、验收方式与不碰的范围。
4. **一次会话只跑一个任务**：换任务请新开会话。`coding_handoff` 的 acceptance / constraints 等字段只追加，同一会话复用会让上一个任务的验收标准继续满足新任务的门禁；目前没有清空交接记录的入口（`coding_handoff({ reset: true })` 与 `/coding reset` 只重置验证重试预算）。

## 配置

装好后在 **插件 → DSH Coding 编程智能体** 页面可视化编辑（保存后立即生效）。`requirePlanner`、`verificationCommands`、`verificationTimeoutMs` 与两个验证预算键是普通字段（非 volatile，不出现在插件页），需改插件包配置（`cordis.patch.yml`）：

```yaml
- id: dsh-coding
  name: "dsh-coding"
  config:
    defaultMode: auto # auto | consult | review | codex
    language: auto # auto | zh | en
    reasoning: auto # auto | low | high | max
    plannerWorkerModel: auto # auto（默认，跟随主代理当前模型）或 provider/model
    requirePlanner: complex # complex | off；complex 时 codex 下任务单严格大于三条必须先 delegate_plan，off 关闭该门禁
    implementWorkerModel: auto # auto（默认，跟随主代理当前模型）或 provider/model
    verifyWorkerModel: auto # auto（默认，跟随主代理当前模型）或 provider/model
    verificationTimeoutMs: 360000 # 单次验证命令的最长运行时间（毫秒）；超时终止并记为失败。0 表示不限制。
    verificationCommands: {} # 按 kind / kind:scope 覆盖验证命令
    maxVerifyAttempts: 5 # 验证失败重试预算：0 表示不限制。耗尽后允许 BLOCKED 交付，避免死循环。
    maxSameFailure: 2 # 相同失败签名连续出现上限；0 表示不限制
```

### 推荐组合

| 组合                        | 配置                                                                 | 适用                                                                 |
| --------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 全自动（默认）              | planner / implement / verify 三个字段都是 `auto`                     | 单模型跑完整流程，装完即用；在对话框换一次模型，三个 worker 一起跟随 |
| 编排自动 + planner 显式 pro | `plannerWorkerModel` 填一条 pro 路由，implement / verify 保持 `auto` | 复杂任务用更强模型勘探现状与拆单，编辑与核查仍跟随主代理当前模型     |
| 全显式                      | planner / implement / verify 各填具体 `provider/model`               | 成本与模型分工完全可控；跨 provider 时唯一稳妥的组合                 |

三种组合下 `auto` 的语义相同：

1. 只在派发时解析一次，跟随主代理（对话框）当前模型；
2. 解析结果仍校验 provider 注册与模型目录，失败即派发失败，绝不替换成别的路由；
3. planner 为 `auto` 时主代理自己就是 planner，`requirePlanner` 门禁跳过、不派发 planner。

### 实用配方

两种设置路径，能力相同：

- **桌面版**：**插件 → DSH Coding 编程智能体** 页面里用三个下拉框选择模型字段并保存；选项来自当前 DSH 已配置的模型（含第三方 provider），首项是「自动（跟随主代理当前模型）」。
- **CLI / Web 版**：改该 profile 的 `cordis.patch.yml` 里 `- id: dsh-coding` 那一行的 `config`，保存后重载生效。命令行的 profile 目录可用 `dsh plugin --profile <profile> ...` 管理。

**Q1. 只想用官方模型，怎么配出「Pro 做需求分析与任务拆解、Flash 执行、Flash 验证」？**

在插件页把 `plannerWorkerModel` 填 `deepseek-account/deepseek-v4-pro`，`implementWorkerModel` 与 `verifyWorkerModel` 填 `deepseek-account/deepseek-flash`；也可以直接写 yaml：

```yaml
- id: dsh-coding
  config:
    plannerWorkerModel: deepseek-account/deepseek-v4-pro
    implementWorkerModel: deepseek-account/deepseek-flash
    verifyWorkerModel: deepseek-account/deepseek-flash
```

planner 用 pro 勘探现状、拆出单一职责的子任务，implement / verify 用 flash 省成本。注意 planner 一旦不是 `auto`，`requirePlanner` 门禁重新生效——codex 模式下任务单超过三条时，必须先用 `delegate_plan` 派发 planner。

**Q2. 完全不用官方模型，改用第三方平台（例如 Qwen 3.8）怎么配？**

先在 DSH 的模型设置里注册第三方 provider（示例 id `qianwen-token-plan`，OpenAI 兼容），再在插件页把三个字段都填该 provider 下的模型：`qianwen-token-plan/qwen3.8-max`（planner）、`qianwen-token-plan/qwen3.8-flash`（implement）、`qianwen-token-plan/qwen3.8-flash`（verify）。

```yaml
- id: dsh-coding
  config:
    plannerWorkerModel: qianwen-token-plan/qwen3.8-max
    implementWorkerModel: qianwen-token-plan/qwen3.8-flash
    verifyWorkerModel: qianwen-token-plan/qwen3.8-flash
```

前缀必须是 DSH 里已注册的 provider id，写错是派发失败（报错给出字段名、当前路由与可用模型），不会回退到别的路由。三个字段也可以全部保持 `auto`：那时 worker 跟随对话框当前模型，对话框切到第三方模型就等于全员走第三方。

**Q3. 想混搭：planner 用第三方 pro、执行与验证用官方 flash，可以吗？**

可以。三个字段互相独立，各自解析、各自校验，跨 provider 混搭是合法配置，例如 `plannerWorkerModel: qianwen-token-plan/deepseek-v4-pro-0813`、`implementWorkerModel: deepseek-account/deepseek-flash`、`verifyWorkerModel: deepseek-account/deepseek-flash`。前提是 worker 从不继承主代理模型：缺哪一段就用哪一段的显式路由，所以每一段都可以独立指定，某一段仍可保持 `auto`，只有那一段跟随对话框当前模型。

**Q4. 配完之后怎么确认真的生效了／换模型要重启吗？**

不需要重启：`auto` 在每次派发时重新读对话框当前模型，显式路由在派发前校验 provider 与模型。验证方式：看回合卡片里的 worker 记录（role / 状态 / 摘要）与 `/coding` 状态行；派发失败时错误会指出字段名、当前路由与可用模型，按提示改完配置后重试同一派发即可。若字段是 `auto` 而主代理还没有模型选择，派发会以 `AUTO_UNAVAILABLE` 失败——先在对话框选一个模型。

以上 provider id 与模型 id 都是示例：选项来自当前 DSH 已配置的模型（按 provider 逐个枚举，含 `cordis.patch.yml` 里静态声明的第三方 provider）；`auto` 是固定首项，不参与目录校验。若某个第三方 provider 的模型没有出现在下拉里，页面提示会给出未能枚举的 provider 与原因（「以下 provider 未能枚举出模型：<provider> (<原因>)」），按提示检查该 provider 的配置与凭据。保存只校验格式，真实可用性在派发时由 Host 校验；已保存但目录里没有的路由仍显示为「不在当前模型列表」并保持选中。

### 升级与配置迁移

- 升级不重置已有配置：插件升级只替换安装目录里的包；profile 的 `cordis.patch.yml` 里 `- id: dsh-coding` 那一行按 id 保留，行内旧值原样不动（实测从 npm 版换成本地 link 后，旧值仍在）。
- 新增字段取 schema 默认值：新版本新增的键（例如后来的 `maxVerifyAttempts`）不必手写，行里没写该键时按默认值补齐，不会报错。
- 删除或改名的字段被忽略：只读取 schema 认识的键，不认识的键不会让插件挂载失败。
- 语义变化不会自动迁移：`auto` 是新语义，旧版本写死 `deepseek-account/...` 的行升级后仍是那些值——想改用 `auto` 需要手动改：插件页点**恢复默认**再保存，或直接改 yaml。

| 场景                                        | 升级后行为                                     |
| ------------------------------------------- | ---------------------------------------------- |
| 行里已有的键                                | 原值保留，不覆盖                               |
| 行里没有的新键                              | 取 schema 默认值                               |
| 已被移除的键                                | 忽略，不影响挂载                               |
| 旧默认值（如写死的 `deepseek-account/...`） | 原样保留，需要手动改成 `auto` 才跟随对话框模型 |

- 验证方式：升级后打开插件页看三个字段的当前值，或在会话里用 `/coding` 看状态行；配置写错时派发会给出字段名与可用模型。

## 最佳任务实践

1. 一个任务只做同方向的一类事（不是一件事），不要一次把想要的全塞进来；提示词不要长篇大论，最重要的是明确目标和边界。
2. 任务特别大时按依赖拆成几轮：子任务超过十个，或者一轮里验证跑不完，就在本轮只做第一批，把剩余轮次写进 `coding_handoff` 的 `followUps` / `open`，结束时用 `/coding memory` 生成交接文档，下一轮新开会话用 `/coding memory open` 接手。每批控制在 8 条任务以内。
3. 创建项目级 `AGENTS.md`，记录项目背景、目标、当前状态、关键里程碑、交付物、验收标准、依赖关系、协作流程、常见问题、FAQ 等，作为需求分析的基础。可先用 `/coding init` 生成项目级文档、`/coding init -modules` 生成模块级文档，再人工补充；参数与回执见 [命令使用指南](docs/COMMANDS.md)。
4. 大型工程项目建议加模块级（目录级）`AGENTS.md`，记录模块背景、目标、当前状态、交付物、验收标准、依赖关系、协作流程、常见问题、FAQ 等，作为具体工程任务的基础。同样可用 `/coding init -modules` 生成后人工补充；参数与回执见 [命令使用指南](docs/COMMANDS.md)。
5. 使用 Git/GitLab 做代码托管，按一库一项目（服务）原则建仓管理，配合明确的标签化／版本号机制联动发布。
6. 编程智能体基于项目（服务）创建管理会话，养成随手更新开发文档与交接文档的习惯，脱离智能体也能追溯代码变更。

## 文档

- [设计思路与分层结构](docs/DETAIL.md)
- [`/coding` 命令使用指南](docs/COMMANDS.md)
- [更新日志](docs/CHANGELOG.md)
- [维护者与智能体工作指南](AGENTS.md)

## 许可

MIT
