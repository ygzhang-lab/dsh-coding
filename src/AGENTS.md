# src/AGENTS.md — 源码层维护指南

本文件只服务 `src/`（含 `src/client/`）下的改动：DSH 契约表、实现约束、模块表与调试表。
通用命令、构建产物、发布与跨平台注意事项见根 [AGENTS.md](../AGENTS.md)。

## src 模块表

```
src/
  index.ts            Host 设置服务（ctx.dshCodingRuntime）
  config.ts           Config（Schemastery）、configSchema、路由解析
  models.ts           worker 模型路由：resolveWorkerRoute / assertWorkerModel / WorkerModelError
  handoff.ts          跨阶段交接与交付记录：合并去重、摘要渲染、worker 分片、checkpoint 校验（纯函数，浏览器可用）
  memory.ts           任务交接文档：文件名、Markdown 组装、经 fs 服务写盘（Host-only）
  stages.ts           阶段/模式常量、工具分类、阶段准入、checkpoint 类型（宿主+浏览器共用）
  failures.ts         阻断性异常的结构化记录与中英文通知渲染
  state.ts            每 Agent 状态机、推进门禁（含 planner 门禁，阈值 PLANNER_TODO_THRESHOLD = 3）、工具判定、工具表裁剪、验证预算、checkpoint
  contract.ts         按阶段拆分的交付契约片段
  messages.ts         dsh-coding-stage / dsh-coding-control 消息源
  preset.ts           预设主插件：双层门禁、pre-step、工具、/coding 命令、语言提示、投影；leadIsPlanner 与 requirePlanner 在此接线进 checkAdvance
  language.ts         会话语言解析（auto/zh/en）
  system-language.ts  macOS AppleLanguages 探测（Host-only）
  reasoning.ts        推理等级：分类器、effort 映射、每会话控制器
  reasoning-projection.ts dshCodingReasoning 持久投影
  coding-projection.ts    dshCodingStage 持久投影
  editor.ts           apply_patch（主预设 + implement worker 共用）
  verifier.ts         run_verification 入口（verify worker）
  verification.ts     命令解析 + ctx.subprocess 执行 + 失败输出解析
  verification-tool.ts run_verification 工具定义
  patch.ts            Codex patch 语法解析
  apply-patch.ts      apply_patch 工具
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

## 2. 实现约束（改代码时不要破坏）

1. **门禁只用 `deny`**：不要改成 `ask`，`ask` 是审批语义。
2. **双层必须同时存在**：`tools.restrict` 裁剪 + `tools/pre-execute`/guard 拒绝，不能只留一层。
3. **guard 与 waterfall 共用同一个判定函数**（`checkTool`），避免两层漂移。
4. **子代理白名单写在预设组合里**：不要假设“子代理会继承父级限制”，也不要试图通过 `agentOptions` 传工具（契约没有该字段）。
5. **不新增自定义 Session 事件类型**；需要新状态就放进 `tool/result.meta` 的整值 checkpoint，或走 `ctx.sessionProjections`。
6. **所有监听与注册都走 `ctx.effect`**：`ctx.on`、`ctx.tools.register`、`ctx.tools.guard`、客户端 `locale`/Definition 注册全部包在 `ctx.effect` 里。
7. **worker 路由缺失必须失败**：不要在代码里写“回退到主代理模型”的兜底。
8. **浏览器半只管渲染与控制回流**：不写 DOM、不加载其他 DSH Client 包；控制动作走 `/coding` 命令或官方 Remote，前端不直接改 Host 状态。预设可见性过滤放在 Host 端 `installWorkerPresetFilter`。
9. **胶囊只能读整值 checkpoint**：`asCheckpoint()` 必须继续做全字段校验，`meta` 是历史版本写下的任意 JSON。
10. **配置页依赖 volatile 字段**：字段改回普通字段会让插件页面上的表单消失，同时要保留 `ctx.settings.configure({ auto: false })`，否则会出现重复的自动页面。
11. **bundle 配置页不要等 owner 传 `form`**：当前版本只传 `view`；页面必须经 `ctx.configForms.get('dsh-coding')` 读写 Host 表单，不能自行调用 `ctx.remote.settings`。
12. **worker 预设只从对外花名册里隐藏**：过滤发生在 Host，注册表必须继续包含全部 worker 预设（planner / implement / verify 与 `dsh-coding-verify-instructions`），否则 `delegate_*` 找不到组合；不要为此改 `cordis.patch.yml` 的预设声明。
13. **turn 快照与卡片字段一一对应**：`turn/end` 冻结的字段必须是卡片渲染的全部动态值（mode/stage/verification/planItems/openPlanItems/edits）；卡片不得直接读实时 plan/edits。
14. **`handoff` 必须有界**：所有新增字段都要走 `HANDOFF_*` 上限并随 checkpoint 持久化；不得把无界的对话历史塞进 worker 提示词。
15. **模型路由只走 `resolveWorkerRoute` / `assertWorkerModel`**：不得新增“回退主代理模型”的分支，也不要在别处另写一套 route 解析。
16. **验证失败记账只走 `recordVerification`**：不得绕过预算直接写 `state.verification`，否则阻塞出口会失效。
17. **阻塞交付的放行只由 `checkAdvance` 的 `blocked` 返回决定**：不要用 `deny` / `ask` 实现它——那是工具门禁的语义。
18. **验证命令必须受 `verificationTimeoutMs` 约束**：新增执行路径不得绕过 `executeVerification`，否则超时与预算都会失效。
19. **失败提示只走 `recordFailure` + `takeFailureNotice`**：不要在异常处理里新建 Turn，也不要直接 append Session 事件——前者会打断当前对话节奏，后者会破坏缓存与持久化约束。
20. **exec 类工具的阶段边界**：`bash` / `pwsh` 在 requirements、plan、implement、verify 准入，只有 `deliver` 不授予（交付只报告、不执行命令）；implement 的 `IMPLEMENT_TABLE` 必须同时含 `bash` 与 `pwsh`——`tools.restrict` 拒绝未知工具名，按平台收窄靠 `syncTable` 的 known 过滤——但不得把 `apply_patch` / `edit` / `write` 加回该表。
21. **交付记录只经 handoff 持久化**：`delivered` / `followUps` 必须走 `mergeHandoff` 与 `asHandoff` 校验，并沿用现有 `HANDOFF_*` 上限；不得新增自动生成/自动写回逻辑、不得新增并行的交付摘要事件或投影字段；`WORKER_SECTIONS` 只给 `plan` 与 `implement` 加 `delivered`，`verify` 分片保持原样。
22. **任务交接文档只经 `/coding memory` 写入**：浏览器半只发命令，不写文件、不用 `window.confirm`；Host 只走 fs 服务（`resolve` + `writeText {kind:'createIfAbsent'}`），不得用 `node:fs` 直写、不得执行 shell；文档内容只取状态机与 `coding_handoff`，不回读对话正文、不新增 Session 事件；文件名固定为 `<清洗后的 sessionId>-<UTC YYYYMMDD-HHmmss>.md`，不得覆盖已有文件。
23. **worker 的仓库指令只由预设组合提供**：implement 预设固定含 `agent-instructions`（`maxBytes: 65536`）；verify 仅在 codex 且 `taskCount >= 2 || changedFiles >= 3` 时改用 `dsh-coding-verify-instructions`，其余情况用 `dsh-coding-verify`。不得把 AGENTS.md 文本缓存进 handoff、worker 提示词或状态（checkpoint），也不要让 worker 再手动读一遍；时效性交给 `agent-instructions`——每次派发都是新子会话、启动时读取，运行中的更新由上游在 `read` / `write` / `edit` 触碰指令文件时对账。
24. **planner 门禁**：`requirePlanner: complex` 时，codex 下任务单严格大于三条（`PLANNER_TODO_THRESHOLD = 3`）且本会话未派发过 `delegate_plan`（成功或失败都算）就拒绝 `implement`，reason 要求先在 plan 阶段派发；主 Agent 模型与 `plannerWorkerModel` 全等（由 `preset.ts` 的 `leadIsPlanner` 判定，读不到或抛错按“不是”）时跳过；`planner` 只随整值 checkpoint 持久化，不新增 Session 事件；`delegate_plan` 一进入就记 `outcome: 'failed'`、派发结束按结果改写为 `completed` / `failed`，失败同样打开门禁；不得为 planner 路由做回退；`state.ts` 保持纯函数（主 Agent 模型判定与配置读取在 `preset.ts`，作为 `checkAdvance` 的 `AdvanceOptions` 传入）。

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
