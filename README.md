# DSH Coding 编程智能体

DSH 编程智能体运行时插件，借鉴 Claude 任务编排机制，Codex 五段式契约层层推进，DeepSeek Pro 分析需求、编排任务，Flash 子智能体去干活，确保任务交付质量和 Token 价值最大化。

## 安装

插件市场 / **插件** 页面：**添加插件** → 输入 `dsh-coding`（或本地目录绝对路径）。

```bash
dsh plugin --profile <profile> add dsh-coding
```

安装插入五行：Host 设置服务、`Coding` 预设，以及三个内部 worker 预设（planner / implement / verify）。已有会话不受影响；只有选择 `Coding` 预设的新会话启用运行时。

## 配置

装好后在 **插件 → DSH Coding 编程智能体** 页面可视化编辑（保存后立即生效）。`verificationCommands`、`verificationTimeoutMs` 与两个验证预算键是普通字段，需改插件包配置（`cordis.patch.yml`）：

```yaml
- id: dsh-coding
  name: "dsh-coding"
  config:
    defaultMode: auto                    # auto | consult | review | codex
    language: auto                       # auto | zh | en
    reasoning: auto                      # auto | low | high | max
    plannerWorkerModel: provider/model   # 必填
    implementWorkerModel: provider/model # 必填
    verifyWorkerModel: provider/model    # 必填
    verificationTimeoutMs: 360000        # 单次验证命令超时（ms）；0 表示不限制
    verificationCommands: {}             # 按 kind / kind:scope 覆盖验证命令
    maxVerifyAttempts: 5                 # 验证失败重试预算；0 表示不限制
    maxSameFailure: 2                    # 相同失败签名连续出现上限；0 表示不限制
```

默认值：planner 用 `deepseek-account/deepseek-v4-pro`（pro 模型负责勘探现状与拆分任务），implement / verify 用 `deepseek-account/deepseek-flash`（flash 模型执行编辑与核查）；三个字段都可以在插件页里改。

插件页里三个模型字段是**下拉选择**，选项来自当前 DSH 已配置的模型目录（`ctx.remote.llm`：已注册 provider + 可配置 provider + 各自声明的模型）；选错（空值，或不在已加载列表里）时字段与提示都用警告色，并禁用保存。**恢复默认**只把 `defaultMode`、三个 worker 模型、`language`、`reasoning` 回填为默认值，仍需再点保存才会写入。

三个 worker 模型**不回退**主代理模型：缺失、格式不对或 provider 不存在时插件挂载失败；派发前还会校验模型是否可用（`ctx.llm.resolveModelInfo`），失败时错误给出配置字段名、当前路由与该 provider 的可用模型，修好配置后重试原调用即可。

## 使用

1. 新建会话，预设选择 **Coding**。三个 worker 预设只用于 `delegate_*` 派发，不出现在预设列表。
2. 空白首页输入框旁可选 **工作模式**（自动 / 问答 / 审查 / Codex）。默认 **自动** 先做需求分析，再用 `coding_mode` 选定后续工作流；不确定时回退到问答。
3. 正常提需求：需求分析 → 规划（pro worker 勘探现状并输出单一职责子任务）→ 任务单 → 实现（flash worker）→ 验证。每个子任务写清目标、涉及文件、验收方式与不碰的范围。

| 阶段 | 主代理可以做什么 |
| --- | --- |
| 需求分析 requirements | 读文件、搜索、检查命令；不能改文件、不能验证、不能委派 |
| 规划 plan | 读 + `delegate_plan` + `todo_write`；先用 `coding_handoff` 记录 goal，再写任务单；没有任务单不能进入实现 |
| 实现 implement | 只剩 `delegate_implement`、`coding_handoff`、`todo_write` 与控制类工具；编辑工具被移除 |
| 验证 verify | 读 + `run_verification` / `delegate_verify` + `todo_write`；先记录验收标准，失败按预算重试；失败不能交付 |
| 交付 deliver | 只读汇报；可把已完成条目勾成 completed；预算耗尽时为 BLOCKED 交付 |

| 控制类工具 | 作用 |
| --- | --- |
| `coding_stage` | 查看或推进阶段，放行与否由插件判定 |
| `coding_mode` / `coding_reasoning` | 选择工作流 / 调整推理等级 |
| `coding_handoff` | 读写跨阶段交接记录（goal / constraints / acceptance / findings / decisions / open / tasks / changes）；`{ reset: true }` 只重置验证重试预算，不清空记录 |

| 命令 | 作用 |
| --- | --- |
| `/coding` | 查看当前阶段、模式、任务单与验证状态（状态行含 `handoff goal=…, acceptance=N`、`attempt N`、`BLOCKED`、`delivery BLOCKED`） |
| `/coding auto / consult / review / codex` | 切换模式并新开一轮（`agent.followup()`） |
| `/coding set <模式>` | 静默设置模式（卡片按钮与首页选择器使用） |
| `/coding stage <阶段>` | 在当前轮内推进阶段（`agent.steer()`） |
| `/coding reset` | 重置验证重试预算（交接记录与最近一次验证结果保留） |

每轮结束处有**会话控制卡片**（模式、阶段路径、推理等级、验证状态、任务单进度、改动文件数；最新一轮可切换模式），每次 Coding 工具调用处有**阶段胶囊**。两者都从持久会话投影回放：刷新、重开、历史翻页都显示当时的真实状态，旧轮冻结在它实际运行的模式与阶段。

### 交接与验证预算

- 每个阶段的结论写进 `coding_handoff`，而不是留在对话里：planner 返回的任务、implement 报告的文件、verify 的发现会自动并入；记录随 checkpoint 持久化，重启与翻页可恢复，进入 worker 提示词时按角色裁剪并有字符/条数上限。
- 结构化任务必须带验收标准。codex 模式下 plan 前要有 goal，verify 前要有 acceptance，deliver 前两者都要有。
- 验证命令有总时限（`verificationTimeoutMs`，默认 6 分钟 = 360000 ms，可配置，`0` 不限制）：到点终止并记为一次失败，避免测试脚本死循环一直等待。
- 验证失败按预算重试（默认 5 次失败、同一失败签名 2 次）；耗尽后 `coding_stage(deliver)` 放行但标记为 BLOCKED 交付，`coding_handoff({ reset: true })` 或 `/coding reset` 重置预算，只有验证通过才自动清零——这是防止死循环的出口。

### 失败提示

- 关键调度点（子代理派发、验证启动/超时、工具表裁剪、会话恢复/投影、推理等级、交接写入、控制命令）遇到阻断性异常时，下一步会注入一条**运行中断**通知，写明原因与处理方式；状态行与会话 checkpoint 同时记录 `failure <point>`。
- 通知只出现一次，不新开 Turn；同一环节恢复成功后自动清除，重启只恢复 `failure` 状态、不重复提示。
- 普通验证失败仍走预算 / BLOCKED 路径，不产生该通知。
- 启动即失败（worker 路由或依赖缺失）没有下一步可注入，插件挂载错误里会附一段 `What to do`。

## 文档

- [设计思路与分层结构](docs/DETAIL.md)
- [开发者文档](docs/DEVELOPMENT.md)

## 许可

MIT
