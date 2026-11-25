# src/AGENTS.md — 源码层维护指南

本文件只服务 `src/`（含 `src/client/`）下的改动：先说这块代码要达成什么，再给 DSH 契约表、实现约束、模块表与调试表。
通用命令、构建产物、发布与跨平台注意事项见根 [AGENTS.md](../AGENTS.md)。

## src/ 的目标与成功标准

`src/` 是插件唯一的实现层。目标是让 DSH 的事件、工具、会话契约在这里落地成「五阶段（requirements → plan → implement → verify → deliver）+ 每步有证据」，同时不新增 Session 事件、不绕过宿主契约——破了这两条，证据链就接不上，五阶段只剩模型自觉。

一次好的改动：门禁仍只用 `deny` 且裁剪与拒绝双层一致；工具裁剪与实际可见集对得上；`auto` 路由只在派发时解析且失败不回退；状态只经整值 checkpoint 持久化；`pnpm typecheck && pnpm build && pnpm test` 全绿。

下面三节按这个标准排：模块表回答「谁在哪」，契约表记录「宿主的真实行为」，实现约束说明「改这些地方时不能破坏什么」；最后的调试表是出了问题对着现象找原因用的。

## src 模块表

```
src/
  index.ts            Host 设置服务（ctx.dshCodingRuntime）
  preset.ts           预设主插件：双层门禁、pre-step、工具、/coding 命令、语言提示、投影；leadIsPlanner 与 requirePlanner 在此接线进 checkAdvance
  editor.ts           apply_patch（主预设 + implement worker 共用）
  verifier.ts         run_verification 入口（verify worker）
  core/stages.ts      阶段/模式常量、工具分类、阶段准入、checkpoint 类型（宿主+浏览器共用）
  core/state.ts       每 Agent 状态机、推进门禁（含 planner 门禁，阈值 PLANNER_TODO_THRESHOLD = 3）、工具判定、工具表裁剪、验证预算、checkpoint
  core/contract.ts    按阶段拆分的交付契约片段
  core/handoff.ts     跨阶段交接与交付记录：合并去重、摘要渲染、worker 分片、checkpoint 校验（纯函数，浏览器可用）
  core/messages.ts    dsh-coding-stage / dsh-coding-control 消息源
  core/failures.ts    阻断性异常的结构化记录与中英文通知渲染
  config/config.ts    Config（Schemastery）、configSchema、路由解析
  config/models.ts    worker 模型路由：resolveWorkerRoute / assertWorkerModel / WorkerModelError
  config/worker-auto.ts worker 模型字段的 auto 哨兵（宿主 + 浏览器共用）
  config/volatile.ts  Schemastery volatile 取值助手 volatileValue（宿主 + 浏览器共用）
  reasoning/reasoning.ts 推理等级：分类器、effort 映射、每会话控制器
  reasoning/reasoning-levels.ts 三级推理等级（low/high/max）与 levelForEffort 纯映射（浏览器可用）
  language/language.ts 会话语言解析（auto/zh/en）
  language/system-language.ts macOS AppleLanguages 探测（Host-only）
  projections/coding-projection.ts dshCodingStage 持久投影
  projections/reasoning-projection.ts dshCodingReasoning 持久投影
  tools/patch.ts      Codex patch 语法解析
  tools/apply-patch.ts apply_patch 工具
  tools/verification.ts 命令解析 + ctx.subprocess 执行 + 失败输出解析
  tools/verification-tool.ts run_verification 工具定义
  commands/coding-init.ts  /coding init 同步执行器：空项目闸门、按章节分批调用模型（planSectionBatches）、生成/更新两阶段写盘、ctx.fs 守卫与 sandboxPolicy
  commands/coding-init-async.ts  /coding init 异步提交器：轻量预检、立即回执、后台单飞、完成/失败经 followup 通知
  commands/memory.ts  任务交接文档：文件名、Markdown 组装、经 fs 服务写盘（Host-only）
  commands/command-text.ts   /coding 命令面的中英双语文案：commandText（状态/重置/阶段与模式/memory/异常收尾/命令描述与 hint）与 initText（/coding init 的回执、后台通知与 headline 模板）；纯函数、无 I/O
  docgen/background-task.ts   后台任务运行器：runMaintenance 优先、忙时退回 detached + 超时、吞掉 rejection
  docgen/project-scan.ts      项目证据扫描：workspace 声明/模块检测（启发式模块最多两级，三级及更深收敛到二级祖先）、可复制命令、README/CI/依赖提取；getFilesModifiedSince 供非 git 回退
  docgen/agents-doc.ts        文档工具：## 章节切分合并、不套模板的 composeGeneratedDoc、占位符按行清洗与空章节裁剪、受影响章节、planSectionBatches 章节分批器（每批 ≤ BATCH_MAX_SECTIONS）；模板渲染只作提示词参考草稿
  docgen/doc-context.ts       模型上下文组装：项目事实/草稿、现有文档、源码与 README/docs 摘录、变更列表；可选 sections 按批收窄提示词；参考章节表只作参考、草稿清洗占位符；总字符与单文件摘录上限；不 import node:fs
  docgen/doc-model.ts         一次性模型调用：leadRouteOf → ctx.llm.prepareCall → prepared.stream → BlockAssembler；只接受 stop，失败收成 ok:false，不回退模板
  docgen/git.ts               spawn + 固定 argv（-C / --no-pager / color.ui / core.quotepath）、有界输出、超时、GitError；getChangedFiles 只收成结果对象（tag 基线优先，回退最近 7 天/未跟踪）不抛错
  client/             浏览器半：index / definition / capsule / mode-picker / card /
                      command-row / config-page / styles / locales
```

