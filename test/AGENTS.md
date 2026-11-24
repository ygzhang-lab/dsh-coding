# test/AGENTS.md — 测试与验证指南

本文件只服务 `test/` 下的改动。运行命令、构建产物与跨平台说明见根 [AGENTS.md](../AGENTS.md)。

## 测试约定

测试跑**构建产物**（`lib/*.js`），不是源码；`pnpm test` 先执行 `pnpm build`。

| 文件                         | 覆盖                                                                                                                                                                                                                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `test/stages.test.mjs`       | 阶段集合与 shell/exec 的阶段准入、门禁条件（含 handoff 的 goal / acceptance 门禁与 planner 门禁：4 条拒绝 / 3 条放行 / 已记录 completed 与 failed 都放行 / `leadIsPlanner` 与 `plannerGate: false` 旁路）、工具判定、实现表（含 `bash` / `pwsh`）、验证预算与阻塞交付、`resetVerification`、checkpoint 校验（含 `failure`、planner checkpoint 往返与畸形拒绝、旧 checkpoint 兼容）、`restoreFromView`、状态行的 `failure <point>`、handoff 交付段（`delivered` 覆盖与空串清除、`followUps` 追加去重与上限截断、旧记录缺字段仍解析、摘要与 plan/implement 分片）、`needsWorkspaceInstructions` 判定边界（非 codex / 单任务单文件 / 多任务 / 多文件） |
| `test/failures.test.mjs`     | failure 结构（point / reason / action / at）、原因与处理截断到 600 字符、中英文 notice 文案、`asFailure` 逐字段校验与空消息回退                                                                                                                                                                                    |
| `test/runtime.test.mjs`      | 假 Host 挂载真实 preset：waterfall 拒绝、guard 单调、工具表裁剪、shell/exec 的阶段准入、派发参数、`coding_handoff` 读写与 worker 自动写回、模型缺失拒绝、验证失败阻断交付与预算耗尽后的 BLOCKED 交付、`/coding reset`、拒绝原因回流、失败通知只注入一次并在同点成功后清除、断点恢复、交付记录经 `coding_handoff` 写回、checkpoint 携带并在下一步上下文可见、`/coding` 控制语义、codex >3 条 todo 的 `delegate_plan` 门禁与 `leadIsPlanner` / `requirePlanner: off` 旁路（含失败的 planner 派发仍放行、主 Agent 模型不可读时不算 planner）、路由缺失挂载失败、对外花名册过滤、codex 多任务 / 单任务 / review 的 verify 预设选择、`/coding memory` 写盘收据与缺 fs 错误收据；worker 模型 `auto`：派发跟随主代理（`agentOptions` 等于主代理当前 provider/model）、主代理模型读不到时的 `AUTO_UNAVAILABLE` 拒绝（不启动 worker）、planner 为 `auto` 时门禁跳过、三个字段全 `auto` 可正常挂载 |
| `test/definition.test.mjs`   | 仅凭 checkpoint 构造胶囊、pending 继承、turn/end 收尾、跨轮 checkpoint 拒绝、视图节点身份                                                                                                                                                                                                                          |
| `test/client.test.mjs`       | 浏览器 bundle 加载、Definition/渲染器/模式选择器/配置页注册、胶囊渲染、picker 仅在 Coding 会话出现、静默 `set` 回流、推理行逐轮显示、`canMemory` 判定（最新轮/codex/deliver/验证通过）与新按钮文案、配置页三个模型字段默认 `auto`（`draftModelsValid(DEFAULT_DRAFT, [])` 为真、下拉首项为「自动」）、模型目录来自 `session.modelCatalog`（第三方 provider 分组可见、catalog failures 显示为诊断）与 `auto` 不参与模型目录校验                                                                                                                                                                                |
| `test/projection.test.mjs`   | 投影折叠（模式/阶段/任务单/验证/`/coding`）、turn 快照字段与校验                                                                                                                                                                                                                                                   |
| `test/reasoning.test.mjs`    | 分类 low/high/max、effort 映射、控制器四来源、逐轮冻结与校验                                                                                                                                                                                                                                                       |
| `test/verification.test.mjs` | 命令解析、配置覆盖、缺失脚本报错、输出解析、`ctx.subprocess` 执行、超时终止与 `0` 不限制                                                                                                                                                                                                                           |
| `test/language.test.mjs`     | 会话语言解析与提示段                                                                                                                                                                                                                                                                                               |
| `test/manifest.test.mjs`     | 清单/导出/构建产物、locale 与详情文档、补丁里的预设与 worker 白名单（含 implement / verify 两个预设的 `agent-instructions` 行）、补丁与 `service.options` 的 `requirePlanner`（默认 `complex`）、client 包装格式、宿主外部依赖                                                                                                                                                      |
| `test/memory.test.mjs`       | 文件名清洗与 UTC 时间戳、Markdown 章节与空章节省略、20000 字符截断、假 fs 写盘（`createIfAbsent`）、缺 fs 与写盘抛错的结构化返回                                                                                                                                                                                   |

