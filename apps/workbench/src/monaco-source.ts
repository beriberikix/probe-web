// Everything that touches Monaco, in one module so that `source-view.ts` can `import()` it
// on demand. Monaco is ~1 MB gzipped — the largest single thing the workbench downloads —
// and a visitor who never stops the core in code with debug info never needs it.
//
// The module-scope work here (the worker environment, the two themes, the scheme
// subscription) has to stay in the same module as the `import * as monaco`, so that it runs
// before the first `editor.create` no matter when the module is pulled in.
import * as monaco from 'monaco-editor/editor';
import 'monaco-editor/features/register.all';
import 'monaco-editor/languages/definitions/rust/register';
import 'monaco-editor/languages/definitions/cpp/register';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import type { SourceProvider } from '@probe-web/client';
import { currentScheme, onSchemeChange, type ColorScheme } from '@probe-web/ui/color-scheme';
import type { BreakpointMark } from './source-view.ts';

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = { getWorker: () => new EditorWorker() };

// Editor themes on the page's colours (VitePress's), for light and dark.
monaco.editor.defineTheme('probe-light', {
  base: 'vs', inherit: true, rules: [],
  colors: {
    'editor.background': '#ffffff',
    'editorGutter.background': '#ffffff',
    'editor.lineHighlightBackground': '#f6f6f7',
    'editor.lineHighlightBorder': '#00000000',
    'editorLineNumber.foreground': '#929295',
    'editorLineNumber.activeForeground': '#3c3c43',
    'editor.selectionBackground': '#646cff33',
    'editor.inactiveSelectionBackground': '#646cff1f',
    'editorWidget.background': '#f6f6f7',
    'editorWidget.border': '#e2e2e3',
    'scrollbarSlider.background': '#8e96aa33',
  },
});
monaco.editor.defineTheme('probe-dark', {
  base: 'vs-dark', inherit: true, rules: [],
  colors: {
    'editor.background': '#1b1b1f',
    'editorGutter.background': '#1b1b1f',
    'editor.lineHighlightBackground': '#202127',
    'editor.lineHighlightBorder': '#00000000',
    'editorLineNumber.foreground': '#6a6a71',
    'editorLineNumber.activeForeground': '#dfdfd6',
    'editor.selectionBackground': '#646cff40',
    'editor.inactiveSelectionBackground': '#646cff26',
    'editorWidget.background': '#202127',
    'editorWidget.border': '#2e2e32',
    'scrollbarSlider.background': '#65758533',
  },
});
const editorTheme = (scheme: ColorScheme) => (scheme === 'dark' ? 'probe-dark' : 'probe-light');
onSchemeChange((scheme) => monaco.editor.setTheme(editorTheme(scheme)));

const language = (path: string) => (/\.rs$/.test(path) ? 'rust' : /\.(c|h|cc|cpp|hpp)$/.test(path) ? 'cpp' : 'plaintext');

export interface MonacoSourceHost {
  /** Where the source text comes from; read late, because the panel outlives any one session. */
  sources(): SourceProvider | null;
  onToggleBreakpoint(path: string, line: number): void;
}

/** The editor half of {@link SourceView}: read-only Monaco with a PC line and breakpoint glyphs. */
export class MonacoSource {
  private editor: monaco.editor.IStandaloneCodeEditor;
  private breakpoints: monaco.editor.IEditorDecorationsCollection;
  private pc: monaco.editor.IEditorDecorationsCollection;
  private models = new Map<string, monaco.editor.ITextModel>();
  path: string | null = null;
  pcLine: number | null = null;

  get text(): string {
    return this.editor.getModel()?.getValue() ?? '';
  }

  constructor(host: HTMLElement, private header: HTMLElement, private owner: MonacoSourceHost) {
    this.editor = monaco.editor.create(host, {
      readOnly: true,
      glyphMargin: true,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      fontFamily: "ui-monospace, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
      theme: editorTheme(currentScheme()),
      scrollBeyondLastLine: false,
      model: null,
    });
    this.breakpoints = this.editor.createDecorationsCollection();
    this.pc = this.editor.createDecorationsCollection();
    this.editor.onMouseDown((e) => {
      if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && this.path && e.target.position) {
        this.owner.onToggleBreakpoint(this.path, e.target.position.lineNumber);
      }
    });
  }

  async show(path: string, pcLine: number | null): Promise<boolean> {
    let model = this.models.get(path);
    if (!model) {
      const sources = this.owner.sources();
      const text = sources ? await sources.read(path) : null;
      if (text === null) {
        this.header.textContent = `${path} (source not available — pick the project folder)`;
        return false;
      }
      model = monaco.editor.createModel(text, language(path), monaco.Uri.parse(`probe-source:${encodeURI(path)}`));
      this.models.set(path, model);
    }
    if (this.editor.getModel() !== model) this.editor.setModel(model);
    this.path = path;
    this.header.textContent = path;
    this.header.title = path;
    this.setPc(pcLine);
    return true;
  }

  setPc(line: number | null) {
    this.pcLine = line;
    if (line === null) {
      this.pc.clear();
      return;
    }
    this.pc.set([{
      range: new monaco.Range(line, 1, line, 1),
      options: { isWholeLine: true, className: 'pc-line', glyphMarginClassName: 'pc-arrow', glyphMargin: { position: monaco.editor.GlyphMarginLane.Right } },
    }]);
    this.editor.revealLineInCenterIfOutsideViewport(line);
  }

  setBreakpoints(marks: BreakpointMark[]) {
    this.breakpoints.set(marks.map((m) => ({
      range: new monaco.Range(m.line, 1, m.line, 1),
      options: {
        glyphMarginClassName: m.verified ? 'bp-verified' : 'bp-unverified',
        glyphMarginHoverMessage: { value: m.verified ? 'Breakpoint' : 'Breakpoint (not set)' },
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        glyphMargin: { position: monaco.editor.GlyphMarginLane.Left },
      },
    })));
  }

  breakpointLines(): number[] {
    return this.breakpoints.getRanges().map((r) => r.startLineNumber);
  }
}