## 1. 已核实的 DSH 契约（改动前必须复核）

以下结论来自运行时 `cordis_inspect_query` 与安装目录源码。改代码前请用同样方法复核，**不要凭记忆或旧版本行为改**。

| 契约                         | 事实                                                                                                                    | 出处                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `PreToolDecision`            | `allow / deny{reason, info?} / cancel / ask{reason, displayReason}`；deny 产生 `Error: <reason>`                        | `dsh-tools/src/contracts.ts`、`pipeline.ts`    |
| 派发顺序                     | pre-execute waterfall →（ask 转审批）→ `checkGuards` → 派发；guard 拒绝单调生效                                         | `dsh-tools/src/pipeline.ts`                    |
| `tools.guard(guard)`         | 同步守卫，注册在当前 scope；`checkGuards` 遍历 global + agent 作用域链                                                  | `dsh-tools/src/index.ts`                       |
| `tools.restrict(filter)`     | 必须在 scoped ctx（`agent.ctx`）调用；拒绝未知工具名；多个限制取交集                                                    | `dsh-tools/src/index.ts`                       |
| `ctx.tools.schemas/view`     | `schemas(scope)` 返回**已受限**的 visible 定义；未受限的全局工具名在 `view(scope).restrictableNames`，`restrict()` 也按它校验名字 | `dsh-tools/src/index.js`                       |
| `agent/pre-step`             | `{kind:'reject'}` 或 `{kind:'enter', messages, startsRequestSeries?}`；拒绝后 Turn 以 `blocked` 结束                    | `dsh-agent`、`dsh-agent-loop`                  |
| `AgentOptions`               | 只有 `provider / model / reasoningEffort / maxTokens`，**没有工具字段**                                                 | `dsh-agent/src/runtime-types.ts`               |
| `SubagentStartRequest`       | 有 `agentPreset / agentOptions / outputSchema / cwd / maxDepth`；**没有** `toolFilter`                                  | `dsh-subagent/src/types.ts`                    |
| spawn provider               | `agentOptions / agentPreset / outputSchema / depthLimit` 全为 true；不继承父上下文                                      | `dsh-subagent-spawn-in-process/src/index.ts`   |
| 结构化子代理                 | `outputSchema` 注册 `structured_output` 工具、追加提示并校验取值                                                        | `dsh-subagent/src/structured.ts`               |
| 会话事件                     | 未知且非 `ignorable` 的事件会让 Session 拒绝重开                                                                        | `dsh-session/src/index.ts`                     |
| 新会话首页                   | `conversation.hero.options` 仅在空白首页且存在 `sessionId` 时渲染                                                       | `dsh-client-ui-conversation`                   |
| 预设 Remote                  | `remote.agentPresets.list/select`；Host 侧过滤替换 `ctx.agentPresets.remoteExportList`（网关用 `Reflect.get` 解析实现） | `dsh-agent-preset-registry/src/index.ts`       |
| 客户端控制通道               | `remote.commands.execute(agentId, line, attachments)`；命令生命周期以 `command/run`、`command/done` 持久记录            | `dsh-api-session-controller`、`dsh-commands`   |
| 命令回执卡片                 | `conversation.chat.commandview` 是 keyed 槽，同名 key 会替换该命令的默认卡片                                            | `dsh-client-ui-chat`                           |
| `ConversationNodeDefinition` | `match / start / update / buildViewNode`；每次 start 用窗口内最早的 start，其余经 update 折叠                           | `dsh-client-ui-conversation`                   |
| `ctx.effect`                 | 返回 disposer；插件卸载时统一释放                                                                                       | `@deepseek-ai/cordis`                          |
| `ctx.subprocess`             | `spawn(spec)` → `{ done, collected, terminate }`；argv 不做 shell 解释                                                  | `dsh-subprocess/src/types.ts`                  |
| 设置页表单                   | bundle 页渲染配置槽时只传 `{ view }`（不传 `form`）；可编辑字段须是 volatile，命名空间键是行 id                         | `dsh-client-ui-plugin-manager`、`dsh-settings` |
| 推理等级写入                 | `agent/inbox/claimed` 在 Host 快照前同步；`agent.model.select()` 只对下一步生效                                         | `dsh-agent/src/model-selection.js`             |
| `ctx.fs` 写入                | `resolve(path,{cwd,signal})` → `{targetKey,displayPath}`；`writeText(target, content, expected, signal, sandboxPolicy)`；`expected` 用 `{kind:'createIfAbsent'}`；写入内部 `mkdir(dirname,{recursive:true})`。 | app.asar 内 DSH fs 服务源码（writeFileAtomic） |
| 命令处理器                   | 返回 Promise，结果形状为 `{kind, text?}`（`kind` 取 `success` 或 `error`），经 `command/run`、`command/done` 持久记录 | `dsh-commands`、`dsh-command-compact`          |
| Host 模型目录                | `remote.session.modelCatalog()` → `{ groups, failures }`；由 `ctx.llm.listModels` 对每个注册 provider 构建，静态声明在 patch config 的第三方 provider 也在其中（无需 settingsNs） | `dsh-api-session-controller/src/index.ts`、`src/catalog.ts` |

