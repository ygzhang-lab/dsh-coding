# DSH Coding 编程智能体 — 开发者文档

面向维护者：目录结构、构建测试、实现依赖的 DSH 契约、必须保持的实现约束、调试与验收。使用者看 [README](../README.md)；设计思路与分层结构见 [DETAIL.md](DETAIL.md)。

## 1. 环境与命令

- Node.js ≥ 24.9.0（`.node-version` 已锁定）
- pnpm 12+
- DSH 0.2.2-rc.5（本插件按该版本的实际契约实现，见第 4 节）

```bash
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm build       # 生成 lib/*.js、lib/types/**、lib/client.js
pnpm test        # 先 build，再 node --test test/*.test.mjs
```

## 2. 目录结构

```
src/
  index.ts            Host 设置服务（ctx.dshCodingRuntime）
  config.ts           Config（Schemastery）、configSchema、路由解析
  models.ts           worker 模型路由：resolveWorkerRoute / assertWorkerModel / WorkerModelError
  handoff.ts          跨阶段交接记录：合并去重、摘要渲染、checkpoint 校验（纯函数，浏览器可用）
  stages.ts           阶段/模式常量、工具分类、阶段准入、checkpoint 类型（宿主+浏览器共用）
  failures.ts         阻断性异常的结构化记录与中英文通知渲染
  state.ts            每 Agent 状态机、推进门禁、工具判定、工具表裁剪、验证预算、checkpoint
  contract.ts         按阶段拆分的交付契约片段
  messages.ts         dsh-coding-stage / dsh-coding-control 消息源
  preset.ts           预设主插件：双层门禁、pre-step、工具、/coding 命令、语言提示、投影
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
scripts/build.mjs     esbuild 打包 client + tsc 编译宿主 + 原子替换 lib
scripts/mount-probe.mjs 隔离挂载探针
test/                node:test 用例（跑构建后的 lib，而不是源码）
```

## 3. 构建产物

| 入口 | 产物 | 说明 |
| --- | --- | --- |
| `dsh-coding` | `lib/index.js` | Host 设置服务；同时导出 `Config` 与 `configSchema` |
| `dsh-coding/preset` | `lib/preset.js` | 预设运行时 |
| `dsh-coding/editor` | `lib/editor.js` | `apply_patch` |
| `dsh-coding/verifier` | `lib/verifier.js` | `run_verification` |
| `dsh-coding/client` | `lib/client.js` | 浏览器模块表：`window.__ModuleLoader__.load({ id, factory })` |

宿主代码只编译、不打包，所有 `@deepseek-ai/*` 保持外部引用，运行时由 DSH 安装目录解析；客户端用 esbuild 打包为 CJS，再由脚本包一层模块表工厂，React 由宿主模块表提供。`scripts/build.mjs` 先写临时目录、全部成功后才替换 `lib/`，构建失败不会留下半成品。

## 4. 已核实的 DSH 契约（改动前必须复核）

以下结论来自运行时 `cordis_inspect_query` 与安装目录源码。改代码前请用同样方法复核。

| 契约 | 事实 | 出处 |
| --- | --- | --- |
| `PreToolDecision` | `allow / deny{reason, info?} / cancel / ask{reason, displayReason}`；deny 产生 `Error: <reason>` | `dsh-tools/src/contracts.ts`、`pipeline.ts` |
| 派发顺序 | pre-execute waterfall →（ask 转审批）→ `checkGuards` → 派发；guard 拒绝单调生效 | `dsh-tools/src/pipeline.ts` |
| `tools.guard(guard)` | 同步守卫，注册在当前 scope；`checkGuards` 遍历 global + agent 作用域链 | `dsh-tools/src/index.ts` |
| `tools.restrict(filter)` | 必须在 scoped ctx（`agent.ctx`）调用；拒绝未知工具名；多个限制取交集 | `dsh-tools/src/index.ts` |
| `agent/pre-step` | `{kind:'reject'}` 或 `{kind:'enter', messages, startsRequestSeries?}`；拒绝后 Turn 以 `blocked` 结束 | `dsh-agent`、`dsh-agent-loop` |
| `AgentOptions` | 只有 `provider / model / reasoningEffort / maxTokens`，**没有工具字段** | `dsh-agent/src/runtime-types.ts` |
| `SubagentStartRequest` | 有 `agentPreset / agentOptions / outputSchema / cwd / maxDepth`；**没有** `toolFilter` | `dsh-subagent/src/types.ts` |
| spawn provider | `agentOptions / agentPreset / outputSchema / depthLimit` 全为 true；不继承父上下文 | `dsh-subagent-spawn-in-process/src/index.ts` |
| 结构化子代理 | `outputSchema` 注册 `structured_output` 工具、追加提示并校验取值 | `dsh-subagent/src/structured.ts` |
| 会话事件 | 未知且非 `ignorable` 的事件会让 Session 拒绝重开 | `dsh-session/src/index.ts` |
| 新会话首页 | `conversation.hero.options` 仅在空白首页且存在 `sessionId` 时渲染 | `dsh-client-ui-conversation` |
| 预设 Remote | `remote.agentPresets.list/select`；Host 侧过滤替换 `ctx.agentPresets.remoteExportList`（网关用 `Reflect.get` 解析实现） | `dsh-agent-preset-registry/src/index.ts` |
| 客户端控制通道 | `remote.commands.execute(agentId, line, attachments)`；命令生命周期以 `command/run`、`command/done` 持久记录 | `dsh-api-session-controller`、`dsh-commands` |
| 命令回执卡片 | `conversation.chat.commandview` 是 keyed 槽，同名 key 会替换该命令的默认卡片 | `dsh-client-ui-chat` |
| `ConversationNodeDefinition` | `match / start / update / buildViewNode`；每次 start 用窗口内最早的 start，其余经 update 折叠 | `dsh-client-ui-conversation` |
| `ctx.effect` | 返回 disposer；插件卸载时统一释放 | `@deepseek-ai/cordis` |
| `ctx.subprocess` | `spawn(spec)` → `{ done, collected, terminate }`；argv 不做 shell 解释 | `dsh-subprocess/src/types.ts` |
| 设置页表单 | bundle 页渲染配置槽时只传 `{ view }`（不传 `form`）；可编辑字段须是 volatile，命名空间键是行 id | `dsh-client-ui-plugin-manager`、`dsh-settings` |
| 推理等级写入 | `agent/inbox/claimed` 在 Host 快照前同步；`agent.model.select()` 只对下一步生效 | `dsh-agent/src/model-selection.js` |

