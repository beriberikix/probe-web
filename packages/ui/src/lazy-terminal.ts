import { followScheme, terminalFontFamily } from './terminal-theme.ts';

/**
 * xterm.js, fetched the first time an element actually shows a terminal.
 *
 * It is ~70 kB gzipped, and two of this package's elements used to import it at module
 * scope — which, because `index.ts` is a barrel that registers every element, meant a plain
 * `import '@probe-web/ui'` paid for xterm on a page with no terminal on it.
 *
 * The CSS is the reason this needs a class rather than a bare dynamic import: both elements
 * put xterm's stylesheet in `static styles`, which Lit evaluates when the class is defined,
 * so it cannot be deferred in place. Here it becomes one `CSSStyleSheet` adopted into each
 * element's shadow root once the module has arrived.
 */
let loading: Promise<{
  Terminal: typeof import('@xterm/xterm').Terminal;
  FitAddon: typeof import('@xterm/addon-fit').FitAddon;
  sheet: CSSStyleSheet;
}> | null = null;

function loadXterm() {
  // Memoised, so the second element on a page shares the first one's fetch and its sheet.
  loading ??= (async () => {
    const [{ Terminal }, { FitAddon }, { default: styles }] = await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/xterm/css/xterm.css?inline'),
    ]);
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(styles);
    return { Terminal, FitAddon, sheet };
  })();
  return loading;
}

/** Enough writes to fill the scrollback; a terminal that never opens cannot grow without bound. */
const MAX_BUFFERED = 5000;

/**
 * A terminal that can be written to before it exists.
 *
 * Output arriving while xterm is still downloading is held and replayed in order, so a
 * monitor loop or a serial port that starts producing immediately loses nothing.
 */
export class LazyTerminal {
  private term: import('@xterm/xterm').Terminal | null = null;
  private fit: import('@xterm/addon-fit').FitAddon | null = null;
  private buffered: string[] = [];
  private input: ((data: string) => void) | null = null;
  private off: (() => void) | null = null;
  private resize: ResizeObserver | null = null;

  /** Fetch xterm, adopt its stylesheet into `root`, and open a terminal in `host`. */
  async open(root: ShadowRoot, host: HTMLElement): Promise<void> {
    const { Terminal, FitAddon, sheet } = await loadXterm();
    if (this.term) return;
    if (!root.adoptedStyleSheets.includes(sheet)) root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];

    const term = new Terminal({ convertEol: true, fontSize: 12, fontFamily: terminalFontFamily, scrollback: 5000 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    if (this.input) term.onData(this.input);
    this.resize = new ResizeObserver(() => fit.fit());
    this.resize.observe(host);

    this.term = term;
    this.fit = fit;
    this.follow();
    for (const text of this.buffered) term.write(text);
    this.buffered = [];
  }

  write(text: string) {
    if (this.term) this.term.write(text);
    else if (this.buffered.length < MAX_BUFFERED) this.buffered.push(text);
  }

  writeln(text: string) {
    this.write(`${text}\r\n`);
  }

  clear() {
    this.buffered = [];
    this.term?.clear();
  }

  /** Keystrokes from the terminal. Registered now, or when it opens. */
  onData(fn: (data: string) => void) {
    this.input = fn;
    this.term?.onData(fn);
  }

  /** Track the page's light/dark scheme. Safe before the terminal exists, and idempotent. */
  follow() {
    if (this.term && !this.off) this.off = followScheme(this.term);
  }

  unfollow() {
    this.off?.();
    this.off = null;
  }
}