**新增行为请同时补一条断言**；`test/runtime.test.mjs` 的假上下文已经实现 `on/effect/tools/inject/get`。

## 手工验证

```text
1. 新建会话 → 预设列表出现 "Coding"，worker 预设（共四个）不出现。
2. 让模型直接改文件 → 规划阶段收到 deny，reason 提示先 todo_write / 再委派。
3. 进入实现阶段 → 主代理工具表有 bash（Windows 为 pwsh）、能自己跑命令，但没有 apply_patch/edit/write。
4. 验证失败 → /coding stage deliver 被拒，下一步 Step 被 blocked。
5. 历史翻页 → 卡片仍显示该轮阶段与验证；重启 Host 后运行时与卡片一致。
6. 中文提问 → 中文回复（language: auto 且系统语言为中文）。
7. 新建 Coding 会话 → 空白首页出现工作模式选择；点选后第一条消息按该模式运行。
8. codex 模式未记录 goal 直接 `coding_stage(plan)` → 被拒，reason 指明先调 `coding_handoff`。
9. 连续失败到预算 → `coding_stage(deliver)` 放行但状态显示 `BLOCKED`；`/coding reset` 后可重新验证交付。
10. 把 `verificationTimeoutMs` 设为很小值（如 50）跑一个 sleep 检查 → 验证状态显示超时失败，并计入重试预算。
11. 让 worker 模型不可用（或把验证命令改成解析不出的值）后派发 → 下一步出现“运行中断”通知（原因 + 处理）；修好并再次成功后，状态行不再显示 `failure`。
12. 在 deliver 阶段调用 `coding_handoff({ delivered, followUps })` → 下一轮首个 step 的 `## Handoff` 段出现 `delivered: …` 与 `follow-ups: …`；重启 DSH 后仍在（来自 checkpoint）。
13. codex 会话完成交付后 → 最新一轮卡片出现「结束任务并生成交接文档」；点一次进入确认、再点「确认生成」→ 收据显示路径，项目根 .agents/memory 下出现 <sessionId>-<YYYYMMDD-HHmmss>.md；历史轮卡片没有该按钮。
14. 验证仓库指令的条件注入与时效性：codex 会话完成一个多子任务改动后派发 verify → 子代理会话里存在 `source.kind === 'agent-instructions'` 的 user 消息；单任务单文件的 verify 派发则不应出现该消息。再改一次 AGENTS.md 后派发 worker → 新子会话读到的是修改后的内容（同样是 `agent-instructions` 消息）；worker 运行中再改 AGENTS.md，只有该 worker 之后 `read` / `write` / `edit` 触碰指令文件时才会出现 `Updated instructions from: …` 的重读，不会每步刷新。
15. 验证 planner 门禁：codex 会话写 4 条 todo → `coding_stage(implement)` 被拒，reason 提示先 `delegate_plan`；改成 3 条 → 放行；把主 Agent 模型设为 `plannerWorkerModel` 的同一 `provider/model` → 放行且不派发 planner；把 `plannerWorkerModel` 改成 `auto` → planner 为 `auto` 时无需派发 planner 即可进入 implement；`requirePlanner: off` → 放行；让一次 `delegate_plan` 派发失败（如把 `plannerWorkerModel` 指向该 provider 下不存在的模型，派发被 `assertWorkerModel` 拒绝）→ 该次失败之后同样能进入 implement，状态行显示 `planner failed`，修好路由后可重试原调用。
16. 验证 `auto` 零配置派发：安装后不改任何配置，直接在一个 codex 会话里跑一个小任务，确认 `delegate_implement` 的 `agentOptions` 等于对话框当前 provider/model；再在对话框换一个模型后重新派发，确认 `agentOptions` 跟着变。接着验证拒绝路径：在主代理模型读不到的场景（例如会话还没有模型选择）下派发，确认返回含 `AUTO_UNAVAILABLE` 的错误且 worker 未启动。
```