## 5. 实现约束（改代码时不要破坏）

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
12. **worker 预设只从对外花名册里隐藏**：过滤发生在 Host，注册表必须继续包含三个 worker 预设，否则 `delegate_*` 找不到组合；不要为此改 `cordis.patch.yml` 的预设声明。
13. **turn 快照与卡片字段一一对应**：`turn/end` 冻结的字段必须是卡片渲染的全部动态值（mode/stage/verification/planItems/openPlanItems/edits）；卡片不得直接读实时 plan/edits。
14. **`handoff` 必须有界**：所有新增字段都要走 `HANDOFF_*` 上限并随 checkpoint 持久化；不得把无界的对话历史塞进 worker 提示词。
15. **模型路由只走 `resolveWorkerRoute` / `assertWorkerModel`**：不得新增“回退主代理模型”的分支，也不要在别处另写一套 route 解析。
16. **验证失败记账只走 `recordVerification`**：不得绕过预算直接写 `state.verification`，否则阻塞出口会失效。
17. **阻塞交付的放行只由 `checkAdvance` 的 `blocked` 返回决定**：不要用 `deny` / `ask` 实现它——那是工具门禁的语义。
18. **验证命令必须受 `verificationTimeoutMs` 约束**：新增执行路径不得绕过 `executeVerification`，否则超时与预算都会失效。
19. **失败提示只走 `recordFailure` + `takeFailureNotice`**：不要在异常处理里新建 Turn，也不要直接 append Session 事件——前者会打断当前对话节奏，后者会破坏缓存与持久化约束。

## 6. 测试

测试跑**构建产物**（`lib/*.js`），不是源码；`pnpm test` 先执行 `pnpm build`。

| 文件 | 覆盖 |
| --- | --- |
| `test/stages.test.mjs` | 阶段集合、门禁条件（含 handoff 的 goal / acceptance 门禁）、工具判定、实现表、验证预算与阻塞交付、`resetVerification`、checkpoint 校验（含 `failure` 与旧 checkpoint 兼容）、`restoreFromView`、状态行的 `failure <point>` |
| `test/failures.test.mjs` | failure 结构（point / reason / action / at）、原因与处理截断到 600 字符、中英文 notice 文案、`asFailure` 逐字段校验与空消息回退 |
| `test/runtime.test.mjs` | 假 Host 挂载真实 preset：waterfall 拒绝、guard 单调、工具表裁剪、派发参数、`coding_handoff` 读写与 worker 自动写回、模型缺失拒绝、验证失败阻断交付与预算耗尽后的 BLOCKED 交付、`/coding reset`、拒绝原因回流、失败通知只注入一次并在同点成功后清除、断点恢复、`/coding` 控制语义、路由缺失挂载失败、对外花名册过滤 |
| `test/definition.test.mjs` | 仅凭 checkpoint 构造胶囊、pending 继承、turn/end 收尾、跨轮 checkpoint 拒绝、视图节点身份 |
| `test/client.test.mjs` | 浏览器 bundle 加载、Definition/渲染器/模式选择器/配置页注册、胶囊渲染、picker 仅在 Coding 会话出现、静默 `set` 回流、推理行逐轮显示 |
| `test/projection.test.mjs` | 投影折叠（模式/阶段/任务单/验证/`/coding`）、turn 快照字段与校验 |
| `test/reasoning.test.mjs` | 分类 low/high/max、effort 映射、控制器四来源、逐轮冻结与校验 |
| `test/verification.test.mjs` | 命令解析、配置覆盖、缺失脚本报错、输出解析、`ctx.subprocess` 执行、超时终止与 `0` 不限制 |
| `test/language.test.mjs` | 会话语言解析与提示段 |
| `test/manifest.test.mjs` | 清单/导出/构建产物、locale 与详情文档、补丁里的预设与 worker 白名单、client 包装格式、宿主外部依赖 |

