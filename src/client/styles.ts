/**
 * The bundle's one stylesheet.
 *
 * Every rule is copied from a DSH component recipe or uses only DSH theme
 * tokens, so the card, the capsule, and the configuration page sit in the
 * conversation with the product's own typography, sizes, and colors:
 *
 * - card chrome: `PlanPreview.module.css` `.card` (bordered `card-fill` surface,
 *   `--dsw-radius-lg`, `font: inherit`),
 * - buttons: `PlanPreview.module.css` `.cardOpen` (28px high, 12px/18px,
 *   `--dsw-radius-sm`, floating fill) plus the pressed/focus states DSH uses,
 * - text: 12px/18px labels exactly like the shipped status rows,
 * - inputs: `PluginManagerPage.module.css` `.installField input` (40px,
 *   `--dsw-radius-md`, `--dsw-alias-border-l4`),
 * - colors: only `--dsw-alias-*` / `--dsw-radius-*` / `--dsw-focus-ring-*`.
 *
 * The module is browser-only and idempotent: one `<style data-plugin-css>`
 * tagged for HMR bookkeeping, replaced if a previous generation left it.
 *
 * @module dsh-coding/client/styles
 */

/** Marker the client module system uses to inventory this plugin's styles. */
export const STYLE_ID = 'dsh-coding/ui.css'

/** Plugin id recorded on the style tag for HMR ownership. */
const PLUGIN_ID = 'dsh-coding'

const CSS = `
/* Card: the shipped plan-card surface recipe. */
.dsh-coding-card {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 8px 10px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-card-fill);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  /* One base type for the whole card: the shipped status-row size. Without it
     a color-only utility (verification, separator, history hint) inherits the
     chat body size and the last row mixes two sizes. */
  font-size: 12px;
  line-height: 18px;
}
.dsh-coding-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  margin: 0;
}
.dsh-coding-label {
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
}
.dsh-coding-value {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-coding-hint {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-coding-error {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-state-error-primary);
}
.dsh-coding-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* One coding command receipt: the line, then its own text. */
.dsh-coding-command {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  font-size: 12px;
  line-height: 18px;
}
.dsh-coding-command .dsh-coding-value,
.dsh-coding-command .dsh-coding-error {
  white-space: pre-wrap;
}

/* First-message mode picker: the same status-row type as the card. */
.dsh-coding-picker {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  line-height: 18px;
}

/* Button: the shipped secondary-button recipe. */
.dsh-coding-button {
  box-sizing: border-box;
  height: 28px;
  padding: 4px 8px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-button-floating-fill);
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
  transition: background-color 0.12s, color 0.12s;
}
@media (hover: hover) {
  .dsh-coding-button:hover:not(:disabled) {
    color: var(--dsw-alias-label-primary);
    background: var(--dsw-alias-interactive-bg-hover);
  }
}
.dsh-coding-button[aria-pressed="true"] {
  border-color: var(--dsw-alias-state-business-primary);
  background: var(--dsw-alias-state-business-tertiary);
  color: var(--dsw-alias-state-business-primary);
}
.dsh-coding-button:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.dsh-coding-button:disabled {
  opacity: 0.6;
  cursor: default;
}
/* The page's primary action: one step up from the card's compact button. */
.dsh-coding-button-lg {
  height: 40px;
  padding: 8px 20px;
  border-radius: var(--dsw-radius-md);
  font-size: 14px;
  line-height: 20px;
}

/* Stage path: plain text at the shipped caption size, never a chip. */
.dsh-coding-stage {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-coding-stage[data-current="true"] {
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}
.dsh-coding-stage[data-done="true"] {
  color: var(--dsw-alias-label-secondary);
}
.dsh-coding-arrow {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-caption);
}

/* Capsule: one status line in the transcript, same type as the rows around it. */
.dsh-coding-capsule {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  padding: 2px 0;
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-coding-capsule .dsh-coding-stage,
.dsh-coding-capsule .dsh-coding-arrow,
.dsh-coding-capsule .dsh-coding-muted,
.dsh-coding-capsule .dsh-coding-faint,
.dsh-coding-capsule .dsh-coding-success,
.dsh-coding-capsule .dsh-coding-warn {
  font-size: inherit;
  line-height: inherit;
}
/* Color utilities also state the type role, so a bare span never inherits a
   different size from its container. */
.dsh-coding-muted,
.dsh-coding-faint,
.dsh-coding-success,
.dsh-coding-warn {
  font-size: 12px;
  line-height: 18px;
}
.dsh-coding-muted { color: var(--dsw-alias-label-secondary); }
.dsh-coding-faint { color: var(--dsw-alias-label-tertiary); }
/* The raw success token is a saturated green-500; at 12px on the card it reads
   too bright. Mixing in the theme's own label color keeps it green while giving
   light themes a deeper shade and dark themes a slightly lighter one. */
.dsh-coding-success {
  color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 72%, var(--dsw-alias-label-primary));
}
.dsh-coding-warn { color: var(--dsw-alias-state-warn-primary); }

/* Configuration page: shipped field and control recipes. */
.dsh-coding-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 4px 0;
  font: inherit;
}
.dsh-coding-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.dsh-coding-field > label {
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
}
.dsh-coding-field > .dsh-coding-hint {
  font-size: 12px;
  line-height: 18px;
}
.dsh-coding-input {
  box-sizing: border-box;
  width: 100%;
  height: 40px;
  padding: 0 14px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  outline: none;
  background: var(--dsw-alias-bg-layer-3);
  font: inherit;
  font-size: 13px;
  color: var(--dsw-alias-label-primary);
}
.dsh-coding-input:focus {
  border-color: var(--dsw-alias-state-business-primary);
  box-shadow: inset 0 0 0 0.5px var(--dsw-alias-state-business-primary);
}
.dsh-coding-input-warn {
  border-color: var(--dsw-alias-state-warn-primary);
  box-shadow: inset 0 0 0 0.5px var(--dsw-alias-state-warn-primary);
}
.dsh-coding-notice { margin: 0; font-size: 12px; line-height: 18px; }
.dsh-coding-notice-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.dsh-coding-mono {
  font-family: var(--ds-font-family-code);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  white-space: pre-wrap;
}
.dsh-coding-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
`

/**
 * Install the bundle stylesheet once per client generation.
 * @returns disposer removing the style tag this call created.
 */
export function installStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  // A previous generation (HMR) may have left its own tag; replace it so the
  // running page always carries this build's rules.
  document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`)?.remove()
  const tag = document.createElement('style')
  tag.dataset.plugin = PLUGIN_ID
  tag.dataset.pluginCss = STYLE_ID
  tag.textContent = CSS
  document.head.append(tag)
  return () => { tag.remove() }
}
