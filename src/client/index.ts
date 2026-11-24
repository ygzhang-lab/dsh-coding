/**
 * Browser half of the `dsh-coding` bundle.
 *
 * It contributes four surfaces, all as effects so an unload or a slot-owner
 * collapse removes them:
 *
 * 1. the per-turn control card in `conversation.chat.turnTail`, which reads the
 *    durable `dshCodingStage` projection and switches mode through `/coding …`;
 * 2. the stage capsule Definition in `conversation.chat.node`, which renders
 *    the checkpoint each Coding tool call leaves in `tool/result.meta`;
 * 3. the command row in `conversation.chat.commandview`, which hides the mode
 *    switch receipts (they show up in the picker, the card, and the capsule)
 *    and keeps every other `/coding` receipt as one text line;
 * 4. the bundle's configuration page in `plugins.bundle.config`.
 *
 * @module dsh-coding/client
 */
import { createElement as h } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the SlotMap merge (conversation.chat.node / turnTail) and
// the locale merge; the settings merge supplies `ctx.configForms`.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { CAPSULE_KIND, capsuleDefinition } from './definition.js'
import { CodingStageCapsule } from './capsule.js'
import { CodingTurnCard } from './card.js'
import { CodingModePicker } from './mode-picker.js'
import { CodingCommandRow } from './command-row.js'
import {
  CodingConfigPage,
  SETTINGS_NAMESPACE,
  type CodingConfigForm,
  type ModelCatalogRemote,
} from './config-page.js'
import { installStyles } from './styles.js'
import { en, zh } from './locales.js'

/** Locale namespace owned by this plugin. */
export const NS = 'dsh-coding'

/** The bundle's package name, which is also its configuration-page key. */
const PACKAGE_NAME = 'dsh-coding'

/** Client services this half needs before it can register anything. */
export const inject = ['slots', 'locale', 'uiConversation', 'configForms', 'remote', 'remote.commands', 'remote.session']

/** The slice of the commands Remote the turn card calls. */
interface CommandRemote {
  execute?(sessionId: string, line: string, args: readonly unknown[]): unknown
}

