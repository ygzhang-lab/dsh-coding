/**
 * Copy of the Coding surface, registered as the `dsh-coding` Client locale
 * namespace, so visible UI text never hard-codes a language.
 *
 * @module dsh-coding/client/locales
 */

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Coding stage capsule, per-turn control card, and configuration page copy. */
    'dsh-coding': CodingKey
  }
}

/** Every dictionary key this client half uses. */
export type CodingKey =
  | 'aria'
  | 'hint.mode'
  | 'picker.label'
  | 'picker.aria'
  | 'mode.consult'
  | 'mode.review'
  | 'mode.auto'
  | 'mode.codex'
  | 'stage.requirements'
  | 'stage.plan'
  | 'stage.implement'
  | 'stage.verify'
  | 'stage.deliver'
  | 'verification.none'
  | 'verification.passed'
  | 'verification.failed'
  | 'plan.none'
  | 'plan.progress'
  | 'worker.running'
  | 'worker.completed'
  | 'worker.failed'
  | 'pending'
  | 'refused'
  | 'files'
  | 'card.mode'
  | 'card.stage'
  | 'card.verify'
  | 'card.stageHint'
  | 'card.switchFailed'
  | 'card.memory'
  | 'card.memoryHint'
  | 'card.memoryConfirm'
  | 'card.memoryCancel'
  | 'card.memoryBusy'
  | 'card.memoryDone'
  | 'card.memoryFailed'
  | 'card.stale'
  | 'card.reasoning'
  | 'reasoning.pending'
  | 'reasoning.sourceAuto'
  | 'reasoning.sourceOverride'
  | 'reasoning.sourcePick'
  | 'reasoning.sourceSettings'
  | 'config.title'
  | 'config.hint'
  | 'config.mode'
  | 'config.modeHint'
  | 'config.implementModel'
  | 'config.implementModelHint'
  | 'config.plannerModel'
  | 'config.plannerModelHint'
  | 'config.verifyModel'
  | 'config.verifyModelHint'
  | 'config.language'
  | 'config.languageHint'
  | 'config.languageAuto'
  | 'config.reasoning'
  | 'config.reasoningHint'
  | 'config.reasoningAuto'
  | 'config.verification'
  | 'config.verificationHint'
  | 'config.commands'
  | 'config.commandsHint'
  | 'config.save'
  | 'config.saving'
  | 'config.saved'
  | 'config.saveFailed'
  | 'config.invalidRoute'
  | 'config.readOnly'
  | 'config.loading'
  | 'config.unavailable'
  | 'config.reset'
  | 'config.presetWarning'
  | 'config.modelWarning'
  | 'config.modelsLoading'
  | 'config.modelsUnavailable'
  | 'config.modelsRetry'
  | 'config.modelAuto'
  | 'config.modelMissing'
  | 'config.modelProbeFailed'

