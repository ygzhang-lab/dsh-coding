# DSH Coding 编程智能体 — 设计思路与分层结构

DSH 编程智能体运行时插件，借鉴 Claude 任务编排机制，Codex 五段式契约层层推进，DeepSeek Pro 分析需求、编排任务，Flash 子智能体去干活，确保任务交付质量和 Token 价值最大化。

本文说明插件为什么这样设计、由哪些层组成，以及每层的职责边界；供使用者理解行为、供维护者规划迭代。目录、构建与测试见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 1. 设计出发点

普通 Coding 预设靠系统提示词要求模型“先需求分析、再规划、再修改、再验证”，模型可以遵守也可以跳过。本插件把同一套节奏交给 DSH 的事件系统执行：

- **阶段由插件判定**：`requirements → plan → implement → verify → deliver`，模型只能提出推进请求；是否放行由插件依据事实（是否完成需求分析、是否有任务单、是否有编辑落盘、最近一次验证是否通过）决定。
- **工具由插件裁剪**：实现阶段主代理的工具表只剩委派与控制类工具，编辑工具既不可见，也会被兜底守卫拒绝。
- **编辑在隔离子代理中完成**：implement worker 有独立上下文与独立模型路由，只拿到显式放行的编辑工具。
- **阶段之间靠有界记录交接**：目标、验收标准、决策与任务写进 `coding_handoff`，worker 只读自己那一份摘要，而不是靠对话历史传递需求。
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

| 机制 | 位置 | 作用 |
| --- | --- | --- |
| `coding_stage` | `src/preset.ts` → `src/state.ts` | 请求查看/推进阶段，`checkAdvance` 判定 |
| `tools/pre-execute` waterfall | `src/preset.ts` | 返回 `{ kind: 'deny', reason }`，reason 含当前阶段、允许阶段与补救动作 |
| `ctx.tools.guard()` | `src/preset.ts` | 同一条规则注册为单调拒绝，pre-execute 放行后仍然生效 |
| `agent/pre-step` | `src/preset.ts` | 注入当前阶段契约与状态；跳过门禁时拒绝该 Step |

**为什么用 `deny` 而不是 `ask`**：`ask` 会把调用转交审批通道，语义是“询问用户是否允许”；阶段门禁是确定性规则，模型需要看到 `Error: <reason>` 并据此调整行为。

**两层分工**：waterfall 负责友好拒绝与可操作提示，guard 是最终安全边界。真实派发顺序是 pre-execute →（ask）→ `checkGuards` → 派发，所以即使别的监听器先返回 `allow`，guard 仍拒绝。

**阶段门禁条件**（`checkAdvance`）：

| 目标阶段 | 条件 |
| --- | --- |
| `plan` | 至少一次成功的只读/检查观察（`requirementsObserved > 0`）；codex 模式还要求 handoff 里已有 goal |
| `implement` | 存在 `todo_write` 写入的结构化任务单 |
| `verify` | codex 模式下有落盘编辑，且 handoff 里已有验收标准；review 模式不要求 |
| `deliver` | codex 模式要求最近一次验证通过（预算耗尽时放行一次 BLOCKED 交付），且 handoff 里有 goal 与验收标准；review 模式要求至少跑过一次 |
| 选工作流 | auto 模式先 `coding_mode` 选择 consult / review / codex |

回退（如 verify → implement）不受前向条件限制；模式切换后若当前阶段不属于新模式，自动回到该模式的首阶段。

**跳阶段的代价**：拒绝后 `agent/pre-step` 返回 `{ kind: 'reject' }`，Turn 以 `blocked` 结束；被拒绝的 Step 不把消息放回 Inbox，拒绝原因会在下一步契约里重新注入，模型因此知道为什么被拦下。

**失败上报**（`src/failures.ts`）：运行时在八个调度点捕获阻断性异常——`projection`、`restore`、`tool-table`、`reasoning`、`delegate`、`verification`、`handoff`、`command`。`makeFailure(point, error, language)` 生成 `CodingFailure { point, reason, action, at }`：`reason` 是异常消息（裁剪到 600 字符，空消息记为 `unknown error`），`action` 是该点针对性的下一步（按会话语言 zh/en 渲染，点名的配置字段与操作可直接照做）。`recordFailure(state, failure)` 同时写入 `failure`（当前未恢复的异常）与一次性 `failureNotice`；`agent/pre-step` 在应用推理等级之后用 `takeFailureNotice` 取走它，作为一条 `dsh-coding-control` 消息（`## dsh-coding 运行中断（<点>）` + 原因 + 处理）注入本步。该环节下一次成功时 `clearFailure(state, point)` 按点清除，因此一个子系统恢复不会掩盖另一个仍存在的异常；重启时 `restoreFromView` 只恢复 `failure`、不恢复通知，用户不会重新收到同一条提示。`statusLine` 显示 `failure <point>`，`checkpointOf` 把 `failure` 随工具结果持久化，旧 checkpoint 没有该字段照旧兼容。这条通道**不新增 Turn、不新增事件类型、只在异常时注入一条消息**：稳态下没有任何额外消息，历史不被改写，因此不影响缓存命中率。

