# test/AGENTS.md — 测试与验证指南

本文件只服务 `test/` 下的改动。运行命令、构建产物与跨平台说明见根 [AGENTS.md](../AGENTS.md)。

## test/ 的目标与成功标准

这一层测试存在的理由：证明插件在真实 DSH 契约下的行为，而不是证明某个函数被调用过。用假 Host 挂载真实 preset，看的是模型拿到的工具表、门禁给出的拒绝、用户看到的回执原文。

成功标准：

- 跑的是构建产物 `lib/*.js`，所以改完 `src/` 先 `pnpm build`；
- 断言可观察行为：工具被拒、工具表被裁剪、回执原文；
- 新增行为同时补断言。

只断言「函数被调用过」的测试，改坏门禁或文案也不会红，等于没测。

## 测试约定

测试跑**构建产物**（`lib/*.js`），不是源码；`pnpm test` 先执行 `pnpm build`。

| 文件                         | 覆盖                                                                                                                                                                                                                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `test/stages.test.mjs`       | 阶段集合与 shell/exec 的阶段准入、门禁条件（含 handoff 的 goal / acceptance 门禁与 planner 门禁：4 条拒绝 / 3 条放行 / 已记录 completed 与 failed 都放行 / `leadIsPlanner` 与 `plannerGate: false` 旁路）、工具判定、实现表（含 `bash` / `pwsh`）、验证预算与阻塞交付、`resetVerification`、checkpoint 校验（含 `failure`、planner checkpoint 往返与畸形拒绝、旧 checkpoint 兼容）、`restoreFromView`、状态行的 `failure <point>`、handoff 交付段（`delivered` 覆盖与空串清除、`followUps` 追加去重与上限截断、旧记录缺字段仍解析、摘要与 plan/implement 分片）、`needsWorkspaceInstructions` 判定边界（非 codex / 单任务单文件 / 多任务 / 多文件）；stageToolTable 的 verify/deliver 显式裁剪与未知工具保留 |
| `test/failures.test.mjs`     | failure 结构（point / reason / action / at）、原因与处理截断到 600 字符、中英文 notice 文案、`asFailure` 逐字段校验与空消息回退                                                                                                                                                                                    |
| `test/runtime.test.mjs`      | 假 Host 挂载真实 preset：waterfall 拒绝、guard 单调、工具表裁剪、shell/exec 的阶段准入、派发参数、`coding_handoff` 读写与 worker 自动写回、模型缺失拒绝、验证失败阻断交付与预算耗尽后的 BLOCKED 交付、`/coding reset`、拒绝原因回流、失败通知只注入一次并在同点成功后清除、断点恢复、交付记录经 `coding_handoff` 写回、checkpoint 携带并在下一步上下文可见、`/coding` 控制语义、`/coding init` 的模型生成（假模型每篇文档被调用多批，靠同名章节去重后仍只写一篇）、空项目零写盘与沙箱策略透传、`/coding init` 异步：立即回执 + 零写盘 → 后台完成写盘 → followup 收到 `dsh-coding-control` 回执；runMaintenance 忙时退回 detached；无模型同步拒绝、codex >3 条 todo 的 `delegate_plan` 门禁与 `leadIsPlanner` / `requirePlanner: off` 旁路（含失败的 planner 派发仍放行、主 Agent 模型不可读时不算 planner）、路由缺失挂载失败、对外花名册过滤、codex 多任务 / 单任务 / review 的 verify 预设选择、`/coding memory` 写盘收据与缺 fs 错误收据；worker 模型 `auto`：派发跟随主代理（`agentOptions` 等于主代理当前 provider/model）、主代理模型读不到时的 `AUTO_UNAVAILABLE` 拒绝（不启动 worker）、planner 为 `auto` 时门禁跳过、三个字段全 `auto` 可正常挂载；state 重建后旧限制释放与 verify 工具表恢复、投影晚就绪时 pre-step 重试恢复、工具表按未受限全集跨阶段重建、阶段推进被拒后的用户可见中断提示；`/coding` 回执与 `/coding init` 回执的 `language: 'zh'` / `'en'` 两侧断言 |
| `test/definition.test.mjs`   | 仅凭 checkpoint 构造胶囊、pending 继承、turn/end 收尾、跨轮 checkpoint 拒绝、视图节点身份                                                                                                                                                                                                                          |
| `test/client.test.mjs`       | 浏览器 bundle 加载、Definition/渲染器/模式选择器/配置页注册、胶囊渲染、picker 仅在 Coding 会话出现、静默 `set` 回流、推理行逐轮显示、`canMemory` 判定（最新轮/codex/deliver/验证通过）与新按钮文案、配置页三个模型字段默认 `auto`（`draftModelsValid(DEFAULT_DRAFT, [])` 为真、下拉首项为「自动」）、模型目录来自 `session.modelCatalog`（第三方 provider 分组可见、catalog failures 显示为诊断）与 `auto` 不参与模型目录校验                                                                                                                                                                                |
| `test/projection.test.mjs`   | 投影折叠（模式/阶段/任务单/验证/`/coding`）、turn 快照字段与校验                                                                                                                                                                                                                                                   |
| `test/reasoning.test.mjs`    | 分类 low/high/max、effort 映射、控制器四来源、逐轮冻结与校验                                                                                                                                                                                                                                                       |
| `test/verification.test.mjs` | 命令解析、配置覆盖、缺失脚本报错、输出解析、`ctx.subprocess` 执行、超时终止与 `0` 不限制                                                                                                                                                                                                                           |
| `test/language.test.mjs`     | 会话语言解析与提示段                                                                                                                                                                                                                                                                                               |
| `test/manifest.test.mjs`     | 清单/导出/构建产物、locale 与详情文档、补丁里的预设与 worker 白名单（含 implement / verify 两个预设的 `agent-instructions` 行）、补丁与 `service.options` 的 `requirePlanner`（默认 `complex`）、client 包装格式、宿主外部依赖                                                                                                                                                      |
| `test/memory.test.mjs`       | 文件名时间戳+标题清洗与长度上限、Markdown 章节与空章节省略、20000 字符截断、假 fs 写盘（`createIfAbsent`）与标题回退、`readLatestMemory` 的最新一篇/关键词/目录不存在/空目录/抛错、缺 fs 与写盘抛错的结构化返回                                                                                                                                                                                   |
| `test/command-text.test.mjs` | `commandText` / `initText` 的中英双语文案：描述与 hint、状态/重置/未知阶段与模式/阶段与模式切换/memory 固定原因、门禁拒绝与异常收尾、init 的空项目/后台立即回执/完成与失败通知/headline 模板；英文输出零 CJK、中文关键回执含 CJK                                                                                                                                                              |
| `test/coding-init.test.mjs`  | `/coding init`：参数解析与分支、空项目闸门（无源码文件只提示且零写盘、不调模型）、注入假模型的生成/更新路径（模型上下文含现有文档、代码摘录与变更列表）、按章节分批生成（每批 ≤4 章、按批断言请求数与每批 `sections`、提示词只列本批章节；任一批失败整条命令失败且零写盘）、`planSectionBatches` 纯函数（切片不丢章、空数组、非法批大小回退默认值）、`scanProject` 三级候选目录收敛为二级模块、模型失败零写盘、模块逐模块调用模型、`listSourceFiles`、`buildDocPrompt`、`parseModelSections` / `applyModelSections`、`generateDoc` 成功与失败、fs 守卫（createIfAbsent / replaceIfVersion）与沙箱策略透传、git 变更基线与 mtime 回退；另覆盖 `getChangedFiles` 的 GitRunner 注入与失败 fallback、tag/recent/worktree 三种基线、`getFilesModifiedSince`（含 `.github/` 本地扫描）、`agent.session.header.cwd` 取根目录、本地扫描 truncated 回执、FS_STALE_VERSION 错误回执、`scrubPlaceholders` / `isEmptyDocBody` / `pruneEmptySections` / `composeGeneratedDoc`（生成不套模板：只写模型 `##` 章节并保留模型顺序、零占位符；同名去重、丢弃模型自带的「模块索引」、150 行上限）、`-update` 只改受影响章节且未受影响章节逐字保留、新标题按模型顺序追加、`-modules` 回写「模块索引」；也在既有 project-create 用例里断言 system 提示词带「书写风格」小节与六条规则关键词 |
| `test/coding-init-async.test.mjs` | `/coding init` 异步：后台运行器 `maintenance` / `detached` / 超时（超时 abort signal、吞掉任务 rejection）；提交器空项目只提示、路由失败同步 error、先交回执后台完成后再通知、同一 agent 单飞、失败通知写明原因、`run` 抛错收成失败回执不上抛、默认 notify 在 agent 缺 `followup` 或 `followup` 抛错时静默 |