/** English copy. */
export const en: Record<CodingKey, string> = {
  aria: 'Coding runtime stage',
  'hint.mode': 'Switch mode with /coding auto, /coding consult, /coding review, or /coding codex',
  'picker.label': 'Mode',
  'picker.aria': 'Coding mode for the first message',
  'mode.consult': 'Q&A',
  'mode.review': 'Review',
  'mode.auto': 'Auto',
  'mode.codex': 'Codex',
  'stage.requirements': 'Requirements',
  'stage.plan': 'Plan',
  'stage.implement': 'Implement',
  'stage.verify': 'Verify',
  'stage.deliver': 'Deliver',
  'verification.none': 'not verified',
  'verification.passed': 'verified',
  'verification.failed': 'verification failed',
  'plan.none': 'no task list',
  'plan.progress': '{done}/{total} plan steps',
  'worker.running': '{role} worker running',
  'worker.completed': '{role} worker done',
  'worker.failed': '{role} worker failed',
  pending: 'running {tool}',
  refused: 'advance refused',
  files: '{count} files changed',
  'card.mode': 'Mode',
  'card.stage': 'Stage',
  'card.verify': 'Verification',
  'card.stageHint': 'Edit with /coding stage <stage>',
  'card.switchFailed': 'The mode was not changed. Try /coding <mode>.',
  'card.memory': 'End task & write handoff',
  'card.memoryHint': 'Writes one Markdown handoff document under .agents/memory in the project root.',
  'card.memoryConfirm': 'Generate',
  'card.memoryCancel': 'Cancel',
  'card.memoryBusy': 'Writing…',
  'card.memoryDone': 'Handoff document written',
  'card.memoryFailed': 'Could not write the handoff document. Retry or run /coding memory.',
  'card.stale': 'history',
  'card.reasoning': 'Reasoning',
  'reasoning.pending': 'pending',
  'reasoning.sourceAuto': 'automatic',
  'reasoning.sourceOverride': 'session override',
  'reasoning.sourcePick': 'chat-box pick',
  'reasoning.sourceSettings': 'pinned by settings',
  'config.title': 'Coding runtime',
  'config.hint': 'These values are validated when saved and used by every later stage decision and worker dispatch.',
  'config.mode': 'Default mode',
  'config.modeHint': 'Mode a new Coding session starts in; auto chooses the workflow during the requirements stage.',
  'config.implementModel': 'Implement worker model',
  'config.implementModelHint': 'Pick from the models this Host configures; automatic follows the lead\'s current model. Never inherited silently.',
  'config.plannerModel': 'Planner worker model',
  'config.plannerModelHint': 'Pick from the models this Host configures. `auto` follows the lead, which also skips the planner gate; pick a pro route to force a separate planning pass.',
  'config.verifyModel': 'Verify worker model',
  'config.verifyModelHint': 'Pick from the models this Host configures; automatic follows the lead\'s current model.',
  'config.language': 'Conversation language',
  'config.languageHint': 'Auto follows the DSH interface, then the host locale. Only Chinese and English ship.',
  'config.languageAuto': 'Automatic (follow DSH)',
  'config.reasoning': 'Reasoning level',
  'config.reasoningHint': 'Auto classifies each turn from the request; low, high, or max pins every turn. A chat-box effort pick or coding_reasoning overrides automatic only.',
  'config.reasoningAuto': 'Automatic (recommended)',
  'config.verification': 'Verification',
  'config.verificationHint': 'The verify stage runs these checks; the deliver gate needs a passing result.',
  'config.commands': 'Verification command overrides',
  'config.commandsHint': 'Keyed by kind or kind:scope. Edit them in the bundle patch configuration.',
  'config.save': 'Save',
  'config.saving': 'Saving…',
  'config.saved': 'Saved.',
  'config.saveFailed': 'The configuration was rejected. Check the values and Host authorization.',
  'config.invalidRoute': 'Use `auto` or provider/model, for example deepseek-account/deepseek-flash.',
  'config.readOnly': 'This deployment stores settings read-only.',
  'config.loading': 'Loading configuration…',
  'config.unavailable': 'This Host does not expose the configuration form for this entry.',
  'config.reset': 'Restore defaults',
  'config.presetWarning': 'Keep every plugin of the Coding preset enabled, or this plugin cannot work.',
  'config.modelWarning': 'The list comes from the models this Host configures; a route outside the catalog cannot be picked.',
  'config.modelsLoading': 'Loading models…',
  'config.modelsUnavailable': 'Could not load the configured model list:',
  'config.modelsRetry': 'Reload models',
  'config.modelAuto': 'Automatic (follow the lead\'s current model)',
  'config.modelMissing': 'not in the current model list',
  'config.modelProbeFailed': 'Providers with no discoverable models:',
}