### 2.2 执行层：子代理隔离 + 模型路由

实现阶段主代理的工具表被 `agent.ctx.tools.restrict({ allow })` 裁剪为：

```
delegate_implement · coding_handoff · todo_write · coding_stage · coding_mode · coding_reasoning
```

`delegate_*` 派发时显式传入：`provider: 'spawn'`、`agentPreset`（= 子代理工具白名单）、`agentOptions.provider/model`（配置里的 worker 路由）、`delivery: 'caller'`（结果只回给本次调用）、`outputSchema`（结构化报告）。子代理拿到全新的扁平注册作用域，父级 `restrict` 不会带入，因此白名单只能写在组合里。

三个 worker 预设的插件列表（`cordis.patch.yml`）就是它们的权限清单：

| worker | 实际工具 |
| --- | --- |
| planner | `read` / `glob` / `grep` / `web_search` / `web_fetch`（只读） |
| implement | `read` / `write` / `edit` / `glob` / `grep` / `apply_patch` |
| verify | `read` / `glob` / `grep` / `run_verification`（无编辑、无 shell） |

**模型路由与缺失处理**（`src/models.ts`）：

- 路由只有一个出口：`resolveWorkerRoute(config, role)` 按角色读固定字段（`plannerWorkerModel` / `implementWorkerModel` / `verifyWorkerModel`），要求正好是 `provider/model`，返回带 `role`、字段名与渲染文本的路由。`preflight` 在挂载时对三个角色各解析一次，因此缺失或格式错误直接挂载失败；注册表可读时 provider 是否存在也在挂载时检查。
- 模型是否存在要查模型目录，而目录可能需要凭据，所以挂载阶段不判模型：目录不可用时校验延后到派发，不阻塞挂载。
- 派发前 `assertWorkerModel(ctx, route)` 现查现用：provider 不在 `ctx.llm.listProviders()` 里抛 `WorkerModelError`（`PROVIDER_MISSING`）；`ctx.llm.resolveModelInfo` 失败抛 `MODEL_UNAVAILABLE`，并附上 `ctx.llm.listModels` 给出的该 provider 可用模型（目录不可用时列表为空）。
- 错误文案给出配置字段名、当前路由、可用模型与修复位置，并明确「worker 永不回退主代理模型」。失败的那次派发会记进 worker 记录，修好配置后重试原调用即可；同一路由重试只会得到同样的失败。
- 默认路由：planner 用 `deepseek-account/deepseek-v4-pro`（pro 模型），implement / verify 用 `deepseek-account/deepseek-flash`；`deepseek-account` 当前内置目录是 `deepseek-flash` 与 `deepseek-v4-pro`，默认值必须在这个集合内。

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
- **会话控制卡片**：`conversation.chat.turnTail` 注册 `dsh-coding/turn-card`。每轮一张，显示模式、该模式开放的阶段路径、推理等级与来源、验证状态、任务单进度、改动文件数；最新一张可切换模式，旧卡片冻结在那一轮实际运行的模式与阶段。
- **阶段胶囊**：`conversation.chat.node` 以 `coding-stage` 键注册 `ConversationNodeDefinition` 与渲染器，每次 Coding 工具调用处显示该次调用后的阶段与验证。
- **数据源**：持久会话投影 `dshCodingStage`（`ctx.sessionProjections`），折叠 `agent-preset/selected`、`tool/call`、`tool/result.meta`（整值 checkpoint）、`command/run`、`turn/end`；`dshCodingReasoning` 另折叠推理等级并在 `turn/end` 冻结每轮快照。
- **只读**：卡片与胶囊没有自定义事件处理，控制动作一律回流为 `/coding` 命令，前端不直接改 Host 状态。
- **视觉**：样式集中在 `src/client/styles.ts`，只用 `--dsw-*` 主题 token，不自定义字体、字号与配色。
- **配置页**（`plugins.bundle.config`）：`defaultMode` / `language` / `reasoning` 仍为下拉；三个 worker 模型字段也是下拉，选项由 `ctx.remote.llm` 的 `listProviders` + `listConfigurableProviders` + `discoverModels` 现取现拼（`provider/model` 为值，`显示名 · 模型名` 为标签，按 provider 再按标签排序），当前值不在目录里时保留一项并标注“不在当前模型列表”，字段与提示转警告色并禁用保存；目录加载失败同样只显示警告 + 重试按钮并禁用保存，不会静默写入未校验路由。**恢复默认**只回填 `defaultMode`、三个模型、`language`、`reasoning`（`DEFAULT_DRAFT`），不自动保存。页面顶部固定显示“请保持 Coding 预设全部开启状态，否则本插件无法工作。”；模型提示在无效时为警告色、有效时为普通提示色。

