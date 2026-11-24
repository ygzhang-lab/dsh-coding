# 更新日志

本文件记录 DSH Coding 编程智能体的版本变更。版本号遵循语义化版本（`MAJOR.MINOR.PATCH`），`rc` 后缀表示预发布版本；小节按发布时间倒序排列，最新的版本在最前。

## 0.1.1-rc3（已发布）

对应标签 `v0.1.1-rc3`，2026-11-24 推送到 GitHub；`package.json` 当前版本为 `0.1.1-rc3`。

### 新增

- 三个 worker 模型字段（`plannerWorkerModel` / `implementWorkerModel` / `verifyWorkerModel`）默认值改为 `auto`：安装后不改配置即可工作，`auto` 在派发时解析为主代理（对话框）当前模型，跟随主代理换模型。
- `auto` 的解析结果仍过 `assertWorkerModel`（provider 注册 + 模型目录），失败即派发失败、绝不替换成别的路由；主代理模型读不到时抛 `WorkerModelError`，错误码 `AUTO_UNAVAILABLE`，worker 不启动。`preflight` 在挂载期跳过 `auto`（没有 agent 上下文），解析只发生在派发期。
- planner 为 `auto` 时视为主代理自己就是 planner：`leadIsPlanner` 直接为真、`requirePlanner` 门禁跳过、不读模型选择也不派发 planner。
- 配置页三个模型下拉首项是「自动（跟随主代理当前模型）」；保存只校验格式（`auto` 或 `provider/model`），`auto` 不需要出现在模型目录里；目录里没有的已保存路由仍显示为“不在当前模型列表”。
- README 新增「推荐组合」小节：全自动（默认）、编排自动 + planner 显式 pro、全显式三种组合，并写明 `auto` 的三条语义；`docs/DETAIL.md` 的模型路由小节与配置参考表同步改为 `auto` 语义。
- 任务交接文档：`/coding memory` 在会话工作目录的 `.agents/memory/<sessionId>-<UTC YYYYMMDD-HHmmss>.md` 写一篇本轮交接 Markdown，内容只取状态机与 `coding_handoff` 记录，不回读对话正文；同名文件不覆盖。实现在 `src/memory.ts`，Host 侧经 fs 服务写盘。
- planner 门禁：新增配置 `requirePlanner`（`complex` 默认 / `off`）。`complex` 下 codex 会话的任务单超过 3 条、尚未派发过 `delegate_plan`、且主 Agent 自身不是 planner 路由时，`coding_stage(implement)` 被拒并提示先派发 planner；该字段不可在插件页修改，写在 bundle 的 patch config 里。
- 轮次卡片新增「结束任务并生成交接文档」按钮，仅在最新一轮、codex 模式、该轮冻结阶段为 deliver 且验证通过时出现。
- `coding_handoff` 新增 `delivered` / `followUps` 字段：deliver 阶段记录本轮交付了什么与残余风险，下一轮与重开会话的 plan / implement worker 会读到（verify 分片不渲染，控制提示词体积）。
- 新增 verify worker 预设 `dsh-coding-verify-instructions`：仅 codex 模式且子任务数 ≥ 2 或改动文件数 ≥ 3 时加载仓库指令；implement 预设固定加载 `@deepseek-ai/dsh-agent-instructions`（`maxBytes: 65536`）。
- 主代理在 implement / verify 阶段获得 shell：`IMPLEMENT_TABLE` 同时列出 `bash` 与 `pwsh`，按平台由 `syncTable` 的已知工具过滤收窄。

### 变更