/**
 * Register the card, the first-message pickers, the capsule, and the configuration page.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const translate = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-coding: dictionaries')
  // One stylesheet for the card, the capsule, and the page; every rule uses a
  // shipped DSH recipe or theme token (see ./styles.ts).
  ctx.effect(() => installStyles(), 'dsh-coding: styles')

  /** Run one `/coding …` line against the session through the Host. */
  const runCommand = (sessionId: unknown, line: string): unknown => {
    const commands = (ctx as unknown as { remote?: { commands?: CommandRemote } }).remote?.commands
    if (typeof commands?.execute !== 'function' || typeof sessionId !== 'string') return undefined
    return commands.execute(sessionId, line, [])
  }

  // The configuration form is shared: the page edits it, and the per-turn card
  // reads the pinned reasoning policy as a label only. The form owns the write
  // queue (revision fence, Host validation, recovery read).
  const forms = (ctx as unknown as { configForms: { get(id: string): CodingConfigForm } }).configForms
  // 当前 DSH 版本按条目 id 提供表单，但条目缺失时 `get` 可能返回 undefined：
  // 页面包装层必须先给出提示，不能让整块配置区随渲染异常一起消失。
  const form = forms.get(SETTINGS_NAMESPACE) as CodingConfigForm | undefined
  // The model catalog is the Host session catalog the composer renders, so a
  // third-party provider declared statically in a patch config is listed too.
  // Resolve the namespace lazily: the page reads its catalog when it opens, and
  // a late-arriving service must never keep this bundle from registering.
  const sessionRemote: ModelCatalogRemote = {
    modelCatalog: () => {
      // 读命名空间本身也可能抛错（服务尚未挂载）：统一转成 rejected Promise，
      // 页面的 effect 只按目录加载失败处理，不影响其它槽位。
      try {
        const session = (ctx as unknown as { remote?: { session?: ModelCatalogRemote } }).remote?.session
        if (typeof session?.modelCatalog !== 'function') {
          return Promise.reject(new Error('The Host does not expose the session model catalog Remote.'))
        }
        return session.modelCatalog()
      } catch {
        return Promise.reject(new Error('The Host does not expose the session model catalog Remote.'))
      }
    },
  }
  const settingsValue = (): unknown => {
    try {
      return form?.getSnapshot?.()?.value?.reasoning
    } catch {
      return undefined
    }
  }

  // ── Per-turn control card ─────────────────────────────────────────────────
  // The card is a plain turn-tail entry, so it renders on every closed Turn of
  // a Coding session — including a turn where the model ran no Coding tool.
  const turnCard = (props: any) => h(CodingTurnCard, {
    ...props,
    t: props.t ?? translate,
    execute: (line: string) => runCommand(props.sessionId, line),
    settings: settingsValue,
  })
  const slots = ctx.slots as unknown as {
    inject(owner: string, register: () => () => void): () => void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
  ctx.effect(() => slots.inject('conversation.chat.turnTail', () => slots.register({
    name: 'conversation.chat.turnTail',
    id: 'dsh-coding/turn-card',
    order: 50,
    locale: NS,
  }, turnCard)), 'dsh-coding: turn card')

  // ── First-message mode picker ─────────────────────────────────────────────
  // The blank-session hero renders this beside the composer. It sends the
  // silent `/coding set <mode>` so the choice applies to the first Turn without
  // starting one; later switches stay on the per-Turn card.
  const modePicker = (props: any) => h(CodingModePicker, {
    ...props,
    t: props.t ?? translate,
    execute: (line: string) => runCommand(props.sessionId, line),
  })
  ctx.effect(() => slots.inject('conversation.hero.options', () => slots.register({
    name: 'conversation.hero.options',
    id: 'dsh-coding/mode-picker',
    order: 20,
    locale: NS,
  }, modePicker)), 'dsh-coding: mode picker')

  // ── Stage capsule ─────────────────────────────────────────────────────────
  ctx.effect(() => ctx.uiConversation.events.register(capsuleDefinition), 'dsh-coding: capsule definition')
  ctx.effect(() => slots.inject('conversation.chat.node', () => slots.register({
    name: 'conversation.chat.node',
    key: CAPSULE_KIND,
    locale: NS,
  }, CodingStageCapsule)), 'dsh-coding: capsule node')

  // ── Command row ───────────────────────────────────────────────────────────
  // `conversation.chat.commandview` is keyed by command name, so registering
  // key `coding` replaces the default receipt card for this plugin's command.
  ctx.effect(() => slots.inject('conversation.chat.commandview', () => slots.register({
    name: 'conversation.chat.commandview',
    key: 'coding',
    locale: NS,
  }, CodingCommandRow)), 'dsh-coding: command row')

  // ── Configuration page ────────────────────────────────────────────────────
  // A bundle page receives only `view` as owner props, so the page takes the
  // Host form from `ctx.configForms` by entry id. The form owns the write queue
  // (revision fence, Host validation, recovery read): this page never calls
  // `ctx.remote.settings` itself.
  const configPage = (props: any) => form === undefined
    ? h('p', { className: 'dsh-coding-hint' }, (props.t ?? translate)('config.unavailable'))
    : h(CodingConfigPage, {
      ...props,
      form,
      // 模型下拉读 `ctx.remote.session.modelCatalog`，与 composer 用同一份目录。
      remote: sessionRemote,
      t: props.t ?? translate,
    })
  ctx.effect(() => slots.inject('plugins.bundle.config', () => slots.register({
    name: 'plugins.bundle.config',
    key: PACKAGE_NAME,
    locale: NS,
  }, configPage)), 'dsh-coding: configuration page')
}
