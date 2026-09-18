import { css } from 'lit';

/**
 * The look every component shares: the theme tokens (from `@probe-web/ui/theme.css`, with
 * its light values as fallbacks, so a component also renders on a page without the
 * theme) and the form controls, which a shadow root does not inherit from the page.
 *
 * Inside a component use the short private names (`--_bg`, `--_brand-1`, …); a page
 * themes the components through the public `--pw-*` properties.
 */
export const baseStyles = css`
  :host {
    --_bg: var(--pw-c-bg, #ffffff);
    --_bg-alt: var(--pw-c-bg-alt, #f6f6f7);
    --_bg-soft: var(--pw-c-bg-soft, #f6f6f7);
    --_text-1: var(--pw-c-text-1, #3c3c43);
    --_text-2: var(--pw-c-text-2, #67676c);
    --_text-3: var(--pw-c-text-3, #929295);
    --_border: var(--pw-c-border, #c2c2c4);
    --_divider: var(--pw-c-divider, #e2e2e3);
    --_default-1: var(--pw-c-default-1, #dddde3);
    --_default-2: var(--pw-c-default-2, #e4e4e9);
    --_default-3: var(--pw-c-default-3, #ebebef);
    --_default-soft: var(--pw-c-default-soft, rgba(142, 150, 170, 0.14));
    --_brand-1: var(--pw-c-brand-1, #3451b2);
    --_brand-2: var(--pw-c-brand-2, #3a5ccc);
    --_brand-3: var(--pw-c-brand-3, #5672cd);
    --_brand-soft: var(--pw-c-brand-soft, rgba(100, 108, 255, 0.14));
    --_purple-1: var(--pw-c-purple-1, #6f42c1);
    --_green-1: var(--pw-c-green-1, #18794e);
    --_green-2: var(--pw-c-green-2, #299764);
    --_green-soft: var(--pw-c-green-soft, rgba(16, 185, 129, 0.14));
    --_yellow-1: var(--pw-c-yellow-1, #915930);
    --_yellow-2: var(--pw-c-yellow-2, #946300);
    --_yellow-soft: var(--pw-c-yellow-soft, rgba(234, 179, 8, 0.14));
    --_red-1: var(--pw-c-red-1, #b8272c);
    --_red-2: var(--pw-c-red-2, #d5393e);
    --_red-3: var(--pw-c-red-3, #e0575b);
    --_red-soft: var(--pw-c-red-soft, rgba(244, 63, 94, 0.14));
    --_white: var(--pw-c-white, #ffffff);
    --_mono: var(--pw-font-family-mono, ui-monospace, Menlo, Monaco, Consolas, monospace);
    --_radius: var(--pw-radius, 6px);
    --_radius-lg: var(--pw-radius-lg, 8px);
    --_h: var(--pw-control-height, 26px);

    display: block;
    font: 13px/1.5 var(--pw-font-family-base, 'Inter', ui-sans-serif, system-ui, sans-serif);
    color: var(--_text-1);
  }

  button, input, select, textarea { font: inherit; color: inherit; }
  button {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    box-sizing: border-box; min-height: var(--_h); padding: 0 10px;
    border: 1px solid transparent; border-radius: var(--_radius);
    background: var(--_default-3); font-weight: 500; white-space: nowrap; cursor: pointer;
    transition: background-color 0.15s, color 0.15s;
  }
  button:hover:not(:disabled) { background: var(--_default-2); }
  button:active:not(:disabled) { background: var(--_default-1); }
  button:disabled { opacity: 0.5; cursor: default; }
  button.primary { background: var(--_brand-3); color: var(--_white); }
  button.primary:hover:not(:disabled) { background: var(--_brand-2); }
  button.primary:active:not(:disabled) { background: var(--_brand-1); }
  button.ghost, button.icon { background: transparent; }
  button.ghost:hover:not(:disabled), button.icon:hover:not(:disabled) { background: var(--_default-soft); }
  button.icon { width: var(--_h); padding: 0; color: var(--_text-2); }
  button.icon:hover:not(:disabled) { color: var(--_text-1); }
  svg.icon { flex: none; }

  input[type='text'], input[type='number'], input[type='search'], input:not([type]), select {
    box-sizing: border-box; min-height: var(--_h); padding: 0 8px;
    border: 1px solid var(--_divider); border-radius: var(--_radius);
    background: var(--_bg); transition: border-color 0.15s;
  }
  select { padding-right: 4px; }
  input:hover, select:hover { border-color: var(--_border); }
  input:focus, select:focus { outline: none; border-color: var(--_brand-2); }
  input::placeholder { color: var(--_text-3); }
  input[type='checkbox'], input[type='radio'], progress { accent-color: var(--_brand-3); }
  input[type='file'] { font-size: 12px; color: var(--_text-2); }
  input[type='file']::file-selector-button {
    font: inherit; font-weight: 500; color: var(--_text-1); margin-right: 8px;
    min-height: var(--_h); padding: 0 10px; border: 0; border-radius: var(--_radius);
    background: var(--_default-3); cursor: pointer;
  }
  input[type='file']::file-selector-button:hover { background: var(--_default-2); }
  label { display: inline-flex; align-items: center; gap: 5px; }
  :focus-visible { outline: 2px solid var(--_brand-2); outline-offset: 1px; }
  input:focus-visible, select:focus-visible { outline: none; }

  .muted { color: var(--_text-2); }
  .err { color: var(--_red-1); }
  .warn { color: var(--_yellow-1); }
  .ok { color: var(--_green-1); }
  .mono { font-family: var(--_mono); font-size: 12px; }
  .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin: 6px 0; }
  .sep { width: 1px; align-self: stretch; margin: 3px 2px; background: var(--_divider); }

  * { scrollbar-width: thin; scrollbar-color: var(--_default-1) transparent; }
`;
