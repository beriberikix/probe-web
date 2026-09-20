// The frame shared by the apps: fonts, theme tokens, the app bar and dark mode.
//
// Dark mode uses the docs' setting: VitePress keeps it in localStorage under
// `vitepress-theme-appearance` ('auto' | 'dark' | 'light'), and the deployed docs and apps
// share an origin, so a choice made in one carries over to the other. Each page's <head>
// applies it before first paint with the same inline script VitePress uses; this module
// keeps it current.
import '@fontsource-variable/inter';
import '@probe-web/ui/theme.css';
import './shell.css';
import { iconMarkup, type IconName } from '@probe-web/ui/icons';

const KEY = 'vitepress-theme-appearance';
const media = matchMedia('(prefers-color-scheme: dark)');

function preference(): string {
  try {
    return localStorage.getItem(KEY) || 'auto';
  } catch {
    return 'auto';
  }
}

function apply() {
  const p = preference();
  document.documentElement.classList.toggle('dark', p === 'auto' ? media.matches : p === 'dark');
  const button = document.querySelector<HTMLButtonElement>('.app-bar .theme-toggle');
  if (button) renderToggle(button);
}

/** Switch between light and dark; like VitePress, a choice that matches the system is stored as 'auto'. */
function toggle() {
  const dark = !document.documentElement.classList.contains('dark');
  const value = dark === media.matches ? 'auto' : dark ? 'dark' : 'light';
  try {
    localStorage.setItem(KEY, value);
  } catch {
    // Private mode: the switch still works for this page.
  }
  document.documentElement.classList.toggle('dark', dark);
  const button = document.querySelector<HTMLButtonElement>('.app-bar .theme-toggle');
  if (button) renderToggle(button);
}

function renderToggle(button: HTMLButtonElement) {
  const dark = document.documentElement.classList.contains('dark');
  button.innerHTML = iconMarkup(dark ? 'sun' : 'moon', 16);
  button.title = dark ? 'Switch to light theme' : 'Switch to dark theme';
  button.setAttribute('aria-label', button.title);
}

media.addEventListener('change', apply);
addEventListener('storage', (e) => {
  if (e.key === KEY) apply();
});

/** The apps that share the app bar. */
export type AppId = 'flash' | 'workbench' | 'inspect';

const DOCS = 'https://beriberikix.github.io/probe-web/';

function links() {
  // In development the flasher's server hosts every app, with the flasher at the root;
  // the site puts each app in its own directory beside the docs.
  const base = import.meta.env.BASE_URL;
  const dev = import.meta.env.DEV;
  return {
    flash: dev ? '/' : `${base}flash/`,
    workbench: `${base}workbench/`,
    inspect: `${base}inspect/`,
    docs: dev ? DOCS : base,
  };
}

const TITLES: Record<AppId, string> = { flash: 'Flasher', workbench: 'Workbench', inspect: 'Inspector' };

/**
 * Fill the page's `<header class="app-bar" data-app="…">`. The header is in the HTML (with
 * its height reserved there) so nothing shifts when this runs.
 */
function mountAppBar(header: HTMLElement) {
  const current = header.dataset.app as AppId;
  const href = links();
  // An app can put its own controls in the bar (the workbench's Launch, Attach, …).
  const actions = header.querySelector<HTMLElement>(':scope > .app-actions');
  const nav = (Object.keys(TITLES) as AppId[])
    .map((id) => `<a href="${href[id]}"${id === current ? ' aria-current="page"' : ''}>${TITLES[id]}</a>`)
    .join('');
  header.innerHTML = `
    <a class="brand" href="${href.docs}" title="probe-web documentation">
      <img src="${import.meta.env.BASE_URL}favicon.svg" alt="" width="22" height="22">
      <span class="wordmark">probe-web</span>
    </a>
    <span class="app-title">${TITLES[current]}</span>
    <nav aria-label="Apps">${nav}<span class="divider"></span><a href="${href.docs}">Docs</a></nav>
    <span class="spacer"></span>
    <button class="icon theme-toggle" type="button"></button>
    <a class="icon-link" href="https://github.com/beriberikix/probe-web" title="probe-web on GitHub" aria-label="probe-web on GitHub">${iconMarkup('github', 18)}</a>
  `;
  if (actions) header.querySelector('.spacer')!.after(actions);
  const button = header.querySelector<HTMLButtonElement>('.theme-toggle')!;
  button.addEventListener('click', toggle);
  renderToggle(button);
}

apply();
for (const header of document.querySelectorAll<HTMLElement>('header.app-bar[data-app]')) mountAppBar(header);

/**
 * Put a short status next to the title of a `<details class="view">` sidebar section, so a
 * collapsed section still says where it stands (as VS Code's views do).
 */
export function setViewBadge(view: HTMLElement | null, text: string, state: 'ok' | 'err' | 'busy' | '' = '') {
  const badge = view?.querySelector<HTMLElement>(':scope > summary .badge');
  if (!badge) return;
  badge.textContent = text;
  badge.dataset.state = state;
  badge.title = text;
}

/**
 * A tab strip over panels, like VS Code's bottom panel: `<div role="tablist">` of
 * `<button role="tab" aria-controls="panel-id">`. Inactive panels are `hidden`; a tab whose
 * panel gets output while hidden shows an unread dot until it is selected.
 */
