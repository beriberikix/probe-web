import type { SourceProvider } from '@probe-web/client';
import type { MonacoSource } from './monaco-source.ts';

const basename = (p: string) => p.replace(/\\/g, '/').split('/').pop() ?? p;

export interface BreakpointMark {
  line: number;
  verified: boolean;
}

/**
 * The source panel (light DOM: Monaco's CSS is global). Read-only; shows the file of the
 * current frame with the PC line, and breakpoint glyphs. Clicking the glyph margin calls
 * `onToggleBreakpoint(path, line)`.
 *
 * Monaco itself lives in `monaco-source.ts` and is only fetched when there is a file to
 * show. The panel's element exists from the constructor, because dockview mounts it
 * synchronously; everything that arrives before the editor does — breakpoint marks, a PC
 * line — is held here and replayed.
 */
export class SourceView {
  readonly element: HTMLElement;
  private header: HTMLElement;
  private host: HTMLElement;
  private editor: MonacoSource | null = null;
  private loading: Promise<MonacoSource> | null = null;
  private marks: BreakpointMark[] = [];
  private pc: number | null = null;

  onToggleBreakpoint: (path: string, line: number) => void = () => {};
  sources: SourceProvider | null = null;

  /** DWARF path of the file shown. */
  get path(): string | null {
    return this.editor?.path ?? null;
  }

  /** Text of the file shown (the checks assert real source, not a server's 404 page). */
  get text(): string {
    return this.editor?.text ?? '';
  }

  get pcLine(): number | null {
    return this.editor ? this.editor.pcLine : this.pc;
  }

  get title() {
    return this.path ? basename(this.path) : 'Source';
  }

  constructor() {
    this.element = document.createElement('div');
    this.element.className = 'source-panel';
    this.header = document.createElement('div');
    this.header.className = 'source-header';
    this.header.textContent = 'no source (stop the core in code with debug info)';
    this.host = document.createElement('div');
    this.host.className = 'source-editor';
    this.element.append(this.header, this.host);
  }

  private load(): Promise<MonacoSource> {
    this.loading ??= import('./monaco-source.ts').then(({ MonacoSource }) => {
      const editor = new MonacoSource(this.host, this.header, {
        // Read late: `sources` is reassigned on every session.
        sources: () => this.sources,
        onToggleBreakpoint: (path, line) => this.onToggleBreakpoint(path, line),
      });
      this.editor = editor;
      editor.setBreakpoints(this.marks);
      editor.setPc(this.pc);
      return editor;
    });
    return this.loading;
  }

  /** Open `path` (a DWARF path) and optionally mark `pcLine`. Returns false if the source is unavailable. */
  async show(path: string, pcLine: number | null): Promise<boolean> {
    return (await this.load()).show(path, pcLine);
  }

  setPc(line: number | null) {
    this.pc = line;
    this.editor?.setPc(line);
  }

  /** Breakpoint glyphs for the file shown. */
  setBreakpoints(marks: BreakpointMark[]) {
    this.marks = marks;
    this.editor?.setBreakpoints(marks);
  }

  /** Lines with breakpoint glyphs (for tests). */
  breakpointLines(): number[] {
    return this.editor?.breakpointLines() ?? [];
  }
}