## 2. 实现约束（改代码时不要破坏）

1. **门禁只用 `deny`**：不要改成 `ask`，`ask` 是审批语义。改成 `ask` 就变成人工审批，没人确认时会话停在原地，门禁等于不存在。
2. **双层必须同时存在**：`tools.restrict` 裁剪 + `tools/pre-execute`/guard 拒绝，不能只留一层。少一层，另一条派发路径就能绕过阶段限制。
3. **guard 与 waterfall 共用同一个判定函数**（`checkTool`），避免两层漂移。
4. **子代理白名单写在预设组合里**：不要假设“子代理会继承父级限制”，也不要试图通过 `agentOptions` 传工具（契约没有该字段）。继承会让 worker 按父级的临时状态干活，同一预设的行为随主会话漂移，出问题无法复现。
5. **不新增自定义 Session 事件类型**；需要新状态就放进 `tool/result.meta` 的整值 checkpoint，或走 `ctx.sessionProjections`。旧版本遇到未知事件会拒绝重开会话，等于用户的会话记录打不开。
6. **所有监听与注册都走 `ctx.effect`**：`ctx.on`、`ctx.tools.register`、`ctx.tools.guard`、客户端 `locale`/Definition 注册全部包在 `ctx.effect` 里。漏在外面的在插件卸载或重载时不会回收，会重复注册、泄漏监听。
7. **`auto` 是显式 opt-in 的跟随**：`auto` 只在派发时由 `resolveWorkerRoute` 解析为主代理当前模型，解析结果仍过 `assertWorkerModel`；读不到就失败，不得静默替换路由；`preflight` 在挂载期跳过 `auto`。
8. **浏览器半只管渲染与控制回流**：不写 DOM、不加载其他 DSH Client 包；控制动作走 `/coding` 命令或官方 Remote，前端不直接改 Host 状态。预设可见性过滤放在 Host 端 `installWorkerPresetFilter`。
9. **胶囊只能读整值 checkpoint**：`asCheckpoint()` 必须继续做全字段校验，`meta` 是历史版本写下的任意 JSON。跳过校验就会把半截或旧格式的数据当成有效状态渲染出来。
10. **配置页依赖 volatile 字段**：字段改回普通字段会让插件页面上的表单消失，同时要保留 `ctx.settings.configure({ auto: false })`，否则会出现重复的自动页面。
11. **bundle 配置页不要等 owner 传 `form`**：当前版本只传 `view`；页面必须经 `ctx.configForms.get('dsh-coding')` 读写 Host 表单，不能自行调用 `ctx.remote.settings`。
12. **worker 预设只从对外花名册里隐藏**：过滤发生在 Host，注册表必须继续包含全部 worker 预设（planner / implement / verify 与 `dsh-coding-verify-instructions`），否则 `delegate_*` 找不到组合；不要为此改 `cordis.patch.yml` 的预设声明。
13. **turn 快照与卡片字段一一对应**：`turn/end` 冻结的字段必须是卡片渲染的全部动态值（mode/stage/verification/planItems/openPlanItems/edits）；卡片不得直接读实时 plan/edits。少一个冻结字段，卡片就会显示与当轮快照不一致的值。
14. **`handoff` 必须有界**：所有新增字段都要走 `HANDOFF_*` 上限并随 checkpoint 持久化；不得把无界的对话历史塞进 worker 提示词。
15. **模型路由只走 `resolveWorkerRoute` / `assertWorkerModel`**：不得新增“回退主代理模型”的分支，也不要在别处另写一套 route 解析。`auto` 的解析只发生在 `models.ts` 的 `resolveWorkerRoute`；`preflight` 只做哨兵跳过，不新增并行解析。
16. **验证失败记账只走 `recordVerification`**：不得绕过预算直接写 `state.verification`，否则阻塞出口会失效。记账只有这一处，验证预算与阻塞判定都读它。
17. **阻塞交付的放行只由 `checkAdvance` 的 `blocked` 返回决定**：不要用 `deny` / `ask` 实现它——那是工具门禁的语义。
18. **验证命令必须受 `verificationTimeoutMs` 约束**：新增执行路径不得绕过 `executeVerification`，否则超时与预算都会失效。
19. **失败提示只走 `recordFailure` + `takeFailureNotice`**：不要在异常处理里新建 Turn，也不要直接 append Session 事件——前者会打断当前对话节奏，后者会破坏缓存与持久化约束。`coding_stage` 被拒或抛错也走 `recordFailure('stage')` + `takeFailureNotice`，成功推进后用 `clearFailure('stage')` 清除。绕过去，用户就看不到统一格式的失败提示与补救动作。
20. **exec 类工具的阶段边界**：`bash` / `pwsh` 在 requirements、plan、implement、verify 准入，只有 `deliver` 不授予（交付只报告、不执行命令）；implement 的 `IMPLEMENT_TABLE` 必须同时含 `bash` 与 `pwsh`——`tools.restrict` 拒绝未知工具名，按平台收窄靠 `syncTable` 的 known 过滤——但不得把 `apply_patch` / `edit` / `write` 加回该表。
21. **交付记录只经 handoff 持久化**：`delivered` / `followUps` 必须走 `mergeHandoff` 与 `asHandoff` 校验，并沿用现有 `HANDOFF_*` 上限；不得新增自动生成/自动写回逻辑、不得新增并行的交付摘要事件或投影字段；`WORKER_SECTIONS` 只给 `plan` 与 `implement` 加 `delivered`，`verify` 分片保持原样。
22. **任务交接文档只经 `/coding memory` 写入**：浏览器半只发命令，不写文件、不用 `window.confirm`；Host 只走 fs 服务（`resolve` + `writeText {kind:'createIfAbsent'}`），不得用 `node:fs` 直写、不得执行 shell；文档内容只取状态机与 `coding_handoff`，不回读对话正文、不新增 Session 事件；文件名固定为 `<UTC YYYYMMDD-HHmmss>-<清洗后的会话标题>.md`（时间在前，`listDir` 的名字序即时间序）：标题取 `sessionTitle` 服务的 `get(session).title`，缺失/抛错/空串时回退 `handoff.goal`，再回退 `session`；清洗 Windows 非法字符与控制字符、空白与 `.` 折叠成 `-`、按码点截到 40 字符。读取只经 `/coding memory open [关键词]`：走 fs 的 `resolve` / `stat` / `listDir` / `readText` 取名字最大的一篇（关键词按文件名不区分大小写过滤；目录不存在按空存档处理），经 `agent.steer` 注入 `controlMessage`，并声明它是存档快照、以 `coding_handoff` 实时记录为准。两者的写入都不得覆盖已有文件。
23. **worker 的仓库指令只由预设组合提供**：implement 预设固定含 `agent-instructions`（`maxBytes: 65536`）；verify 仅在 codex 且 `taskCount >= 2 || changedFiles >= 3` 时改用 `dsh-coding-verify-instructions`，其余情况用 `dsh-coding-verify`。不得把 AGENTS.md 文本缓存进 handoff、worker 提示词或状态（checkpoint），也不要让 worker 再手动读一遍；时效性交给 `agent-instructions`——每次派发都是新子会话、启动时读取，运行中的更新由上游在 `read` / `write` / `edit` 触碰指令文件时对账。
24. **planner 门禁**：`requirePlanner: complex` 时，codex 下任务单严格大于三条（`PLANNER_TODO_THRESHOLD = 3`）且本会话未派发过 `delegate_plan`（成功或失败都算）就拒绝 `implement`，reason 要求先在 plan 阶段派发；主 Agent 模型与 `plannerWorkerModel` 全等（由 `preset.ts` 的 `leadIsPlanner` 判定，读不到或抛错按“不是”）时跳过；planner 为 `auto` 时 `leadIsPlanner` 直接为真、门禁跳过、不读模型；显式路由仍按 provider/model 全等判定，读不到或抛错按不是；`planner` 只随整值 checkpoint 持久化，不新增 Session 事件；`delegate_plan` 一进入就记 `outcome: 'failed'`、派发结束按结果改写为 `completed` / `failed`，失败同样打开门禁；不得为 planner 路由做回退；`state.ts` 保持纯函数（主 Agent 模型判定与配置读取在 `preset.ts`，作为 `checkAdvance` 的 `AdvanceOptions` 传入）。
25. **工具表裁剪每阶段显式**：`stageToolTable` 为 implement 返回 `IMPLEMENT_TABLE`，verify/deliver 由「已知工具名 × 阶段准入类」生成（未知类的第三方工具保留；`delegate_implement` / `delegate_plan` 属 delegate 类，verify/deliver 的准入类不含 delegate，因此自然被排除）；不得再用 `undefined` 表示“恢复全表”。目标表必须从 `view(agent).restrictableNames` 采样，不得用 `schemas(agent)`（已受限，会把上一阶段的可见集当成全集）。限制的 disposer 只存每 agent 的 `WeakMap` 并在 `agent/disposed` 释放；`syncTable` 以「阶段 + allow-list」为键幂等，并在每个 `agent/pre-step` 按实际工具集重算（阶段内新注册的工具下一步即可见）；`restore` 返回 applied/no-state/pending，pending 时在后续 `agent/pre-step` 重试，同一 point + reason 的失败只记一次；`state.restored` 不写入 checkpoint。
26. **`/coding init` 的文档正文只来自本会话模型，异步执行、按章节分批且不套固定模板**：入口只有 `/coding init [-update] [-modules]`，独立的 init 命令已删除，命令注册在 preset（`src/index.ts` 不再注册）；空项目（`listSourceFiles` 找不到任何源码文件）只回一行提示、零操作，不扫模块、不读写文档、不调模型。模块探测最多两级：启发式检测（`walkByHeuristic` 的 `moduleDirOf`）把三段及更深的候选目录收敛到其二级祖先，`src/http`、`src/http/lib`、`src/http/test`、`src/http/api` 只算一个模块 `src/http`；显式 workspace 声明（`pnpm-workspace.yaml` / `package.json` workspaces）走 `walkByPatterns`，模块路径保持原样不收敛。生成时最终文档 = 插件标题行（`# AGENTS.md — <name>`，模块文档前置 `> 上级：…`）+ 模型返回的 `##` 章节（保留模型顺序）+ 插件回写的「模块索引」表；模型未返回的模板章节不补写，模板渲染（`renderProjectDoc` / `renderModuleDoc`）只作为提示词里的参考草稿。更新保留旧文档的章节顺序与未返回章节，模型返回的已有标题仅在被允许替换时替换（项目级 = 受影响章节，模块级 = 模块章节表），新标题按模型顺序追加到末尾。写出前按行清除 `<!-- TODO: 待补充 -->` 与 TODO 占位行，清空后的章节整节移除，所以写出的文档零占位符，回执也不再统计「待补充」数量。模型读不到、调用失败或解析不出可应用章节时返回 error 回执且零写盘，绝不回退为模板渲染。模型调用按章节分批：`PROJECT_WRITABLE_SECTIONS`（项目级 12 章，`PROJECT_SECTIONS` 去掉插件自有的「模块索引」）与 `MODULE_SECTIONS`（模块级 10 章）由纯函数 `planSectionBatches` 按原顺序切成每批至多 `BATCH_MAX_SECTIONS = 4` 章的连续批次（不重排、不去重、不丢章节，空数组返回空数组），因此项目级新建是 12 章 3 批、模块级新建/更新是 10 章 3 批、项目级更新是本次允许改写的章节（通常 1 批）；每批提示词只列本批章节（`buildDocPrompt` 的可选 `sections`）并附加「只输出列出的这几章、本批 60 行以内（约 2-3k token）」的硬规则，不传 `sections` 时提示词与不分批时逐字一致；各批正文去空白后按批次顺序用空行拼接，拼接结果仍**只**走一次 `composeGeneratedDoc`（新建）或一次 `applyModelSections`（更新），零占位符、`MAX_DOC_LINES` 上限与「模型无可用章节即失败」等既有语义不变。任一批失败立即整体失败，reason 前缀 `第 N/M 批：`，此时还没往写盘队列 `pending` 写任何东西，所以一个文件都不写（零写盘）。执行是异步的：命令只做轻量预检（空项目 / 读不到模型路由同步回执），其余立即返回「已开始文档生成（后台执行；模型 <route>）」，后台优先 `agent.runMaintenance`、agent 忙时退回带独立超时的 detached Promise、每 agent 单飞，完成/失败经 `agent.followup(controlMessage(text, '文档生成回执'))` 通知并注明这是运行时回执、无需调用工具，后台任务不使用命令 payload 的 signal。写盘守卫不变：两阶段（模块文档 → 项目级文档、失败零写盘）经 `ctx.fs` 的 `resolve/stat/readText/writeText`（`createIfAbsent` / `replaceIfVersion` 守卫 + 沙箱策略透传）。不新增工具、Session 事件、config 字段或 worker 预设。模型提示词（`src/docgen/doc-context.ts` 的 `buildSystemPrompt()`）固定带六条书写风格规则：写给接手的人看、先写目标与可验收结果再写做法、说人话、每条规则给理由或后果、不写模糊表述、命令路径报错保持原文；改这条规则时同步 `docs/DETAIL.md` §2.10 与 `docs/COMMANDS.md` 的「生成规则」。
27. **`/coding` 的用户可见文案只经 `src/commands/command-text.ts` 出文**：命令描述、input hint、所有回执、`/coding memory` 的固定 reason/action、`/coding init` 的回执与后台通知都必须由 `commandText(currentLanguage())` / `initText(currentLanguage())` 提供，不得在处理路径里硬编码中文或英文字符串；语言只来自 `src/language/language.ts` 的 `PromptLanguage`（`config().language` → DSH 界面 locale → 系统语言 → 宿主 locale），不读浏览器 locale、不新增 config 字段。英文文案是既有回执的逐字文本，中文为翻译；`/coding init` 的 `language` 依赖可选且缺省 `zh`（保持既有中文回执与断言），preset 必须显式传 `() => currentLanguage()`。模型面向的文本（`contract.ts`、`stageContext`、`coding_handoff` 摘要、`controlMessage` 注入正文）保持英文，不进这张表；`src/language/language.ts` 的 `languagePrompt()` 规定会话语言，包含代码注释与提交信息；改它时同步 `test/language.test.mjs` 与 `docs/DETAIL.md` §2.9。fs/模型抛错原文不翻译，只翻译插件自己的 reason/action。命令描述与 hint 在注册时按语言取一次，运行中切换界面语言需重启 DSH。

