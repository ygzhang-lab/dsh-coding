/**
 * Language tests: the shipped pair is Chinese and English, `auto` follows the
 * DSH preference, then the OS language list, then the host locale, and the
 * prompt section states the resolved language.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  hostLocaleOf,
  isNeutralLocale,
  languageOf,
  languagePrompt,
  normalizeLanguageMode,
  resolveHostLanguage,
} from '../lib/language.js'
import { parseAppleLanguages } from '../lib/system-language.js'

test('only Chinese selects Chinese; every other tag falls back to English', () => {
  assert.equal(languageOf('zh'), 'zh')
  assert.equal(languageOf('zh-Hans-CN'), 'zh')
  assert.equal(languageOf('ZH_hant_TW.UTF-8'), 'zh')
  assert.equal(languageOf('en-US'), 'en')
  assert.equal(languageOf('ja-JP'), 'en')
  assert.equal(languageOf(''), 'en')
  assert.equal(languageOf(undefined), 'en')
  assert.equal(normalizeLanguageMode('zh'), 'zh')
  assert.equal(normalizeLanguageMode('fr'), 'auto')
  assert.equal(normalizeLanguageMode(undefined), 'auto')
})

test('a neutral POSIX locale states no preference', () => {
  assert.equal(isNeutralLocale('C.UTF-8'), true)
  assert.equal(isNeutralLocale('POSIX'), true)
  assert.equal(isNeutralLocale(''), true)
  assert.equal(isNeutralLocale('zh_CN.UTF-8'), false)
  assert.equal(hostLocaleOf({ LANG: 'C.UTF-8' }) !== '', true)
})

test('auto resolves the stored DSH preference before any host signal', () => {
  const loader = { entries: () => [{ options: { name: '@deepseek-ai/dsh-client-locale', config: { preference: 'zh-CN' } } }] }
  assert.equal(resolveHostLanguage({ mode: 'auto', loader, locale: 'en-US', systemLanguages: () => ['en-US'] }), 'zh')
  // A pinned mode never consults the composition.
  assert.equal(resolveHostLanguage({ mode: 'en', loader, systemLanguages: () => ['zh-Hans'] }), 'en')
})

test('auto skips unsupported OS languages instead of folding them into English', () => {
  assert.equal(resolveHostLanguage({ mode: 'auto', systemLanguages: ['ja-JP', 'zh-Hans-CN'], locale: 'en-US' }), 'zh')
  assert.equal(resolveHostLanguage({ mode: 'auto', systemLanguages: ['ja-JP', 'en-GB'], locale: 'zh-CN' }), 'en',
    'a shipped English entry wins before the neutral host locale')
  // No shipped OS entry: the host locale decides, and a neutral one is English.
  assert.equal(resolveHostLanguage({ mode: 'auto', systemLanguages: [], locale: 'C.UTF-8' }), 'en')
})

test('the language prompt names the language and preserves code', () => {
  const zh = languagePrompt('zh')
  assert.match(zh, /中文/u)
  assert.match(zh, /代码/u)
  const en = languagePrompt('en')
  assert.match(en, /English/u)
  assert.match(en, /file paths/u)
})

test('the macOS language-list parser accepts both quoted and bare entries', () => {
  assert.deepEqual(parseAppleLanguages('(\n    "zh-Hans-CN",\n    "en-US"\n)\n'), ['zh-Hans-CN', 'en-US'])
  assert.deepEqual(parseAppleLanguages('zh-Hans-CN,\nen-US\n'), ['zh-Hans-CN', 'en-US'])
})
