# React example

The web components in a React app: grant a probe, pick it, attach, flash, and watch RTT.

```sh
npm run dev -w @probe-web/example-react-flash
```

The guide it belongs to is [Using with React](https://beriberikix.github.io/probe-web/guide/react).

What it shows, and where:

| | |
|---|---|
| [`src/elements.ts`](src/elements.ts) | Typed React wrappers for the three elements, with `@lit/react`'s `createComponent`. Object properties go through as properties, and DOM events arrive as `onSomething` props. |
| [`src/App.tsx`](src/App.tsx) | The flow: connect → pick a probe → attach → flash → RTT. `client`, `session` and `bootInfo` are plain objects passed as props. |
| [`src/main.tsx`](src/main.tsx) | Importing `@probe-web/ui/theme.css` once, at the entry. |
| [`vite.config.ts`](vite.config.ts) | What a React app needs to compile `@probe-web/ui`: decorators on, and no pre-bundling of `@probe-web/client`. |

`createComponent` works the same on React 18 and 19, so the app does not have to care which
it is on. One wrinkle: `@lit/react` 1.0.8's types still require `React.createFactory`, which
`@types/react` 19 removed, so `src/elements.ts` casts `React` once to get past it. Nothing
calls `createFactory` at runtime.