### 2.5 推理层：自动分类 + 配置固定 + 会话覆盖

`src/reasoning.ts` 在每次模型调用前决定本轮的推理等级，优先级从高到低：

1. 配置 `reasoning: low|high|max`：固定所有轮次，`coding_reasoning` 只报告不接受覆盖；
2. 会话覆盖：聊天框选择的 effort 或 `coding_reasoning` 工具；
3. 确定性分类器：问答/建议/单文件保持 Low；多文件、模块级审查或重构 High；项目级搭建/重构/审查、无法一次修复的缺陷 Max。同一轮内只升不降。

`agent/inbox/claimed` 在 Host 快照 step selection 之前同步选 effort，`agent/pre-step` 再兜底；选择经 `agent.model.select()` 写入，因此从下一步生效。

### 2.6 交接层：一份有界记录，取代“靠对话记住需求”

子代理有全新上下文，重启与翻页又只回放持久事件，所以阶段之间靠**显式记录**交接，而不是靠对话历史。`src/handoff.ts` 定义这份记录：

- **字段**：`goal`、`constraints`、`acceptance`（交付验证标准）、`findings`、`decisions`、`open`、`tasks`（每项 `goal` / `files` / `acceptance` / `avoid`）、`changes`（`file` + `summary`），外加 `version` 与 `updatedAt`。
- **读写**：工具 `coding_handoff` 属于 `stage` 类，每个阶段都能用（implement 阶段的裁剪表也保留它）。省略的字段不改动；列表追加并去重；`goal` 覆盖；`tasks` 整体替换；`changes` 按 `file` 合并，后来的摘要更新。`{ reset: true }` 只重置验证预算。
- **自动写回**：planner 返回的 `tasks` 与 summary、implement 报告的文件（记入 `changes`）与 notes、verify 的 findings 由运行时并入，模型不必重复抄写。
- **持久化与注入**：`checkpointOf` 携带交接记录（与 `verifyAttempts` / `verifyBlocked` 同批），`restoreFromView` 在重启与翻页时读回；`agent/pre-step` 用 `handoffDigest` 注入摘要；三个 worker 的提示词用 `handoffForWorker` 按角色裁剪——planner 拿 goal / constraints / 验收标准 / findings / 待答问题，implement 另加 decisions 与任务清单，verify 拿 goal / 验收标准 / changes / decisions / findings。
- **上限与校验**：`HANDOFF_TEXT_LIMIT` 600、`HANDOFF_ITEMS_LIMIT` 10、`HANDOFF_TASKS_LIMIT` 8、`HANDOFF_CHANGES_LIMIT` 20、`HANDOFF_DIGEST_LIMIT` 1200、`HANDOFF_WORKER_LIMIT` 2000；持久 JSON 一律经 `asHandoff` 重校验，版本不符或形状损坏按“无记录”处理。
- **门禁**：codex 模式下 `plan` 前必须有 goal，`verify` 前必须有 acceptance，`deliver` 前两者都要有——状态行的 `handoff goal=set|missing, acceptance=N` 就是这一判定的可见形式。

## 3. 阶段化交付契约

交付契约按阶段拆成五段（`src/contract.ts`），随 `agent/pre-step` 注入，而不是塞进一段全局系统提示词：