新增行为请同时补一条断言；`test/runtime.test.mjs` 的假上下文已经实现 `on/effect/tools/inject/get`。

### 手工验证

```text
1. 新建会话 → 预设列表出现 "Coding"，三个 worker 预设不出现。
2. 让模型直接改文件 → 规划阶段收到 deny，reason 提示先 todo_write / 再委派。
3. 进入实现阶段 → 主代理工具表无 apply_patch/edit/write。
4. 验证失败 → /coding stage deliver 被拒，下一步 Step 被 blocked。
5. 历史翻页 → 卡片仍显示该轮阶段与验证；重启 Host 后运行时与卡片一致。
6. 中文提问 → 中文回复（language: auto 且系统语言为中文）。
7. 新建 Coding 会话 → 空白首页出现工作模式选择；点选后第一条消息按该模式运行。
8. codex 模式未记录 goal 直接 `coding_stage(plan)` → 被拒，reason 指明先调 `coding_handoff`。
9. 连续失败到预算 → `coding_stage(deliver)` 放行但状态显示 `BLOCKED`；`/coding reset` 后可重新验证交付。
10. 把 `verificationTimeoutMs` 设为很小值（如 50）跑一个 sleep 检查 → 验证状态显示超时失败，并计入重试预算。
11. 让 worker 模型不可用（或把验证命令改成解析不出的值）后派发 → 下一步出现“运行中断”通知（原因 + 处理）；修好并再次成功后，状态行不再显示 `failure`。
```

## 7. 调试

| 现象 | 排查 |
| --- | --- |
| 预设列表没有 Coding | `plugin_manager list_plugins` 看 `include:preset-dsh-coding` 是否 active；`application` 是否 `applied` |
| 预设激活失败 | 看启动日志；常见原因是 worker 路由配置缺失或 provider 不存在 |
| 预设列表里仍出现 worker 预设 | `pnpm build` 后**完整重启 DSH**；检查 `installWorkerPresetFilter` 是否执行、`remoteExportList` 是否被二次包装 |
| 模型说没有某个工具 | 正常：工具表已按阶段裁剪；`/coding` 看当前阶段 |
| 工具被拒 | reason 含当前阶段、允许阶段与补救动作；reason 也写进胶囊的 `refusal` |
| 卡片/胶囊都不出现 | 确认会话选中 **Coding** 预设；Host 投影与客户端 bundle 都需完整重启 DSH；用 `Slots.listSubTree` 确认 `conversation.chat.turnTail` 含 `dsh-coding/turn-card` |
| 插件页面没有配置表单 | `Slots.listSubTree` 的 `plugins.bundle.config` 应含 key `dsh-coding`；页面必须走 `ctx.configForms.get('dsh-coding')` |
| 中文提问得到英文回复 | 确认 `language`；`auto` 按 DSH 界面 → 系统语言 → 宿主 locale 解析；Host 改动需重启 |
| 验证命令不对 | 在 `verificationCommands` 里按 `kind` 或 `kind:scope` 覆盖 |

## 8. 隔离挂载探针

`scripts/mount-probe.mjs` 在临时 `DSH_HOME` 下创建 `base + dsh-coding` 的探测 profile，启动真实 Host，读取预设花名册并像会话控制器一样 `mount` Coding 预设，打印可见工具与 `settings.describe()` 命名空间；不动用户 profile。

```bash
H=/tmp/dsh-probe-home && rm -rf "$H" && mkdir -p "$H/profiles/probe/node_modules"
cat > "$H/profiles/probe/package.json" <<'JSON'
{ "name": "dsh-profile-probe", "private": true,
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-coding"] } },
  "dependencies": { "dsh-coding": "link:/绝对路径/dsh-coding" } }
JSON
printf '[]\n' > "$H/profiles/probe/cordis.yml"
printf '[]\n' > "$H/profiles/probe/cordis.patch.yml"
ln -sfn /绝对路径/dsh-coding "$H/profiles/probe/node_modules/dsh-coding"

DSH_HOME="$H" ELECTRON_RUN_AS_NODE=1 \
  DSH_INSTALL_DIR="/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh" \
  "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" scripts/mount-probe.mjs
```

探针额外打印三项关键事实：`prompt context coding:language`（语言提示段）、`projection dshCodingStage`（卡片数据源是否注册）、`after agent-preset/selected`（选中 Coding 后投影是否 `active: true`）。

## 9. 发布

```bash
pnpm typecheck && pnpm build && pnpm test
pnpm pack --dry-run   # 检查 files 是否包含 lib/locale/docs/icon/patch
pnpm publish          # prepublishOnly 会再跑一遍 typecheck/build/test
```

本地安装调试：`plugin_manager install_bundle` 传工作区绝对路径，或 `dsh plugin --profile <profile> add /绝对路径`。替换已安装版本需先移除再安装（同一路径的 `link:` 会直接读取新产物，但正在运行的 JS 需要重载）。
