import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { followScheme, terminalFontFamily } from '@probe-web/ui/terminal-theme';

/** The debug console: DAP `output` events and workbench messages, in xterm.js. */
export class ConsoleView {
  readonly element: HTMLElement;
  private term: Terminal;
  private fit = new FitAddon();
  private frame = 0;
  readonly lines: string[] = [];

  constructor() {
    this.element = document.createElement('div');
    this.element.className = 'console-panel';
    this.term = new Terminal({ convertEol: true, fontSize: 12, fontFamily: terminalFontFamily, scrollback: 5000 });
    followScheme(this.term);
    this.term.loadAddon(this.fit);
    this.term.open(this.element);
    new ResizeObserver(() => {
      cancelAnimationFrame(this.frame);
      this.frame = requestAnimationFrame(() => {
        if (this.element.clientWidth > 0 && this.element.clientHeight > 0) this.fit.fit();
      });
    }).observe(this.element);
  }

  write(text: string, color?: 'gray' | 'red' | 'green' | 'cyan') {
    const codes = { gray: '90', red: '31', green: '32', cyan: '36' };
    for (const line of text.replace(/\n$/, '').split('\n')) this.lines.push(line);
    this.term.write(color ? `\x1b[${codes[color]}m${text}\x1b[0m` : text);
  }

  writeln(text: string, color?: 'gray' | 'red' | 'green' | 'cyan') {
    this.write(text + '\n', color);
  }
}
