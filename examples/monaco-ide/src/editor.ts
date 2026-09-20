// The Monaco half of the IDE, in its own module so `main.ts` can `import()` it the first
// time there is a file to show. Monaco is ~680 kB gzipped and nothing needs it until the
// target stops somewhere with debug info — which, for a visitor who is only reading the
// page, is never.
import * as monaco from 'monaco-editor/editor';
import 'monaco-editor/languages/definitions/rust/register';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import { currentScheme, onSchemeChange } from '@probe-web/ui/color-scheme';

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = { getWorker: () => new EditorWorker() };

const editorTheme = () => (currentScheme() === 'dark' ? 'vs-dark' : 'vs');

/** What `main.ts` needs from an editor, with no Monaco types in it. */
export interface SourceEditor {
  /** Replace the open document. */
  open(text: string): void;
  /** Highlight the stopped line, or clear it with `null`. */
  setPc(line: number | null): void;
  /** Breakpoint glyphs in the margin. */
  setBreakpoints(lines: number[]): void;
}

export function createEditor(host: HTMLElement, onGutterClick: (line: number) => void): SourceEditor {
  const editor = monaco.editor.create(host, { readOnly: true, glyphMargin: true, automaticLayout: true, minimap: { enabled: false }, model: null, theme: editorTheme() });
  onSchemeChange(() => monaco.editor.setTheme(editorTheme()));
  const bpDecorations = editor.createDecorationsCollection();
  const pcDecoration = editor.createDecorationsCollection();

  editor.onMouseDown((e) => {
    if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) onGutterClick(e.target.position!.lineNumber);
  });

  return {
    open: (text) => editor.setModel(monaco.editor.createModel(text, 'rust')),
    setPc: (line) => {
      pcDecoration.set(line ? [{ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: 'pc' } }] : []);
      if (line) editor.revealLineInCenter(line);
    },
    setBreakpoints: (lines) => {
      bpDecorations.set(lines.map((l) => ({ range: new monaco.Range(l, 1, l, 1), options: { glyphMarginClassName: 'bp' } })));
    },
  };
}
