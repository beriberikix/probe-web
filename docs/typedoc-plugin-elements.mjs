// @ts-check
// TypeDoc plugin for the custom elements in @probe-web/ui:
//
// - Merges an element's `@fires` tags into one "Fires" section with a bullet per event.
//   The markdown theme would otherwise give every tag its own heading.
// - Drops Lit's lifecycle methods (render, updated, connectedCallback, …). The elements
//   override them, but they are Lit's contract with the element, not API for its users.
import { CommentTag, Converter, ReflectionKind } from 'typedoc';

const LIFECYCLE = new Set([
  'connectedCallback',
  'disconnectedCallback',
  'attributeChangedCallback',
  'render',
  'firstUpdated',
  'updated',
  'willUpdate',
  'shouldUpdate',
  'createRenderRoot',
]);

/** @param {import('typedoc').Application} app */
export function load(app) {
  app.converter.on(Converter.EVENT_RESOLVE_BEGIN, (context) => {
    const project = context.project;
    for (const cls of project.getReflectionsByKind(ReflectionKind.Class)) {
      for (const child of [...(/** @type {import('typedoc').DeclarationReflection} */ (cls).children ?? [])]) {
        if (child.kindOf(ReflectionKind.Method) && LIFECYCLE.has(child.name)) project.removeReflection(child);
      }
      const comment = cls.comment;
      const fires = comment?.blockTags.filter((t) => t.tag === '@fires') ?? [];
      if (!comment || fires.length === 0) continue;
      /** @type {import('typedoc').CommentDisplayPart[]} */
      const content = [];
      for (const tag of fires) {
        // "name - description" → "- `name`: description"
        const [first, ...rest] = tag.content;
        const text = first?.kind === 'text' ? first.text : '';
        const match = /^\s*([\w-]+)\s*-?\s*/.exec(text);
        content.push({ kind: 'text', text: content.length ? '\n- ' : '- ' });
        if (match) {
          content.push({ kind: 'code', text: '`' + match[1] + '`' }, { kind: 'text', text: ': ' + text.slice(match[0].length) });
        } else if (first) {
          content.push(first);
        }
        content.push(...rest);
      }
      const at = comment.blockTags.indexOf(fires[0]);
      comment.blockTags = comment.blockTags.filter((t) => t.tag !== '@fires');
      comment.blockTags.splice(at, 0, new CommentTag('@fires', content));
    }
  });
}