## 3. 调试

| 现象                         | 排查                                                                                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 预设列表没有 Coding          | `plugin_manager list_plugins` 看 `include:preset-dsh-coding` 是否 active；`application` 是否 `applied`                                                      |
| 预设激活失败                 | 看启动日志；常见原因是 worker 路由配置缺失或 provider 不存在                                                                                                |
| 预设列表里仍出现 worker 预设 | `pnpm build` 后**完整重启 DSH**；检查 `installWorkerPresetFilter` 是否执行、`remoteExportList` 是否被二次包装                                               |
| 模型说没有某个工具           | 正常：工具表已按阶段裁剪；`/coding` 看当前阶段                                                                                                              |
| 工具被拒                     | reason 含当前阶段、允许阶段与补救动作；reason 也写进胶囊的 `refusal`                                                                                        |
| 卡片/胶囊都不出现            | 确认会话选中 **Coding** 预设；Host 投影与客户端 bundle 都需完整重启 DSH；用 `Slots.listSubTree` 确认 `conversation.chat.turnTail` 含 `dsh-coding/turn-card` |
| 插件页面没有配置表单         | `Slots.listSubTree` 的 `plugins.bundle.config` 应含 key `dsh-coding`；页面必须走 `ctx.configForms.get('dsh-coding')`                                        |
| 中文提问得到英文回复         | 确认 `language`；`auto` 按 DSH 界面 → 系统语言 → 宿主 locale 解析；Host 改动需重启                                                                          |
| 验证命令不对                 | 在 `verificationCommands` 里按 `kind` 或 `kind:scope` 覆盖                                                                                                  |
| 下一轮或重开读不到上一轮交付 | deliver 阶段是否调用过 `coding_handoff({ delivered, followUps })`；该记录只随工具结果的 checkpoint 写入，未调用时不存在（属预期，不是投影丢失）            |
| 卡片没有生成交接文档的按钮   | 只在最新一轮、codex 模式、该轮冻结阶段为 deliver 且该轮验证通过时出现；历史轮、非 codex、验证未通过或 BLOCKED 交付不显示                                      |
| 生成交接文档失败             | 看 /coding memory 的收据：缺 fs 服务、会话没有 cwd、或写入被拒（同名文件已存在/沙箱不允许）；修复后重试，必要时手工执行 /coding memory                        |
| 插件页面模型下拉缺第三方模型 | 确认配置页读的是 `ctx.remote.session.modelCatalog()`；`llm.discoverModels` 只对 configurable 目录里的 provider 有效，静态声明的 provider 没有 settings profile，枚举不到模型 |
| `/coding init` 没生成文档     | 先看即时回执：空项目、或模型不可读会同步说明；再看后台「文档生成回执」：完成写明写出文件与模型路由，失败含原因与下一步。确认会话已选模型、fs 服务可用、文档未被并发修改（FS_STALE_VERSION） |