export class PanelTabs {
  private tabs: HTMLButtonElement[];
  private readonly key: string | null;

  constructor(list: HTMLElement, storageKey?: string) {
    this.tabs = [...list.querySelectorAll<HTMLButtonElement>('[role=tab]')];
    this.key = storageKey ?? null;
    for (const tab of this.tabs) {
      tab.addEventListener('click', () => this.select(tab.getAttribute('aria-controls')!));
      tab.addEventListener('keydown', (e) => this.onKey(e, tab));
    }
    let initial = this.tabs[0]?.getAttribute('aria-controls') ?? '';
    try {
      const saved = this.key && localStorage.getItem(this.key);
      if (saved && this.tabs.some((t) => t.getAttribute('aria-controls') === saved)) initial = saved;
    } catch {
      // No storage: start on the first tab.
    }
    this.select(initial);
  }

  /** Show the panel with this id. */
  select(id: string) {
    for (const tab of this.tabs) {
      const on = tab.getAttribute('aria-controls') === id;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      if (on) tab.classList.remove('unread');
      document.getElementById(tab.getAttribute('aria-controls')!)!.hidden = !on;
    }
    try {
      if (this.key) localStorage.setItem(this.key, id);
    } catch {
      // Not remembered; harmless.
    }
  }

  /** Mark a hidden panel as having new output. */
  markUnread(id: string) {
    const tab = this.tabs.find((t) => t.getAttribute('aria-controls') === id);
    if (tab && tab.getAttribute('aria-selected') !== 'true') tab.classList.add('unread');
  }

  private onKey(e: KeyboardEvent, tab: HTMLButtonElement) {
    const i = this.tabs.indexOf(tab);
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : -1;
    if (next < 0 && e.key !== 'ArrowLeft') return;
    const target = this.tabs[(next + this.tabs.length) % this.tabs.length];
    this.select(target.getAttribute('aria-controls')!);
    target.focus();
    e.preventDefault();
  }
}

/**
 * Let the user resize a panel by dragging `handle`: `apply(size)` gets the new size in
 * pixels, `measure()` the current one. The size is remembered under `storageKey`.
 */
export function resizable(handle: HTMLElement, opts: {
  axis: 'x' | 'y'; invert?: boolean; min: number; max: () => number;
  measure: () => number; apply: (size: number) => void; storageKey: string;
}) {
  try {
    const saved = Number(localStorage.getItem(opts.storageKey));
    if (saved) opts.apply(Math.min(Math.max(saved, opts.min), opts.max()));
  } catch {
    // Default size.
  }
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const start = opts.axis === 'x' ? e.clientX : e.clientY;
    const from = opts.measure();
    handle.classList.add('dragging');
    const move = (m: PointerEvent) => {
      const delta = (opts.axis === 'x' ? m.clientX : m.clientY) - start;
      opts.apply(Math.min(Math.max(from + (opts.invert ? -delta : delta), opts.min), opts.max()));
    };
    const up = () => {
      handle.classList.remove('dragging');
      handle.removeEventListener('pointermove', move);
      try {
        localStorage.setItem(opts.storageKey, String(Math.round(opts.measure())));
      } catch {
        // Not remembered.
      }
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up, { once: true });
  });
}

/** Call `callback` with an element's text whenever it changes (for mirroring a status line). */
export function onTextChange(el: HTMLElement, callback: (text: string) => void) {
  new MutationObserver(() => callback(el.textContent ?? '')).observe(el, { childList: true, characterData: true, subtree: true });
}

/** Wire the sidebar and bottom-panel sashes of a `.workspace` page; sizes are remembered per app. */
export function wireSashes(app: string) {
  const workspace = document.querySelector<HTMLElement>('.workspace')!;
  const sidebar = document.getElementById('sidebar')!;
  const panel = document.getElementById('panel')!;
  resizable(document.getElementById('sidebar-sash')!, {
    axis: 'x', min: 260, max: () => Math.min(640, innerWidth - 420),
    measure: () => sidebar.getBoundingClientRect().width,
    apply: (px) => workspace.style.setProperty('--sidebar-width', `${px}px`),
    storageKey: `probe-web.${app}.sidebar-width`,
  });
  resizable(document.getElementById('panel-sash')!, {
    axis: 'y', invert: true, min: 120, max: () => innerHeight - 220,
    measure: () => panel.getBoundingClientRect().height,
    apply: (px) => panel.style.setProperty('--panel-height', `${px}px`),
    storageKey: `probe-web.${app}.panel-height`,
  });
}

// `data-icon="name"` on a control puts that icon in front of its label.
for (const el of document.querySelectorAll<HTMLElement>('[data-icon]')) {
  el.insertAdjacentHTML('afterbegin', iconMarkup(el.dataset.icon as IconName, 14));
}

// The service worker at the site root, whose scope covers the docs, every app and the
// /assets/ they share. Production only: in front of the dev server it would fight HMR, and
// the browser tests drive the dev server.
//
// Registered from the shell rather than from each app because one registration controls the
// whole origin. The examples deliberately do not pull the shell in, so a visitor who only
// ever opens an example never installs it — which is the right trade for a page whose point
// is to be the minimum.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  const base = import.meta.env.BASE_URL;
  addEventListener('load', () => {
    void navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch((e) => {
      console.warn('[probe-web] service worker registration failed', e);
    });
  });
}