| 阶段 | 要点 |
| --- | --- |
| requirements | 确认目标、交付物、约束；读 AGENTS.md 与目标文件；只读；用 `coding_handoff` 记录 goal / constraints / acceptance（codex 无 goal 不能进 plan）；需求不清用 `coding_mode` 回退问答 |
| plan | 目标与可观察验收；`delegate_plan` 输出单一职责子任务，并自动并入交接记录；每个子任务写清目标、涉及文件、验收标准、不碰的范围；`todo_write` 3–6 步 |
| implement | 主代理不能编辑；给 worker 自包含任务并带上交接的 goal / constraints / 验收标准；报告的文件自动并入 changes；编辑数决定验证门禁 |
| verify | 先窄后宽；先有 acceptance 才能进入；失败按预算记账，耗尽后 deliver 只能 BLOCKED；不得声称未运行的检查 |
| deliver | 需 goal + acceptance；先结论、再文件路径、再验证证据与残余风险；BLOCKED 交付只报失败证据 |

## 4. 配置参考

| 字段 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `defaultMode` | 否 | `auto` | 新会话初始模式 |
| `plannerWorkerModel` | 是 | `deepseek-account/deepseek-v4-pro` | `provider/model`；默认 pro 模型负责勘探与拆分任务 |
| `implementWorkerModel` | 是 | — | `provider/model` |
| `verifyWorkerModel` | 是 | — | `provider/model` |
| `language` | 否 | `auto` | `auto` 跟随 DSH 界面 → 系统语言 → 宿主 locale |
| `reasoning` | 否 | `auto` | `auto` 每轮分类；`low`/`high`/`max` 固定所有轮次 |
| `maxVerifyAttempts` | 否 | `5` | 允许的失败验证次数；`0` 不限制；耗尽后放行 BLOCKED 交付 |
| `maxSameFailure` | 否 | `2` | 相同失败签名连续出现上限；`0` 不限制 |
| `verificationTimeoutMs` | 否 | `360000` | 单次验证命令超时（ms），`0` 不限制；超时记为失败 |
| `verificationCommands` | 否 | `{}` | 按 `kind` 或 `kind:scope` 覆盖自动探测的命令 |

worker 路由分三步校验：Host 设置行要求必填且格式为 `provider/model`，预设插件挂载时再解析一次（注册表可读时也检查 provider），派发前用 `assertWorkerModel` 校验模型可用性。任何一步失败都不会回退主代理模型。两个预算键是普通字段，只能在插件包配置里改。

## 5. 已知限制

1. **门禁是工具级边界**：`bash` 能改文件，所以它在 implement / verify / deliver 被拒，verify worker 完全没有 shell；精确命令只走 `run_verification`。requirements / plan 仍允许 shell（需求分析需要），这是有意保留的能力缺口。
2. **DSH 没有隐藏预设的开关**：本插件在 Host 侧过滤对外花名册；三个 worker 预设仍在注册表中供子代理派发，但不出现在客户端预设列表。
3. **不写自定义持久事件类型**：DSH 拒绝重开含未知非 `ignorable` 事件的会话，所以投影折叠的是本插件工具已经产生的持久事件。
4. **未分类的第三方工具不受阶段门禁约束**（门禁只覆盖它能判断语义的编码工具），避免误伤其他插件的交互类工具。
5. **verify worker 的报告是子代理的声明**：插件要求报告携带命令否则判失败，但无法验证该命令确实执行过；主代理可在 verify 阶段用 `read` 与 `run_verification` 复核。
6. **交接记录是模型主动写的摘要**：插件只校验形状、去重并裁剪长度，无法验证内容真实；写漏的 goal / acceptance 只会让门禁拒绝，不会让门禁变宽松。
7. **验证预算按失败签名判定**：模型换一种失败方式（不同失败测试、不同错误行或退出码）会重新计数，`maxSameFailure` 因此可能永远不耗尽，最终只能靠 `maxVerifyAttempts` 停下。
8. **`verifyBlocked` 只阻止“声称成功”**：它放行 `deliver` 的推进并标记为 BLOCKED，但交付内容仍是模型自我报告，插件无法验证报告是否诚实。
9. **模型目录不可用时无法提前发现不存在的模型**：只有派发时的 `WorkerModelError` 会暴露它；目录可读时同一错误会列出可用模型。
10. **超时只保证插件侧返回失败并请求终止**：`terminate` 只是请求；若子进程 provider 不响应，宿主上残留的进程仍需外部清理。
11. **失败通知是尽力而为的提示**：它随下一次 `agent/pre-step` 注入；若异常直接终止了 Turn（没有下一步），就没有可注入的位置，此时原因只能由 DSH 的 Turn 错误或插件挂载错误呈现。
