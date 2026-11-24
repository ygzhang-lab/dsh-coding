# DSH Coding 编程智能体 — 设计思路与分层结构

DSH 编程智能体运行时插件，工程化任务编排机制，Codex 五段式契约层层推进；三个子代理默认 `auto`（跟随主代理当前模型），也可分别指定 planner / implement / verify 的模型，确保任务交付质量和 Token 价值最大化。

本文说明插件为什么这样设计、由哪些层组成，以及每层的职责边界；供使用者理解行为、供维护者规划迭代。目录、构建与发布见根 [AGENTS.md](../AGENTS.md)，测试与验证见 [test/AGENTS.md](https://github.com/ygzhang-lab/dsh-coding/blob/main/test/AGENTS.md)，源码契约与实现约束见 [src/AGENTS.md](https://github.com/ygzhang-lab/dsh-coding/blob/main/src/AGENTS.md)。

## 1. 插件设计

普通 Coding 预设靠系统提示词要求模型“先需求分析、再规划、再修改、再验证”，模型可以遵守也可以跳过。本插件把同一套节奏交给 DSH 的事件系统执行：

- **阶段由插件判定**：`requirements → plan → implement → verify → deliver`，模型只能提出推进请求；是否放行由插件依据事实（是否完成需求分析、是否有任务单、是否有编辑落盘、最近一次验证是否通过）决定。
- **工具由插件裁剪**：实现阶段主代理的工具表只剩委派、shell（`bash` / `pwsh`）与控制类工具，编辑工具既不可见，也会被兜底守卫拒绝。
- **编辑在隔离子代理中完成**：implement worker 有独立上下文与独立模型路由，只拿到显式放行的编辑工具。
- **阶段之间靠有界记录交接**：目标、验收标准、决策与任务写进 `coding_handoff`，worker 只读自己那一份摘要，而不是靠对话历史传递需求。
- **交付记录写进交接记录**：交付了什么、改了哪些文件、跑了哪个检查写进 `coding_handoff` 的 `delivered` / `followUps`；下一轮与重开的会话读这份记录，而不是靠回读本轮对话。
- **验证结果决定能否交付**：验证失败时推进到交付会被拒绝，并阻止下一步；重试预算耗尽后只放行一次 BLOCKED 交付。
- **状态在对话里可见**：每轮一张会话控制卡片、每次 Coding 工具调用一枚阶段胶囊，均从持久会话事件/投影回放。

## 2. 分层结构

```
┌──────────────────────────────────────────────────────────────┐
│ 投影层  模式选择器 · 会话控制卡片 · 阶段胶囊（只读）          │
├──────────────────────────────────────────────────────────────┤
│ 编排层  状态机 · 双层门禁（pre-execute + guard） · pre-step   │
├──────────────────────────────────────────────────────────────┤
│ 执行层  隔离子代理（planner / implement / verify）· 模型路由  │
├──────────────────────────────────────────────────────────────┤
│ 交接层  coding_handoff · 有界记录 · checkpoint 持久化         │
├──────────────────────────────────────────────────────────────┤
│ 验证层  run_verification · 结构化报告 · 失败回流              │
├──────────────────────────────────────────────────────────────┤
│ 推理层  自动分类 / 配置固定 / 会话覆盖                        │
└──────────────────────────────────────────────────────────────┘
```

### 2.1 编排层：状态机 + 双层门禁

| 机制                          | 位置                             | 作用                                                                   |
| ----------------------------- | -------------------------------- | ---------------------------------------------------------------------- |
| `coding_stage`                | `src/preset.ts` → `src/state.ts` | 请求查看/推进阶段，`checkAdvance` 判定                                 |
| `tools/pre-execute` waterfall | `src/preset.ts`                  | 返回 `{ kind: 'deny', reason }`，reason 含当前阶段、允许阶段与补救动作 |
| `ctx.tools.guard()`           | `src/preset.ts`                  | 同一条规则注册为单调拒绝，pre-execute 放行后仍然生效                   |
| `agent/pre-step`              | `src/preset.ts`                  | 注入当前阶段契约与状态；跳过门禁时拒绝该 Step                          |

**为什么用 `deny` 而不是 `ask`**：`ask` 会把调用转交审批通道，语义是“询问用户是否允许”；阶段门禁是确定性规则，模型需要看到 `Error: <reason>` 并据此调整行为。

**两层分工**：waterfall 负责友好拒绝与可操作提示，guard 是最终安全边界。真实派发顺序是 pre-execute →（ask）→ `checkGuards` → 派发，所以即使别的监听器先返回 `allow`，guard 仍拒绝。

**阶段门禁条件**（`checkAdvance`）：

| 目标阶段    | 条件                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `plan`      | 至少一次成功的只读/检查观察（`requirementsObserved > 0`）；codex 模式还要求 handoff 里已有 goal                                 |
| `implement` | 存在 `todo_write` 写入的结构化任务单；codex 下任务单严格大于三条时还要求本会话已尝试过 `delegate_plan`（失败也算尝试），planner 为 `auto`（主代理自己就是 planner）、主 Agent 自身模型等于 `plannerWorkerModel` 或 `requirePlanner: off` 时跳过 |
| `verify`    | codex 模式下有落盘编辑，且 handoff 里已有验收标准；review 模式不要求                                                            |
| `deliver`   | codex 模式要求最近一次验证通过（预算耗尽时放行一次 BLOCKED 交付），且 handoff 里有 goal 与验收标准；review 模式要求至少跑过一次 |
| 选工作流    | auto 模式先 `coding_mode` 选择 consult / review / codex                                                                         |

回退（如 verify → implement）不受前向条件限制；模式切换后若当前阶段不属于新模式，自动回到该模式的首阶段。

**planner 门禁**：只挂在 `checkAdvance` 的 `implement` 分支。条件全部成立才拒绝——`mode === 'codex'`、任务单条数严格大于 `PLANNER_TODO_THRESHOLD`（= 3）、本会话还没有 `state.planner` 记录、主 Agent 自身模型不等于 planner 路由、且 `requirePlanner` 未关闭；拒绝原因要求先在 plan 阶段调用 `delegate_plan`，且拒绝本身不写入任何尝试记录。consult / review 不开放 implement 阶段，行为不变（仍由 `stageInMode` 拒绝）。主 Agent 是否即 planner 由 `src/preset.ts` 的 `leadIsPlanner` 判定：`plannerWorkerModel` 为 `auto` 时 `leadIsPlanner` 直接为真——主代理自己就是 planner，门禁跳过、不读模型选择、也不派发 planner；显式路由时比较 `agent.model.current()` 的 provider 与 model 与 `plannerWorkerModel` 全等才算，读不到或抛错按“不是”处理；`src/state.ts` 只接收调用方传入的 `{ leadIsPlanner, plannerGate }` 事实，保持纯函数。

**跳阶段的代价**：拒绝后 `agent/pre-step` 返回 `{ kind: 'reject' }`，Turn 以 `blocked` 结束；被拒绝的 Step 不把消息放回 Inbox，拒绝原因会在下一步契约里重新注入，模型因此知道为什么被拦下。

**失败上报**（`src/failures.ts`）：运行时在八个调度点捕获阻断性异常——`projection`、`restore`、`tool-table`、`reasoning`、`delegate`、`verification`、`handoff`、`command`。`makeFailure(point, error, language)` 生成 `CodingFailure { point, reason, action, at }`：`reason` 是异常消息（裁剪到 600 字符，空消息记为 `unknown error`），`action` 是该点针对性的下一步（按会话语言 zh/en 渲染，点名的配置字段与操作可直接照做）。`recordFailure(state, failure)` 同时写入 `failure`（当前未恢复的异常）与一次性 `failureNotice`；`agent/pre-step` 在应用推理等级之后用 `takeFailureNotice` 取走它，作为一条 `dsh-coding-control` 消息（`## dsh-coding 运行中断（<点>）` + 原因 + 处理）注入本步。该环节下一次成功时 `clearFailure(state, point)` 按点清除，因此一个子系统恢复不会掩盖另一个仍存在的异常；重启时 `restoreFromView` 只恢复 `failure`、不恢复通知，用户不会重新收到同一条提示。`statusLine` 显示 `failure <point>`，`checkpointOf` 把 `failure` 随工具结果持久化，旧 checkpoint 没有该字段照旧兼容。这条通道**不新增 Turn、不新增事件类型、只在异常时注入一条消息**：稳态下没有任何额外消息，历史不被改写，因此不影响缓存命中率。

### 2.2 执行层：子代理隔离 + 模型路由

实现阶段主代理的工具表被 `agent.ctx.tools.restrict({ allow })` 裁剪为：

```
delegate_implement · coding_handoff · todo_write · bash · pwsh · coding_stage · coding_mode · coding_reasoning
```

表里把 `bash` 与 `pwsh` 都写进 allow-list，因为每个平台只有一个存在，而 `tools.restrict` 拒绝它不认识的工具名——真正的按平台收窄由 `syncTable` 的 known 过滤完成。

`delegate_*` 派发时显式传入：`provider: 'spawn'`、`agentPreset`（= 子代理工具白名单；verify 按任务规模在 `dsh-coding-verify` 与 `dsh-coding-verify-instructions` 之间选择）、`agentOptions.provider/model`（配置里的 worker 路由）、`delivery: 'caller'`（结果只回给本次调用）、`outputSchema`（结构化报告）。子代理拿到全新的扁平注册作用域，父级 `restrict` 不会带入，因此白名单只能写在组合里。

**`delegate_plan` 的尝试记账**：派发前（模型可用性校验之前）就写入 `state.planner = { route, outcome: 'failed', at }`，所以路由不可用、启动失败或 worker 未完成都不会把 codex 流程锁死——失败也是一次尝试，门禁随即打开；派发结束再按实际结果把 `outcome` 改写为 `completed` / `failed`。门禁只看“有没有尝试”，`outcome` 只用于状态行展示（`planner completed|failed`），不新增 Session 事件，也不进投影字段。

worker 预设的插件列表（`cordis.patch.yml`）就是它们的权限清单（planner / implement / verify 三个角色，verify 另有一个带仓库指令的变体）：

| worker         | 实际工具                                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| planner        | `read` / `glob` / `grep` / `web_search` / `web_fetch`（只读）                                             |
| implement      | `read` / `write` / `edit` / `glob` / `grep` / `apply_patch` + `AGENTS.md` 仓库指令（`agent-instructions`） |
| verify         | `read` / `glob` / `grep` / `run_verification`（无编辑、无 shell）；默认不注入仓库指令                      |
| verify（条件） | 同一组工具 + `AGENTS.md` 仓库指令（`agent-instructions`）；仅在 codex 且任务复杂时派发到 `dsh-coding-verify-instructions` |

上表是角色视角：`agent-instructions` 不是工具，只决定 worker 能否看到仓库规则。implement 固定带它（`maxBytes: 65536`）；verify 默认不带，派发前先按 `needsWorkspaceInstructions` 判定，为真才改用内部预设 `dsh-coding-verify-instructions`。判定条件是 `mode === 'codex' && (taskCount >= 2 || changedFiles >= 3)`（`taskCount` 取 handoff 任务与任务单的较大值，`changedFiles` 取会话内记录的改动文件数）：多子任务代表跨任务依赖，核查要按仓库约定判断一致性；≥3 个改动文件代表改动面大，需要仓库规则兜底。`dsh-coding-verify-instructions` 是内部预设，和其他 worker 预设一样从对外花名册隐藏，只在 Host 注册表里供 `delegate_verify` 解析。

**仓库指令的时效性**：worker 每次派发都是新的子会话，`agent-instructions` 在会话启动时读取磁盘上的 `AGENTS.md` / `CLAUDE.md`，所以派发时读到的是最新内容。worker 运行中若指令文件被更新，上游会在该 worker 后续 `read` / `write` / `edit` 触碰文件时重新读取并注入一条 `Updated instructions from: …`，不会每一步都重读。本运行时**不缓存**指令文本，也不把它写进 handoff、状态（checkpoint）或 worker 提示词——提示词只说“仓库指令已注入，不要再读 AGENTS.md”，且只在带指令的预设上加这一句。`maxBytes` 取 65536，与主预设一致，避免 worker 看到被截断的规则；该上限分别约束用户全局链与项目链，超出时上游会截断并在消息里给出 budget 提示。

**模型路由与缺失处理**（`src/models.ts`）：

- 路由只有一个出口：`resolveWorkerRoute(config, role, lead?)` 按角色读固定字段（`plannerWorkerModel` / `implementWorkerModel` / `verifyWorkerModel`）；字段是 `auto` 时取派发时传入的主代理路由，否则要求正好是 `provider/model`。返回值始终带具体的 `provider` / `model`（外加 `role`、字段名、渲染文本与 `auto` 标记），所以下游 `agentOptions`、checkpoint 与 `planner.route` 的形状不变。
- `auto` 的三条语义：①只在派发时解析一次，跟随主代理（对话框）当前模型，对话框换模型后下一次派发即生效；②解析结果仍要过 `assertWorkerModel`——provider 必须已注册、模型必须在目录里，任一不满足即派发失败，绝不替换成别的路由；③planner 为 `auto` 时视为主代理自己就是 planner，`requirePlanner` 门禁跳过（见 2.1）。主代理模型读不到（`agent.model.current()` 缺失或抛错）时抛 `WorkerModelError`，错误码 `AUTO_UNAVAILABLE`，worker 不启动。
- 显式路由仍按原语义：`preflight` 在挂载时对每个非 `auto` 的角色各解析一次，因此缺失或格式错误直接挂载失败；`auto` 在 `preflight` 里被跳过，因为挂载期还没有 agent 上下文可读主代理模型，解析只发生在派发期。注册表可读时 provider 是否存在也在挂载时检查。
- 模型是否存在要查模型目录，而目录可能需要凭据，所以挂载阶段不判模型：目录不可用时校验延后到派发，不阻塞挂载。
- 派发前 `assertWorkerModel(ctx, route)` 现查现用：provider 不在 `ctx.llm.listProviders()` 里抛 `WorkerModelError`（`PROVIDER_MISSING`）；`ctx.llm.resolveModelInfo` 失败抛 `MODEL_UNAVAILABLE`，并附上 `ctx.llm.listModels` 给出的该 provider 可用模型（目录不可用时列表为空）。
- 错误文案给出配置字段名、当前路由、可用模型与修复位置，并明确「worker 永不回退主代理模型」；`auto` 的失败还会指出主代理模型读不到。失败的那次派发会记进 worker 记录，修好配置后重试原调用即可；同一路由重试只会得到同样的失败。

**失败上报**：模型校验（`assertWorkerModel`）、`startActivation` 启动、worker 结果异常，以及 worker 跑完但没有完成，都在 `delegate` 点走同一条 `recordFailure` 通道；派发成功时 `clearFailure(state, 'delegate')` 清除。异常仍以工具错误返回给主代理，额外的一次性通知保证用户也看到原因与处理方式。

### 2.3 验证层：语义化验证 + 结构化回流

`run_verification({ kind, scope })`：

1. **解析命令**：先看配置 `verificationCommands["<kind>:<scope>"]` → `["<kind>"]`，否则从最近的 `package.json` 的 scripts 按 `test / build / lint / typecheck` 候选挑选，并按 lockfile 判断包管理器（pnpm / npm / yarn / bun）。
2. **确定目录**：`targeted` 与 `package` 用最近的包目录，`full` 用仓库根目录。
3. **执行**：经 `ctx.subprocess.spawn()` 运行，不硬编码本地执行路径；输出按上限收集。
4. **结构化结果**：`passed`、`command`、`exitCode`、`durationMs`、`failedTests`、`errors`、`output`，写入状态机。
5. **回流**：失败时 `tools/post-execute` 追加“验证失败 / 回到实现阶段修复”，`coding_stage(deliver)` 与 `agent/pre-step` 据此拦截。

`delegate_verify` 的结构化报告写入 `source: 'worker'` 的验证记录。报告必须给出实际运行过的命令，否则记为失败——交付门禁不接受没有命令证据的“看起来通过”。

**命令级超时**（`verificationTimeoutMs`，默认 `360000` ms，`0` 不限制）：`executeVerification` 用 `Promise.race` 给 `ctx.subprocess` 句柄的 `done` 加一个截止时间；到点调用 `terminate()` 请求终止，并按 `exitCode: null`、`passed: false` 返回，`errors` 里写明“超过 `verificationTimeoutMs`（N ms）已被终止”。这个结果同样经 `recordVerification` 计入失败预算，因此死循环的测试脚本会持续消耗 `maxVerifyAttempts`，最终进入 BLOCKED 交付。超时是**命令级**的：它约束单次验证子进程的运行时间，不是 `run_verification` 工具调用级的预算。

**重试预算与阻塞交付**：每次验证结果都只经 `recordVerification(state, outcome, budget)` 记账。失败一次就累计一次 `verificationAttempts`，同时按**失败签名**区分“在修”和“在重复”：签名 = 排序后的 `failedTests` + 前 3 条 `errors` + `exitCode`，与上一次相同时 `sameFailureCount` 加一。预算来自配置 `maxVerifyAttempts`（默认 5）与 `maxSameFailure`（默认 2），`0` 表示不限制；任一耗尽即写入 `verifyBlocked`。此后 codex 模式下 `coding_stage(deliver)` 返回 `blocked: true`：推进被放行，但状态记为 `deliveryBlocked`，状态行显示 `BLOCKED after N attempts` 与 `delivery BLOCKED`。`coding_handoff({ reset: true })` 或 `/coding reset` 只清预算（交接记录与最近一次验证结果保留），只有验证通过才会自动清零。

**失败上报**：验证命令无法启动（命令为空或解析不出可执行命令）或超过 `verificationTimeoutMs` 时，除计入预算外还会在 `verification` 点记一次失败并注入运行中断通知；普通断言失败仍只走预算与 BLOCKED 路径，不产生该通知。验证通过时 `clearFailure(state, 'verification')` 清除。

### 2.4 投影层：模式选择 + 逐轮卡片 + 阶段胶囊

- **首条消息模式选择**：`conversation.hero.options` 注册 `dsh-coding/mode-picker`，仅在空白首页且为 Coding 会话时出现；点选走静默 `/coding set <模式>`，不会先起一轮空对话。
- **会话控制卡片**：`conversation.chat.turnTail` 注册 `dsh-coding/turn-card`。每轮一张，显示模式、该模式开放的阶段路径、推理等级与来源、验证状态、任务单进度、改动文件数；最新一张可切换模式，旧卡片冻结在那一轮实际运行的模式与阶段。最新一轮若以 codex 交付并通过验证，卡片提供「结束任务并生成交接文档」按钮：点击先在卡片内二次确认，确认后回流 `/coding memory`，由 Host 写盘，前端不写文件。
- **阶段胶囊**：`conversation.chat.node` 以 `coding-stage` 键注册 `ConversationNodeDefinition` 与渲染器，每次 Coding 工具调用处显示该次调用后的阶段与验证。
- **数据源**：持久会话投影 `dshCodingStage`（`ctx.sessionProjections`），折叠 `agent-preset/selected`、`tool/call`、`tool/result.meta`（整值 checkpoint）、`command/run`、`turn/end`；`dshCodingReasoning` 另折叠推理等级并在 `turn/end` 冻结每轮快照。
- **只读**：卡片与胶囊没有自定义事件处理，控制动作一律回流为 `/coding` 命令，前端不直接改 Host 状态。
- **视觉**：样式集中在 `src/client/styles.ts`，只用 `--dsw-*` 主题 token，不自定义字体、字号与配色。
- **配置页**（`plugins.bundle.config`）：`defaultMode` / `language` / `reasoning` 仍为下拉；三个 worker 模型字段也是下拉，首项固定是「自动（跟随主代理当前模型）」（值 `auto`），其余选项来自 Host 的会话模型目录 `ctx.remote.session.modelCatalog()`（`provider/model` 为值，`provider 显示名 · 模型名` 为标签，顺序沿用 Host 的 provider 分组顺序）。这份目录就是对话框模型选择器用的那一份：Host 用 `ctx.llm.listModels` 对每个已注册 provider 现取模型，所以 `cordis.patch.yml` 里静态声明、没有 settings profile 的第三方 provider（如 `qianwen-token-plan`）也在其中；旧方案逐个 `discoverModels` 枚举 provider，对这类 provider 必然拿不到模型。`catalog.failures` 显示为页面顶部诊断，空目录或 Remote 缺失时显示错误与「重新加载模型」。`auto` 不参与模型目录校验（不需要在列表里找到这一项）；手选的具体路由不在目录里时保留一项并标注“不在当前模型列表”；保存校验只看 `auto` 或合法 `provider/model` 格式。**恢复默认**只回填 `defaultMode`、三个模型（回填 `auto`）、`language`、`reasoning`（`DEFAULT_DRAFT`），不自动保存。页面顶部固定显示“请保持 Coding 预设全部开启状态，否则本插件无法工作。”；模型提示在无效时为警告色、有效时为普通提示色。

### 2.5 推理层：自动分类 + 配置固定 + 会话覆盖

`src/reasoning.ts` 在每次模型调用前决定本轮的推理等级，优先级从高到低：

1. 配置 `reasoning: low|high|max`：固定所有轮次，`coding_reasoning` 只报告不接受覆盖；
2. 会话覆盖：聊天框选择的 effort 或 `coding_reasoning` 工具；
3. 确定性分类器：问答/建议/单文件保持 Low；多文件、模块级审查或重构 High；项目级搭建/重构/审查、无法一次修复的缺陷 Max。同一轮内只升不降。

`agent/inbox/claimed` 在 Host 快照 step selection 之前同步选 effort，`agent/pre-step` 再兜底；选择经 `agent.model.select()` 写入，因此从下一步生效。

### 2.6 交接层：一份有界记录，取代“靠对话记住需求”

子代理有全新上下文，重启与翻页又只回放持久事件，所以阶段之间靠**显式记录**交接，而不是靠对话历史。`src/handoff.ts` 定义这份记录：

- **字段**：`goal`、`delivered`（写成交付记录）、`constraints`、`acceptance`（交付验证标准）、`findings`、`decisions`、`open`、`followUps`（残余风险与后续项）、`tasks`（每项 `goal` / `files` / `acceptance` / `avoid`）、`changes`（`file` + `summary`），外加 `version` 与 `updatedAt`。
- **读写**：工具 `coding_handoff` 属于 `stage` 类，每个阶段都能用（implement 阶段的裁剪表也保留它）。省略的字段不改动；列表追加并去重、只保留最新的 `HANDOFF_ITEMS_LIMIT` 条；`goal` 覆盖；`delivered` 同样覆盖，传空串即清除；`followUps` 追加、去重并按 `HANDOFF_ITEMS_LIMIT` 截断；`tasks` 整体替换；`changes` 按 `file` 合并，后来的摘要更新。`{ reset: true }` 只重置验证预算。
- **自动写回**：planner 返回的 `tasks` 与 summary、implement 报告的文件（记入 `changes`）与 notes、verify 的 findings 由运行时并入，模型不必重复抄写。**交付记录没有自动写回**：`delivered` / `followUps` 只由模型在 deliver 阶段显式调用 `coding_handoff({ delivered, followUps })` 写入——插件无法替它总结交付内容，也不为交付记录引入第二个真相源（没有新的 Session 事件，也没有新的投影字段）。
- **持久化与注入**：`checkpointOf` 携带交接记录（与 `verifyAttempts` / `verifyBlocked` 同批），`restoreFromView` 在重启与翻页时读回；`agent/pre-step` 用 `handoffDigest` 注入摘要，摘要里因此多出 `delivered: …` 与 `follow-ups: …` 两行；三个 worker 的提示词用 `handoffForWorker` 按角色裁剪——planner 拿 goal / delivered / constraints / 验收标准 / findings / 待答问题，implement 另加 decisions、任务清单与待答问题，verify 拿 goal / 验收标准 / changes / decisions / findings。为控制提示词体积，只有 `plan` 与 `implement` 分片渲染 `Delivered:` 段，`verify` 分片保持原样。
- **上限与校验**：`HANDOFF_TEXT_LIMIT` 600、`HANDOFF_ITEMS_LIMIT` 10、`HANDOFF_TASKS_LIMIT` 8、`HANDOFF_CHANGES_LIMIT` 20、`HANDOFF_DIGEST_LIMIT` 1200、`HANDOFF_WORKER_LIMIT` 2000；持久 JSON 一律经 `asHandoff` 重校验，版本不符或形状损坏按“无记录”处理。新增字段复用现有上限（`delivered` 走 `HANDOFF_TEXT_LIMIT`，`followUps` 走 `HANDOFF_ITEMS_LIMIT`），没有新增常量，也没有 bump `HANDOFF_VERSION`：旧 checkpoint 缺这两个字段时 `asHandoff` 补 `followUps: []`、`delivered: undefined`，记录照旧可用。
- **门禁**：codex 模式下 `plan` 前必须有 goal，`verify` 前必须有 acceptance，`deliver` 前两者都要有——状态行的 `handoff goal=set|missing, acceptance=N` 就是这一判定的可见形式。

### 2.7 上下文生命周期：谁在什么时候拿到什么

插件不把所有规则塞进一段全局系统提示词，也不靠对话历史传递需求：每一步真正进入模型请求的上下文都来自下面四类载体之一。这一节记录它们各自的作用域、写入路径与有损位置。

| 载体           | 位置                                        | 作用域              | 写入与读取                                                                                                                                |
| -------------- | ------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 阶段契约       | `src/contract.ts` 的 `stageContext`         | 单个 Step           | `agent/pre-step` 以 `dsh-coding-stage` 消息注入：模式契约 + 阶段路径 + 当前 stage + `statusLine` + handoff 摘要 + 上一次被拒原因            |
| 交接记录       | `src/handoff.ts`                            | 跨阶段、跨轮、跨重启 | 模型经 `coding_handoff` 写、运行时按 worker 报告并入；随 checkpoint 持久化，有界                                                          |
| 结构化任务单   | `todo_write` 产生的 `todo/write` 事件       | 单个会话的 plan / implement | 事件折叠进内存态 `state.plan`，进度又由 checkpoint 的 `planItems` / `openPlanItems` 进入投影                                        |
| worker 报告    | `outputSchema` + `asWorkerReport`           | 一次派发            | 校验后写回交接记录（或验证记录）与 `state.worker`，再进入下一步的契约                                                                      |

**阶段之间：每步只注入当前阶段的契约**

- 阶段推进后，下一步立刻拿到新阶段的契约段与刷新后的状态行；上一阶段的规则不再注入，提示词里只有当前该遵守的那一段。
- 跨阶段真正带过去的只有交接记录：模型在上一阶段写进 `coding_handoff` 的内容，经 `handoffDigest` 出现在下一步的 `## Handoff` 段。

**子代理之间：每个 worker 都是新作用域**

- spawn provider 不继承父上下文，每个 worker 拿到全新的扁平注册作用域。
- 提示词在派发时现拼：自包含 brief + 本角色 handoff 分片（`handoffForWorker`）+ 状态行（planner 与 verify）+ handoff 里没有 tasks 时附上的任务单文本（implement 与 verify）。
- 回报写回：planner → `tasks`（整体替换）与 summary 记入 `findings`；implement → `changes`（按 `file` 合并）与 notes 记入 `findings`，同时更新 `files` / `edits` 并清空旧的验证结果；verify → `source: 'worker'` 的验证记录与 `findings`。
- worker 之间共享的是记录，不是对话；同一时刻只有一个 worker 槽位，`state.worker` 仍在运行中时并发派发直接报错。
- 派发失败（模型不可用、启动失败、worker 未完成）走 `recordFailure`，下一次 `agent/pre-step` 用 `takeFailureNotice` 注入一条一次性通知，成功后 `clearFailure` 清除。

**跨轮：内存缓存 + 每步重新注入**

- 活跃 Agent 的状态是内存缓存（`CodingStateStore`，`WeakMap<agent>` 加 `bySession` 索引），不写进对话。
- 每步都重新渲染并注入契约，因此下一轮第一步看到的是「当前 stage / 任务进度 / 验证状态 / 交付记录摘要」，而不是上一轮的对话摘要。
- `/coding stage <name>` 用 `agent.steer` 注入一条控制消息，从下一步生效；`/coding <mode>` 用 `agent.followup` 起新一轮；`/coding set <mode>` 只改状态、不起 Turn。

**跨重启 / 重开：状态是缓存，Session 日志是真相**

- `agent/created` → `restore()` → 读投影 `dshCodingStage` 的 `stateOf` → `restoreFromView`；投影里既没有 checkpoint 也没有任务单（全新会话）时不做恢复。
- 恢复 mode / stage / plan / checkpoint（`handoff`、`verification`、`verifyAttempts`、`verifyBlocked`、`worker`、`planner`、`files`、`edits`、`runId` / `turn` / `step`），并把 `requirementsObserved` 至少置 1：checkpoint 证明上一段会话已经勘察过工作区。
- 明确不恢复 `refusal` / `lastRefusal`（旧的门禁拒绝不能阻塞重启后的第一步）与 `failureNotice`（原因已经通知过一次）；`failure` 本身随 checkpoint 恢复，但不再重复通知。
- 失败签名计数归零：重启无法知道上一次的失败签名，`sameFailureCount` 与 `lastFailureSignature` 从头开始，`deliveryBlocked` 也回到未阻塞。
- `planner` 尝试随整值 checkpoint 持久化（`checkpointOf`），由 `restoreFromView` 读回：旧 checkpoint 没有该字段视为“本会话未尝试”，形状畸形（缺 `route`、`outcome` 不是 `completed` / `failed`、`at` 不是数字）时 `asCheckpoint` 整值拒绝而不是静默丢弃；有尝试时状态行多一段 `planner completed|failed`。

**有损点**（写下来，避免被误判成投影丢失）：

- worker 的迭代过程与被读文件的完整内容；
- lead 的中间推理（它只需要工具结果与交接记录）；
- 验证命令输出全文：状态与 checkpoint 只留 `failedTests` 与 `errors`；
- `transitions`：只在内存里保留，上限 40 条；
- 交付记录内容：`delivered` / `followUps` 是模型自述，插件只校验形状、去重与长度；
- turn 快照只有 mode / stage / verification / planItems / openPlanItems / edits，不含交付记录——交付记录只存在于 checkpoint 的 handoff 里。
- 交接文档：它是本轮状态的快照，不含对话正文、worker 迭代过程与验证输出全文；下一轮续接仍以 `coding_handoff` 的实时记录为准。

**一次完整往返**：

```text
用户消息
  └─ agent/pre-step：注入阶段契约 + statusLine + handoff 摘要（含 delivered: … / follow-ups: …）
      └─ 模型工具调用
          ├─ 门禁判定（pre-execute waterfall → guard）
          ├─ delegate_* 派发：brief + 本角色 handoff 分片 + 状态行 → worker 结构化报告
          │    └─ 报告写回 handoff（tasks / changes / findings）与状态
          └─ coding_stage / coding_handoff / run_verification
              └─ 工具结果携带整值 checkpoint（handoff 在其中）
  └─ deliver 阶段：coding_handoff({ delivered, followUps }) 写回交付记录
      └─ turn/end 冻结本轮卡片
下一轮 → agent/pre-step 再次注入，handoff 摘要里就有上一轮的 delivered: … / follow-ups: …
```

### 2.8 交接文档：把本轮结果落成一篇 Markdown

`/coding memory` 把本轮状态机与交接记录写成一篇中文 Markdown，落到 `<会话 cwd>/.agents/memory/<清洗后的 sessionId>-<UTC YYYYMMDD-HHmmss>.md`。

- **触发条件**：会话控制卡片只为「最新一轮（live）+ codex 模式 + 该轮冻结阶段为 `deliver` + 该轮验证通过」的轮次渲染「结束任务并生成交接文档」按钮（英文 `End task & write handoff`）；历史轮、非 codex 轮、验证未通过或 BLOCKED 交付的轮次没有按钮。点击后进入卡片内二次确认（「确认生成」/「取消」），不是系统弹窗；确认后经 `remote.commands.execute(sessionId, '/coding memory', [])` 回流 Host。
- **命令与写入路径**：`/coding memory` → `src/memory.ts` 的 `writeMemoryDocument` → 从 `agent.ctx` / 插件 `ctx` 取 `fs` 服务 → `fs.resolve('.agents/memory/<文件名>', { cwd, signal })` 得到 `{ targetKey, displayPath }` → `fs.writeText(target, content, { kind: 'createIfAbsent' }, signal, policy)`。DSH 的写入实现会 `mkdir(dirname, { recursive: true })`，所以 `.agents/memory` 不存在时自动创建。命令处理器是 async：结果以 `command/done` 的 `{kind, text}` 持久记录，成功收据是 `handoff document written: <displayPath> (session <sessionId>)`。
- **文件名**：`memoryFileName(sessionId, at)` 把 sessionId 里 `[^A-Za-z0-9._-]` 的字符换成 `-`（清洗后为空用 `session`），时间戳取 UTC 的 `YYYYMMDD-HHmmss`，扩展名 `.md`；重复点击各写一篇新文件，`createIfAbsent` 不覆盖已有文件。
- **内容**：标题与头部（会话、生成时间（UTC）、工作目录、模式 / 阶段、轮次、状态为正常交付或阻塞交付（BLOCKED）），随后按「有内容才输出」追加章节：目标、约束、验收标准、交付记录、后续跟进、决策、发现、待答问题、任务清单、交接任务、改动文件、未并表的改动路径、验证、阶段轨迹，以及固定的「下一轮怎么接」。空章节整节省略（不写「无」）。文档只取状态机与 `coding_handoff` 记录加会话头部（cwd / sessionId），**不回读对话正文**，也不新增 Session 事件；超过 `MEMORY_LIMIT`（20000 字符）截断到最后一个完整行并标注「文档已截断」。
- **失败处理**：缺 `fs` 服务、会话没有 cwd、写入抛错（同名文件已存在、沙箱不允许等）都收成 `{ ok: false, reason, action }`，命令渲染为 `{kind:'error', text: '<原因> — <处理>'}` 收据；不抛未捕获异常。卡片侧失败显示「未能生成交接文档，请重试或执行 /coding memory。」。
- **边界**：按钮只生成文档，**不结束会话、不改变 stage / mode、不停止任何运行时状态**；需要收尾任务时按原有方式让本轮正常结束。

## 3. 阶段化交付契约

交付契约按阶段拆成五段（`src/contract.ts`），随 `agent/pre-step` 注入，而不是塞进一段全局系统提示词：

| 阶段         | 要点                                                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| requirements | 确认目标、交付物、约束；读 AGENTS.md 与目标文件；只读；用 `coding_handoff` 记录 goal / constraints / acceptance（codex 无 goal 不能进 plan）；需求不清用 `coding_mode` 回退问答 |
| plan         | 目标与可观察验收；若 handoff 已有 `Delivered` 段，按续接轮处理（从该记录与 follow-ups 出发，不重做上一轮）；`delegate_plan` 输出单一职责子任务，并自动并入交接记录；每个子任务写清目标、涉及文件、验收标准、不碰的范围；`todo_write` 小改单文件 1–3 步、多文件 4–6 步，严格大于三条必须先 `delegate_plan`（派发失败也算尝试；planner 为 `auto`、主 Agent 是 planner 路由或 `requirePlanner: off` 时豁免） |
| implement    | 主代理不能编辑；给 worker 自包含任务并带上交接的 goal / constraints / 验收标准；报告的文件自动并入 changes；编辑数决定验证门禁                                                  |
| verify       | 先窄后宽；先有 acceptance 才能进入；失败按预算记账，耗尽后 deliver 只能 BLOCKED；不得声称未运行的检查                                                                           |
| deliver      | 需 goal + acceptance；结束前用 `coding_handoff({ delivered, followUps })` 写回交付记录（下一轮与重开的会话读记录，不读本轮正文）；先结论、再文件路径、再验证证据与残余风险；BLOCKED 交付只报失败证据 |

## 4. 配置参考

| 字段                    | 必填 | 默认                               | 说明                                                    |
| ----------------------- | ---- | ---------------------------------- | ------------------------------------------------------- |
| `defaultMode`           | 否   | `auto`                             | 新会话初始模式                                          |
| `plannerWorkerModel`    | 是（`auto` 或 `provider/model`） | `auto` | `auto` 派发时跟随主代理当前模型；也可填一条 pro 路由负责勘探与拆分任务 |
| `requirePlanner`        | 否   | `complex`                          | `complex` / `off`；`complex` 时 codex 任务单严格大于三条必须先 `delegate_plan`，`off` 关闭该门禁。非 volatile，只能在插件包配置里改 |
| `implementWorkerModel`  | 是（`auto` 或 `provider/model`） | `auto` | `auto` 派发时跟随主代理当前模型；也可填 `provider/model` |
| `verifyWorkerModel`     | 是（`auto` 或 `provider/model`） | `auto` | `auto` 派发时跟随主代理当前模型；也可填 `provider/model` |
| `language`              | 否   | `auto`                             | `auto` 跟随 DSH 界面 → 系统语言 → 宿主 locale           |
| `reasoning`             | 否   | `auto`                             | `auto` 每轮分类；`low`/`high`/`max` 固定所有轮次        |
| `maxVerifyAttempts`     | 否   | `5`                                | 允许的失败验证次数；`0` 不限制；耗尽后放行 BLOCKED 交付 |
| `maxSameFailure`        | 否   | `2`                                | 相同失败签名连续出现上限；`0` 不限制                    |
| `verificationTimeoutMs` | 否   | `360000`                           | 单次验证命令超时（ms），`0` 不限制；超时记为失败        |
| `verificationCommands`  | 否   | `{}`                               | 按 `kind` 或 `kind:scope` 覆盖自动探测的命令            |

worker 路由只有两种取值：`auto` 或显式 `provider/model`。`auto` 在 Host 设置行与 `preflight` 里都只做哨兵识别——挂载期没有 agent 上下文，不解析主代理模型——只在派发时由 `resolveWorkerRoute` 解析为主代理当前模型；解析结果仍过 `assertWorkerModel`（provider 注册 + 模型目录），主代理模型读不到抛 `AUTO_UNAVAILABLE`，provider 缺失或模型不可用同样失败，任何一步失败都不会回退或替换成别的路由。显式 `provider/model` 走原语义：Host 设置行要求格式正确，`preflight` 挂载时解析并检查 provider，派发前再校验模型可用性。`requirePlanner` 与两个预算键是普通字段，只能在插件包配置里改。

## 5. 已知限制

1. **门禁是工具级边界**：`bash` / `pwsh` 属于 `exec` 类，同一类里既有只读检查也有能改文件的命令，插件只按类判定、无法逐条区分——这是有意保留的能力缺口。因此 `exec` 在 requirements、plan、implement、verify 都准入，只有 `deliver` 不授予（交付只报告，不执行命令）：implement 阶段主代理可以自己跑安装、`git` 与一次性命令，但**编辑文件仍然只能通过 `delegate_implement`**（`apply_patch` / `edit` / `write` 既不在工具表里，也被门禁拒绝）；verify 的正式检查仍走 `run_verification` 以留下可交付的证据，临时命令只用于复现失败。双层仍然一致：门禁按类拒绝（`checkTool`），工具表按名字裁剪（`IMPLEMENT_TABLE` 同时列 `bash` 与 `pwsh`，由 `syncTable` 按平台收窄）。verify worker 本身没有 shell。
2. **DSH 没有隐藏预设的开关**：本插件在 Host 侧过滤对外花名册；worker 预设（planner / implement / verify 与带仓库指令的 verify 变体，共四个）仍在注册表中供子代理派发，但不出现在客户端预设列表。
3. **不写自定义持久事件类型**：DSH 拒绝重开含未知非 `ignorable` 事件的会话，所以投影折叠的是本插件工具已经产生的持久事件。
4. **未分类的第三方工具不受阶段门禁约束**（门禁只覆盖它能判断语义的编码工具），避免误伤其他插件的交互类工具。
5. **verify worker 的报告是子代理的声明**：插件要求报告携带命令否则判失败，但无法验证该命令确实执行过；主代理可在 verify 阶段用 `read` 与 `run_verification` 复核。
6. **交接记录（含交付记录）是模型主动写的摘要**：`delivered` / `followUps` 与 goal / acceptance 一样由模型写入，插件只校验形状、去重、按 `HANDOFF_TEXT_LIMIT` / `HANDOFF_ITEMS_LIMIT` 截断，无法验证内容是否真实，交付记录也不会被自动生成或自动写回。写漏交付记录只会让下一轮缺少上下文，不会让门禁变宽松，也不会自动补上；写漏 goal / acceptance 则会让门禁拒绝。
7. **验证预算按失败签名判定**：模型换一种失败方式（不同失败测试、不同错误行或退出码）会重新计数，`maxSameFailure` 因此可能永远不耗尽，最终只能靠 `maxVerifyAttempts` 停下。
8. **`verifyBlocked` 只阻止“声称成功”**：它放行 `deliver` 的推进并标记为 BLOCKED，但交付内容仍是模型自我报告，插件无法验证报告是否诚实。
9. **模型目录不可用时无法提前发现不存在的模型**：只有派发时的 `WorkerModelError` 会暴露它；目录可读时同一错误会列出可用模型。
10. **超时只保证插件侧返回失败并请求终止**：`terminate` 只是请求；若子进程 provider 不响应，宿主上残留的进程仍需外部清理。
11. **失败通知是尽力而为的提示**：它随下一次 `agent/pre-step` 注入；若异常直接终止了 Turn（没有下一步），就没有可注入的位置，此时原因只能由 DSH 的 Turn 错误或插件挂载错误呈现。
12. **交接文档按钮不结束任务**：按钮名为「结束任务并生成交接文档」，实际只写一篇文档，不改变会话状态（不结束会话、不改 stage / mode、不停止运行时）。文档内容是状态机快照 + 模型自述的 handoff，插件不校验其真实性；文件名用 UTC，重名只在同一会话同一秒重复点击时可能，`createIfAbsent` 会拒绝覆盖并返回错误收据。
