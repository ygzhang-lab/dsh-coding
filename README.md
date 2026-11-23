# DSH Coding 编程智能体

DSH 编程智能体插件，工程化任务编排机制，Codex 五段式契约层层推进，Pro 模型负责分析需求/编排任务，交由子代理隔离各项任务使用 Flash 模型干活，确保任务交付质量和 Token 价值最大化。
DSH programming intelligent agent plugin, engineering task orchestration mechanism, Codex five-stage contract progressing layer by layer, Pro model responsible for analyzing requirements/orchestrating tasks, delegating to sub-agents to isolate various tasks and using Flash model to perform work, ensuring task delivery quality and maximizing Token value.

[![GitHub Repo stars](https://img.shields.io/github/stars/ygzhang-lab/dsh-coding?style=flat&logo=github)](https://github.com/ygzhang-lab/dsh-coding)
![GitHub License](https://img.shields.io/github/license/ygzhang-lab/dsh-coding)
[![NPM Version](https://img.shields.io/npm/v/dsh-coding)](https://www.npmjs.com/package/dsh-coding)
[![NPM Downloads](https://img.shields.io/npm/dy/dsh-coding)](https://www.npmjs.com/package/dsh-coding)
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/zh/plugins/ygzhang-lab/dsh-coding)

插件名是 `dsh-coding`，NPM 包名是 `dsh-coding`，在 DSH 中的插件显示名是 **DSH Coding**。源码与 issue 在 [ygzhang-lab/dsh-coding](https://github.com/ygzhang-lab/dsh-coding)。

## 本插件价值

**一切皆插件／自由过了火**

DSH 作为通用 Harness 基座，开源至今火出天际，但没有内置工程化任务智能体，能力依赖插件组合实现。自由是把双刃剑：社区插件生态丰富，不少插件维护滞后甚至无人维护；纯对话式、许愿式的编程方式，面对工程项目／模块构建这类长编程任务体验不佳，上下文遗忘、反复重来。

- **工程化任务设计**：内置工程化任务编排机制，Codex 五段式契约层层推进。脱离古法编程，不再靠对话框反复确认 Plan A、修复回归 Plan B。
- **提高任务交付质量**：每轮交付都要过门禁——需求分析充分、任务单明确、编辑完整落盘、验证真实跑过，避免“看起来做完”的常见问题。
- **Token 价值最大化**：Pro 模型只做需求分析与任务拆分，编辑与核查交给 Flash 子代理；工具表按阶段裁剪、交接记录有界，不为长对话和无关工具反复付费。
- **过程可见可回溯**：每轮一张会话控制卡片、每次 Coding 工具调用一枚阶段胶囊，都从持久事件回放；刷新、重开、翻页看到的都是当时真实的阶段与验证状态。

## 特性

| 特性                           | 工作机制                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **阶段门禁由插件判定**         | 模型只能提出推进请求（`requirements → plan → implement → verify → deliver`），是否放行由插件按事实决定：是否完成只读观察、是否有任务单、是否有编辑落盘、最近一次验证是否通过；被拒时返回含当前阶段、允许阶段与补救动作的 `reason`                                                                                                                                                            |
| **双层门禁，不靠提示词自律**   | `tools/pre-execute` waterfall 负责友好拒绝，`ctx.tools.guard` 是单调生效的最终边界；两层共用同一个 `checkTool` 判定函数，不会漂移。门禁用 `deny` 而非 `ask`，模型看到 `Error: <reason>` 后自行纠正                                                                                                                                                                                           |
| **工具按阶段物理裁剪**         | 实现阶段主代理的工具表只剩 `delegate_implement`、`coding_handoff`、`todo_write`、shell（`bash` / `pwsh`）与控制类工具；编辑工具被移除，既看不见也调不到，改文件仍走 `delegate_implement`；交付阶段连命令也不授予                                                                                                                                                                             |
| **子代理隔离执行 + 模型分工**  | planner / implement / verify 三个 worker 各有独立上下文、独立工具白名单与独立路由：Pro 负责勘探现状与拆分任务，Flash 负责编辑与核查。codex 下任务单严格大于三条（多文件改动）时 planner 是**强制步骤**：本会话未派发过 `delegate_plan` 就不能进入实现，派发失败也算一次尝试（尝试只记进整值 checkpoint，不新增 Session 事件）；主 Agent 自身模型就是 planner 路由时跳过，`requirePlanner: off` 可整条关闭。worker 路由缺失、格式错误或模型不可用时直接失败并给出字段名与可用模型，绝不悄悄回退主代理模型。implement worker 固定携带仓库指令（`AGENTS.md`），verify worker 只在 codex 且任务复杂（多子任务或改动文件 ≥3）时才改用带指令的验证预设，普通核查保持精简 |
| **有界交接取代对话记忆**       | 目标、约束、验收标准、决策与任务写进 `coding_handoff`，随 checkpoint 持久化，重启与翻页可恢复；注入 worker 提示词时按角色裁剪并有字符／条数上限，不把整段对话塞给子代理                                                                                                                                                                                                                      |
| **语义化验证 + 防死循环**      | `run_verification` 从项目 manifest 自动探测命令与包管理器（pnpm / npm / yarn / bun）；命令级超时 `verificationTimeoutMs` 到点终止并记为失败；失败按签名计入 `maxVerifyAttempts` / `maxSameFailure`，耗尽后只放行一次 BLOCKED 交付，再次验证通过才自动清零                                                                                                                                    |
| **状态可见、控制回流**         | 每轮一张会话控制卡片（模式、阶段路径、推理等级、验证状态、任务单进度、改动文件数），每次 Coding 工具调用一枚阶段胶囊；两者只读，控制动作一律经 `/coding` 命令回流 Host，前端不直接改状态，旧轮冻结在它实际运行的模式与阶段                                                                                                                                                                   |
| **本轮完成后一键生成交接文档** | 最新一轮卡片在该轮以 codex 交付并通过验证后出现「结束任务并生成交接文档」按钮，二次确认后把本轮目标、验收标准、交付记录、验证与改动文件写成 `<会话 cwd>/.agents/memory/<sessionId>-<YYYYMMDD-HHmmss>.md`；历史轮与非 codex 轮不显示按钮，按钮只写文档，不改变运行时状态                                                                                                                      |
| **失败只播报一次**             | 八个关键调度点（projection / restore / tool-table / reasoning / delegate / verification / handoff / command）的阻断性异常注入一条“运行中断”通知（原因 + 处理），不新开 Turn、不新增事件类型；同点恢复成功后自动清除                                                                                                                                                                          |
| **模式与推理等级可调**         | 自动 / 问答 / 审查 / Codex 四种工作模式；推理等级支持 `auto` 按任务规模分类（问答与单文件 Low、多文件与模块级 High、项目级 Max，同一轮只升不降），也可配置固定或会话覆盖                                                                                                                                                                                                                     |

## 安装

插件市场 / **插件** 页面：**添加插件** → 输入 `dsh-coding`（或本地目录绝对路径）。

```bash
dsh plugin --profile <profile> add dsh-coding
```

## 更新

插件市场 / **插件** 页面：**DSH Coding** → **更新**。

或手动更新：卸载插件再重新安装。

> 注意：插件卸载或更新后，需要重新启动 DSH 。

## 配置

装好后在 **插件 → DSH Coding 编程智能体** 页面可视化编辑（保存后立即生效）。`requirePlanner`、`verificationCommands`、`verificationTimeoutMs` 与两个验证预算键是普通字段（非 volatile，不出现在插件页），需改插件包配置（`cordis.patch.yml`）：

```yaml
- id: dsh-coding
  name: "dsh-coding"
  config:
    defaultMode: auto # auto | consult | review | codex
    language: auto # auto | zh | en
    reasoning: auto # auto | low | high | max
    plannerWorkerModel: provider/model # 必填，插件安装初始值：deepseek-account/deepseek-v4-pro
    requirePlanner: complex # complex | off；complex 时 codex 下任务单严格大于三条必须先 delegate_plan，off 关闭该门禁
    implementWorkerModel: provider/model # 必填，插件安装初始值：deepseek-account/deepseek-flash
    verifyWorkerModel: provider/model # 必填，插件安装初始值：deepseek-account/deepseek-flash
    verificationTimeoutMs: 360000 # 单次验证命令的最长运行时间（毫秒）；超时终止并记为失败。0 表示不限制。
    verificationCommands: {} # 按 kind / kind:scope 覆盖验证命令
    maxVerifyAttempts: 5 # 验证失败重试预算：0 表示不限制。耗尽后允许 BLOCKED 交付，避免死循环。
    maxSameFailure: 2 # 相同失败签名连续出现上限；0 表示不限制
```

默认值：planner 用 `deepseek-account/deepseek-v4-pro`（pro 模型负责勘探现状与拆分任务），implement / verify 用 `deepseek-account/deepseek-flash`（flash 模型执行编辑与核查）；三个字段都可以在插件页里改。

插件页里三个模型字段是**下拉选择**，选项来自当前 DSH 已配置的模型目录（`ctx.remote.llm`：已注册 provider + 可配置 provider + 各自声明的模型）；选错（空值，或不在已加载列表里）时字段与提示都用警告色，并禁用保存。**恢复默认**只把 `defaultMode`、三个 worker 模型、`language`、`reasoning` 回填为默认值，仍需再点保存才会写入。

三个 worker 模型**不回退**主代理模型：缺失、格式不对或 provider 不存在时插件挂载失败；派发前还会校验模型是否可用（`ctx.llm.resolveModelInfo`），失败时错误给出配置字段名、当前路由与该 provider 的可用模型，修好配置后重试原调用即可。

## 使用

1. 新建会话，预设选择 **Coding**。worker 预设（共四个，含带仓库指令的 verify 变体）只用于 `delegate_*` 派发，不出现在预设列表。
2. 空白首页输入框旁可选 **工作模式**（自动 / 问答 / 审查 / Codex）。默认 **自动** 先做需求分析，再用 `coding_mode` 选定后续工作流；不确定时回退到问答。
3. 正常提需求：需求分析 → 规划（pro worker 勘探现状并输出单一职责子任务）→ 任务单 → 实现（flash worker）→ 验证。每个子任务写清目标、涉及文件、验收方式与不碰的范围。
4. **一次会话只跑一个任务**：换任务请新开会话。`coding_handoff` 的 acceptance / constraints 等字段只追加，同一会话复用会让上一个任务的验收标准继续满足新任务的门禁；目前没有清空交接记录的入口（`coding_handoff({ reset: true })` 与 `/coding reset` 只重置验证重试预算）。

## 最佳任务实践

1.  一个任务只做同方向的一类事（不是一件事），避免大而全的“许愿式任务”，提示词不要长篇大论，最重要的是明确目标和边界。
2.  创建项目级 AGENTS.md，记录项目背景、目标、当前状态、关键里程碑、交付物、验收标准、依赖关系、协作流程、常见问题、FAQ 等，作为需求分析的基础。
3.  大型工程项目建议 + 模块级(目录级) AGENTS.md，记录模块背景、目标、当前状态、交付物、验收标准、依赖关系、协作流程、常见问题、FAQ 等，作为具体工程任务的基础。
4.  使用 Git/GitLab 进行代码托管，按照一库一项目(服务)原则建仓管理，明确的标签化/版本号机制联动进行迭代发布。
5.  编程智能体基于项目(服务)创建管理会话，养成开发文档/交接文档随时更新的好习惯，脱离智能体也能确保代码的可追溯性和可回溯性。

| 阶段                  | 主代理可以做什么                                                                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 需求分析 requirements | 读文件、搜索、检查命令；不能改文件、不能验证、不能委派                                                                                                                             |
| 规划 plan             | 读 + `delegate_plan` + `todo_write`；先用 `coding_handoff` 记录 goal，再写任务单；没有任务单不能进入实现；任务单严格大于三条（多文件改动）时，未派发过 `delegate_plan` 不能进入实现——主 Agent 自身就是 planner 模型时跳过，单文件小改 1-3 条不强制 |
| 实现 implement        | 只剩 `delegate_implement`、`coding_handoff`、`todo_write`、shell（`bash` / `pwsh`）与控制类工具；能自己跑安装、`git` 与一次性命令；编辑工具被移除，改文件仍走 `delegate_implement` |
| 验证 verify           | 读 + `run_verification` / `delegate_verify` + `todo_write`；可跑临时命令复现失败，正式检查仍走 `run_verification`；先记录验收标准，失败按预算重试；失败不能交付                    |
| 交付 deliver          | 只读汇报；可把已完成条目勾成 completed；预算耗尽时为 BLOCKED 交付                                                                                                                  |

| 控制类工具                         | 作用                                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `coding_stage`                     | 查看或推进阶段，放行与否由插件判定                                                                                                                      |
| `coding_mode` / `coding_reasoning` | 选择工作流 / 调整推理等级                                                                                                                               |
| `coding_handoff`                   | 读写跨阶段交接记录（goal / constraints / acceptance / findings / decisions / open / tasks / changes）；`{ reset: true }` 只重置验证重试预算，不清空记录 |

| 命令                                      | 作用                                                                                                                        |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `/coding`                                 | 查看当前阶段、模式、任务单与验证状态（状态行含 `handoff goal=…, acceptance=N`、`attempt N`、`BLOCKED`、`delivery BLOCKED`、派发过 planner 时的 `planner completed\|failed`） |
| `/coding auto / consult / review / codex` | 切换模式并新开一轮（`agent.followup()`）                                                                                    |
| `/coding set <模式>`                      | 静默设置模式（卡片按钮与首页选择器使用）                                                                                    |
| `/coding stage <阶段>`                    | 在当前轮内推进阶段（`agent.steer()`）                                                                                       |
| `/coding reset`                           | 重置验证重试预算（交接记录与最近一次验证结果保留）                                                                          |
| `/coding memory`                          | 写出本轮任务交接文档到项目根 `.agents/memory`（卡片按钮使用同一命令）                                                       |

每轮结束处有**会话控制卡片**（模式、阶段路径、推理等级、验证状态、任务单进度、改动文件数；最新一轮可切换模式），每次 Coding 工具调用处有**阶段胶囊**。两者都从持久会话投影回放：刷新、重开、历史翻页都显示当时的真实状态，旧轮冻结在它实际运行的模式与阶段。

### 交接与验证预算

- 每个阶段的结论写进 `coding_handoff`，而不是留在对话里：planner 返回的任务、implement 报告的文件、verify 的发现会自动并入；记录随 checkpoint 持久化，重启与翻页可恢复，进入 worker 提示词时按角色裁剪并有字符/条数上限。
- 结构化任务必须带验收标准。codex 模式下 plan 前要有 goal，verify 前要有 acceptance，deliver 前两者都要有。
- 验证命令有总时限（`verificationTimeoutMs`，默认 6 分钟 = 360000 ms，可配置，`0` 不限制）：到点终止并记为一次失败，避免测试脚本死循环一直等待。
- 验证失败按预算重试（默认 5 次失败、同一失败签名 2 次）；耗尽后 `coding_stage(deliver)` 放行但标记为 BLOCKED 交付，`coding_handoff({ reset: true })` 或 `/coding reset` 重置预算，只有验证通过才自动清零——这是防止死循环的出口。

### 仓库指令（AGENTS.md）注入

- implement worker 固定携带仓库指令；verify worker 默认不带，只在 codex 模式且任务复杂时改用内部预设 `dsh-coding-verify-instructions`：判定条件是 `taskCount >= 2 || changedFiles >= 3`（多子任务代表跨任务依赖，≥3 个改动文件代表改动面大），普通单任务核查保持精简。
- 每次派发都是新的子会话，指令在会话启动时从磁盘读取，所以派发时读到的是最新内容；worker 运行中若指令文件被更新，上游会在该 worker 后续 `read` / `write` / `edit` 触碰文件时重新读取并注入 `Updated instructions from: …`，不会每步刷新，运行时也不缓存指令文本。
- **手工验证**：在 codex 会话完成一个多子任务改动后派发 verify，确认子代理会话里存在 `source.kind === 'agent-instructions'` 的 user 消息；把同一场景换成单任务单文件再派发 verify，则不应出现该消息。

### 失败提示

- 关键调度点（子代理派发、验证启动/超时、工具表裁剪、会话恢复/投影、推理等级、交接写入、控制命令）遇到阻断性异常时，下一步会注入一条**运行中断**通知，写明原因与处理方式；状态行与会话 checkpoint 同时记录 `failure <point>`。
- 通知只出现一次，不新开 Turn；同一环节恢复成功后自动清除，重启只恢复 `failure` 状态、不重复提示。
- 普通验证失败仍走预算 / BLOCKED 路径，不产生该通知。
- 启动即失败（worker 路由或依赖缺失）没有下一步可注入，插件挂载错误里会附一段 `What to do`。

## 文档

- [设计思路与分层结构](docs/DETAIL.md)
- [更新日志](docs/CHANGELOG.md)
- [维护者与智能体工作指南](AGENTS.md)

## 许可

MIT