- 模型路由文档与市场文案改述：不再写“Pro 负责分析需求、Flash 干活”这类固定默认路由的说法，改为「默认三个子代理跟随主代理当前模型（`auto`），可分别指定 planner / implement / verify 的模型」；`package.json` 的 `description` 与 `locale/zh.json`、`locale/en.json` 的 `meta.description` 同步（`meta.detail` 仍为 `README.md`）。
- 显式 `provider/model` 的语义不变：缺失、格式错误或 provider 不存在时挂载失败，派发前仍校验模型可用性，失败时给出配置字段名、当前路由与可用模型；`auto` 只在派发期解析，绝不回退主代理其它路由。
- 阶段工具边界调整：`exec` 类工具在 requirements / plan / implement / verify 准入，只有 deliver 不授予；实现阶段编辑文件仍然只能走 `delegate_implement`。
- 文档新增「会话边界」约定：一个 Coding 会话只服务一个任务，换任务请新开会话。原因是 `coding_handoff` 的列表字段只追加（只有 `goal` / `delivered` 覆盖），复用会话会让上一个任务的 `acceptance` 满足新任务的 verify / deliver 门禁；`coding_handoff({ reset: true })` 只重置验证重试预算。
- README「使用」新增第 4 条会话边界提示（一次会话只跑一个任务，换任务请新开会话），与上面的约定同义，面向使用者。
- `/coding` 命令增加 `memory` 子命令，`/coding` 的帮助与输入提示同步更新。
- 插件详情文档指向 `README.md`（`locale/zh.json`、`locale/en.json` 的 `meta.detail`）。
- 文档重构：`AGENTS.md` 拆分为根（通用工作方式、环境、目录总览、构建产物、发布、跨平台、硬规则速览）+ `src/AGENTS.md`（DSH 契约表、实现约束 1-23、src 模块表、调试表）+ `test/AGENTS.md`（测试矩阵、手工验证）+ `scripts/AGENTS.md`（隔离挂载探针），目录级文件由 `agent-instructions` 在触碰对应目录时自动注入；`docs/DETAIL.md` 的文档引用改为分别指向这三处；`docs/DEVELOPMENT.md` 并入 `docs/DETAIL.md` 后删除；README 重写为面向使用者。
- `package.json` 补充 `author` / `repository` / `homepage` / `bugs` 元数据，`files` 增加 `AGENTS.md`。

### 修复

- `scripts/build.mjs` 的目录原子换入在 Windows 上偶发 `EPERM`：新增 `renameWithRetry`，仅对 `EPERM` / `EBUSY` / `EACCES` 按 100ms × attempt 退避、最多 10 次；原子替换与失败回滚语义不变。
- 发布前检查修复：Coding 预设 `description` 结尾的双句点与行尾多余空格；根 `AGENTS.md` 与 `docs/DETAIL.md` 指向 `src/`、`test/`、`scripts/` 三个目录级文件的链接改为 GitHub 绝对地址（这三个文件不随 npm 包发布，相对链接在 npm 页面上会 404）。
- 插件配置页的模型下拉改为读取 Host 会话模型目录 `ctx.remote.session.modelCatalog()`（与对话框模型选择器同源），修复通过 `cordis.patch.yml` 静态声明的第三方 provider（如 `qianwen-token-plan`）的模型在页面里看不到的问题；不再用 `llm.discoverModels` 逐个枚举 provider，目录顺序沿用 Host 的 provider 分组顺序，Host 列不出模型的 provider 显示为页面顶部诊断。

### 测试

- 测试总数 181，全部通过（`pnpm test`，先执行 `pnpm build`）。新增 `test/memory.test.mjs`（交接文档组装与写盘），并补充交接文档按钮、`delivered` / `followUps` 合并、`needsWorkspaceInstructions` 判定边界、verify 预设的条件选择、`requirePlanner` 门禁、shell 阶段准入、`agent-instructions` 预设行等断言。
- worker 模型 `auto` 用例：`auto` 派发（`agentOptions` 等于主代理当前 provider/model）、主代理模型不可读时的 `AUTO_UNAVAILABLE` 拒绝（不启动 worker）、planner 为 `auto` 时门禁跳过（4 条 todo 直接进入 implement 且 planner 记录仍为空）、三个字段全 `auto` 可正常挂载。

## 0.1.1-rc1（已发布）

首个发布版本，对应标签 `v0.1.1-rc1`。

- 五段式契约：requirements → plan → implement → verify → deliver；`auto` / `consult` / `review` / `codex` 四种工作模式与各自的阶段集合。
- 双层门禁：`tools.restrict` 工具表裁剪 + `tools/pre-execute` / guard 拒绝，两层共用同一个 `checkTool` 判定。
- 三个 worker 预设（planner / implement / verify），工具白名单写在预设组合里，不继承父级限制。
- `coding_handoff` 跨阶段交接记录、`todo_write` 任务单、验证重试预算与 BLOCKED 交付出口。
- `run_verification` 结构化验证（命令解析、超时、失败输出解析）与 Codex 语法 `apply_patch` 编辑器。
- 浏览器半：阶段胶囊、轮次卡片、工作模式选择器、`/coding` 命令回执、插件配置页。
- 推理等级（`auto` / `low` / `high` / `max`）与会话语言（`auto` / `zh` / `en`）。
