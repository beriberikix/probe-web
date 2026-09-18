import type { ITheme } from '@xterm/xterm';
import { currentScheme, onSchemeChange, type ColorScheme } from './color-scheme.ts';

// ANSI palettes tuned on the theme's colours, so defmt levels (and anything else that
// prints colour) stay readable on both backgrounds.
const light: ITheme = {
  background: '#ffffff', foreground: '#3c3c43', cursor: '#3451b2', cursorAccent: '#ffffff',
  selectionBackground: 'rgba(100, 108, 255, 0.22)',
  black: '#3c3c43', red: '#b8272c', green: '#18794e', yellow: '#946300',
  blue: '#3451b2', magenta: '#6f42c1', cyan: '#0e7490', white: '#67676c',
  brightBlack: '#929295', brightRed: '#d5393e', brightGreen: '#299764', brightYellow: '#9f6a00',
  brightBlue: '#3a5ccc', brightMagenta: '#8e5cd9', brightCyan: '#0891b2', brightWhite: '#3c3c43',
};
const dark: ITheme = {
  background: '#1b1b1f', foreground: '#dfdfd6', cursor: '#a8b1ff', cursorAccent: '#1b1b1f',
  selectionBackground: 'rgba(100, 108, 255, 0.3)',
  black: '#32363f', red: '#f66f81', green: '#3dd68c', yellow: '#f9b44e',
  blue: '#a8b1ff', magenta: '#c8abfa', cyan: '#5fd4e8', white: '#dfdfd6',
  brightBlack: '#6a6a71', brightRed: '#f14158', brightGreen: '#30a46c', brightYellow: '#da8b17',
  brightBlue: '#5c73e7', brightMagenta: '#a879e6', brightCyan: '#22b8cf', brightWhite: '#ffffff',
};

/** The xterm.js theme that matches the probe-web theme in `scheme`. */
export function terminalTheme(scheme: ColorScheme): ITheme {
  return scheme === 'dark' ? dark : light;
}

/** The font stack the terminals use: the theme's monospace font. */
export const terminalFontFamily = "ui-monospace, Menlo, Monaco, Consolas, 'Liberation Mono', monospace";

/**
 * Give an xterm.js terminal the theme for the page's colour scheme and keep it in step
 * when the scheme changes. Returns a function that stops following the page.
 */
export function followScheme(term: { options: { theme?: ITheme } }): () => void {
  term.options.theme = terminalTheme(currentScheme());
  return onSchemeChange((s) => { term.options.theme = terminalTheme(s); });
}