**新增行为请同时补一条断言**；没有断言的行为下次重构就会被悄悄改掉，而测试仍然是绿的。`test/runtime.test.mjs` 的假上下文已经实现 `on/effect/tools/inject/get`。

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
13. codex 会话完成交付后 → 最新一轮卡片出现「结束任务并生成交接文档」；点一次进入确认、再点「确认生成」→ 收据显示路径，项目根 .agents/memory 下出现 <YYYYMMDD-HHmmss>-<标题>.md；历史轮卡片没有该按钮。
14. 验证仓库指令的条件注入与时效性：codex 会话完成一个多子任务改动后派发 verify → 子代理会话里存在 `source.kind === 'agent-instructions'` 的 user 消息；单任务单文件的 verify 派发则不应出现该消息。再改一次 AGENTS.md 后派发 worker → 新子会话读到的是修改后的内容（同样是 `agent-instructions` 消息）；worker 运行中再改 AGENTS.md，只有该 worker 之后 `read` / `write` / `edit` 触碰指令文件时才会出现 `Updated instructions from: …` 的重读，不会每步刷新。
15. 验证 planner 门禁：codex 会话写 4 条 todo → `coding_stage(implement)` 被拒，reason 提示先 `delegate_plan`；改成 3 条 → 放行；把主 Agent 模型设为 `plannerWorkerModel` 的同一 `provider/model` → 放行且不派发 planner；把 `plannerWorkerModel` 改成 `auto` → planner 为 `auto` 时无需派发 planner 即可进入 implement；`requirePlanner: off` → 放行；让一次 `delegate_plan` 派发失败（如把 `plannerWorkerModel` 指向该 provider 下不存在的模型，派发被 `assertWorkerModel` 拒绝）→ 该次失败之后同样能进入 implement，状态行显示 `planner failed`，修好路由后可重试原调用。
16. 验证 `auto` 零配置派发：安装后不改任何配置，直接在一个 codex 会话里跑一个小任务，确认 `delegate_implement` 的 `agentOptions` 等于对话框当前 provider/model；再在对话框换一个模型后重新派发，确认 `agentOptions` 跟着变。接着验证拒绝路径：在主代理模型读不到的场景（例如会话还没有模型选择）下派发，确认返回含 `AUTO_UNAVAILABLE` 的错误且 worker 未启动。
17. 验证 `/coding init`（异步）：在没有源码文件的空目录执行 `/coding init` → 只回一行「未检测到代码文件，已跳过」提示，不产生任何文件；在有源码的项目执行 `/coding init` → 先收到即时回执「已开始文档生成（后台执行；模型 provider/model）。完成或失败后会在会话里反馈。」，稍后收到「文档生成完成」通知，写出的 AGENTS.md 里没有任何 `TODO` / 待补充占位符；执行 `/coding init -modules` → 各模块目录出现 AGENTS.md（首行是上级链接、自身不含「模块索引」），项目级「模块索引」由插件回写；改动根 package.json 后执行 `/coding init -update` → 只有受影响章节变化，其余章节逐字不变；会话未选模型时执行 → 同步返回 error 回执且零写盘；后台失败时通知写明原因与下一步。在非 git 目录执行 `/coding init -update` → 不调用 diff，按 AGENTS.md 修改时间比对本地文件，没有晚于文档的改动时回报无需更新。
18. 会话 A 生成交接文档后，新开会话 B 执行 `/coding memory open` → 收到 `handoff document loaded: …` 收据，下一步上下文出现一条 `dsh-coding-control` 的 `archived handoff` 消息（含文档正文与「以 coding_handoff 为准」说明）；执行 `/coding memory open <不存在的关键词>` → error 收据说明无匹配。
```