/** Chinese copy. */
export const zh: Record<CodingKey, string> = {
  aria: 'Coding 运行时阶段',
  'hint.mode': '用 /coding auto、/coding consult、/coding review、/coding codex 切换模式',
  'picker.label': '工作模式',
  'picker.aria': '首条消息的工作模式',
  'mode.consult': '问答',
  'mode.review': '审查',
  'mode.auto': '自动',
  'mode.codex': 'Codex',
  'stage.requirements': '需求分析',
  'stage.plan': '规划',
  'stage.implement': '实现',
  'stage.verify': '验证',
  'stage.deliver': '交付',
  'verification.none': '未验证',
  'verification.passed': '已验证',
  'verification.failed': '验证失败',
  'plan.none': '无任务单',
  'plan.progress': '任务 {done}/{total}',
  'worker.running': '{role} 子代理运行中',
  'worker.completed': '{role} 子代理完成',
  'worker.failed': '{role} 子代理失败',
  pending: '正在执行 {tool}',
  refused: '阶段推进被拒绝',
  files: '已改 {count} 个文件',
  'card.mode': '模式',
  'card.stage': '阶段',
  'card.verify': '验证',
  'card.stageHint': '用 /coding stage <阶段> 调整',
  'card.switchFailed': '模式未切换成功，请重试或直接执行 /coding <模式>。',
  'card.memory': '结束任务并生成交接文档',
  'card.memoryHint': '将在项目根 .agents/memory 下写一篇本轮交接文档。',
  'card.memoryConfirm': '确认生成',
  'card.memoryCancel': '取消',
  'card.memoryBusy': '正在写入…',
  'card.memoryDone': '已生成交接文档',
  'card.memoryFailed': '未能生成交接文档，请重试或执行 /coding memory。',
  'card.stale': '历史',
  'card.reasoning': '推理',
  'reasoning.pending': '待确定',
  'reasoning.sourceAuto': '自动',
  'reasoning.sourceOverride': '会话覆盖',
  'reasoning.sourcePick': '对话框选择',
  'reasoning.sourceSettings': '设置固定',
  'config.title': 'Coding 运行时',
  'config.hint': '保存后立即校验；后续每次阶段判定与子代理派发都会使用新值。',
  'config.mode': '默认模式',
  'config.modeHint': '新建 Coding 会话的初始模式；自动模式在需求分析阶段选择工作流。',
  'config.implementModel': '实现 worker 模型',
  'config.implementModelHint': '从当前 DSH 已配置的模型里选择；「自动」跟随主代理当前模型。不会静默继承。',
  'config.plannerModel': '规划 worker 模型（pro）',
  'config.plannerModelHint': '从当前 DSH 已配置的模型里选择；「自动」跟随主代理，planner 门禁随之跳过；想强制独立规划就选一条 pro 路由。',
  'config.verifyModel': '验证 worker 模型',
  'config.verifyModelHint': '从当前 DSH 已配置的模型里选择；「自动」跟随主代理当前模型。',
  'config.language': '会话语言',
  'config.languageHint': '自动模式先跟随 DSH 界面语言，再跟随宿主环境语言；插件只带中文和英文。',
  'config.languageAuto': '自动（跟随 DSH）',
  'config.reasoning': '推理等级',
  'config.reasoningHint': '自动会按每轮请求分类；low/high/max 固定所有轮次。聊天框选择 effort 或 coding_reasoning 只在自动时生效。',
  'config.reasoningAuto': '自动（推荐）',
  'config.verification': '验证门禁',
  'config.verificationHint': '验证阶段运行这些检查；交付门禁要求一次通过的结果。',
  'config.commands': '验证命令覆盖',
  'config.commandsHint': '按 kind 或 kind:scope 指定；需在插件包配置中修改。',
  'config.save': '保存',
  'config.saving': '保存中…',
  'config.saved': '已保存。',
  'config.saveFailed': '配置被拒绝，请检查取值与 Host 授权。',
  'config.invalidRoute': '请选择「自动」或填写 provider/model，例如 deepseek-account/deepseek-flash。',
  'config.readOnly': '当前部署的设置是只读的。',
  'config.loading': '正在加载配置…',
  'config.unavailable': '当前 Host 未为此插件条目提供配置表单。',
  'config.reset': '恢复默认',
  'config.presetWarning': '请保持 Coding 预设全部开启状态，否则本插件无法工作。',
  'config.modelWarning': '下拉选项来自当前 Host 已配置的模型；目录外的值无法选择。',
  'config.modelsLoading': '正在加载模型列表…',
  'config.modelsUnavailable': '无法加载已配置的模型列表：',
  'config.modelsRetry': '重新加载模型',
  'config.modelAuto': '自动（跟随主代理当前模型）',
  'config.modelMissing': '不在当前模型列表',
  'config.modelProbeFailed': '以下 provider 未能枚举出模型：',
}
