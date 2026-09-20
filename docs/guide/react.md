# Using with React

The elements are custom elements, so React can render them — but two things need care: the
properties are JavaScript objects rather than strings, and the events are `CustomEvent`s that
React does not wire up for you. This page covers both, plus the build settings.

Everything here is taken from [`examples/react-flash`](https://github.com/beriberikix/probe-web/tree/main/examples/react-flash),
which is built in CI, so the snippets stay honest.

```sh
npm install @probe-web/client @probe-web/devices @probe-web/ui @lit/react
```

## Wrappers, with `@lit/react`

[`createComponent`](https://lit.dev/docs/frameworks/react/) turns an element into a React
component that sets object properties as *properties* and maps DOM events to `onSomething`
props. It behaves the same on React 18 and 19, so this is the option that does not depend on
which React you are on:

```ts
// elements.ts
import * as React from 'react';
import { createComponent, type EventName } from '@lit/react';
import { ProbeDevicePicker } from '@probe-web/ui/device-picker';
import { ProbeFlashPanel } from '@probe-web/ui/flash-panel';
import type { Wire } from '@probe-web/client';

export const DevicePicker = createComponent({
  tagName: 'probe-device-picker',
  elementClass: ProbeDevicePicker,
  react: React,
  events: {
    onProbeSelected: 'probe-selected' as EventName<CustomEvent<Wire.DebugProbeEntry>>,
  },
});

export const FlashPanel = createComponent({
  tagName: 'probe-flash-panel',
  elementClass: ProbeFlashPanel,
  react: React,
  events: {
    onFlashDone: 'flash-done' as EventName<CustomEvent<{ bootInfo: Wire.BootInfo; ms: number }>>,
  },
});
```

Importing the element module is what **registers** the custom element, and it also gives
`createComponent` the class, which is where the property types come from. Casting the event
name to `EventName<CustomEvent<T>>` is what gives the handler a typed `detail` — without it
the prop is typed as a plain `Event`.

Then it is ordinary React:

```tsx
const [probe, setProbe] = useState<Wire.DebugProbeEntry | null>(null);
const [bootInfo, setBootInfo] = useState<Wire.BootInfo | null>(null);

<DevicePicker client={client} onProbeSelected={(e) => setProbe(e.detail)} />
<FlashPanel session={session} onFlashDone={(e) => setBootInfo(e.detail.bootInfo)} />
<RttTerminal session={session} bootInfo={bootInfo} />
```

::: warning `@lit/react` and React 19 types
`@lit/react` 1.0.8 still declares `React.createFactory`, which `@types/react` 19 removed, so
`react: React` does not type-check against React 19. Nothing calls it at runtime; one cast
gets past it:

```ts
const react = React as unknown as Parameters<typeof createComponent>[0]['react'];
```
:::

## Without the dependency

**React 19** passes unknown props to a custom element as properties, so objects work
directly. Events still do not: attach those yourself with a ref.

```tsx
const ref = useRef<ProbeFlashPanel>(null);
useEffect(() => {
  const el = ref.current;
  if (!el) return;
  const onDone = (e: Event) => setBootInfo((e as CustomEvent).detail.bootInfo);
  el.addEventListener('flash-done', onDone);
  return () => el.removeEventListener('flash-done', onDone);
}, []);

<probe-flash-panel ref={ref} session={session} />
```

For TypeScript to accept `<probe-flash-panel>` in JSX, declare it:

```ts
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'probe-flash-panel': React.DetailedHTMLProps<
        React.HTMLAttributes<ProbeFlashPanel> & { session?: Session | null },
        ProbeFlashPanel
      >;
    }
  }
}
```

**React 18 and earlier** stringifies anything it does not recognise, so `session={session}`
would set the string `[object Object]`. Set the property through a ref instead:

```tsx
useEffect(() => { if (ref.current) ref.current.session = session; }, [session]);
```

This is the case `createComponent` exists to remove, which is why the example uses it.

## Theming

Import the theme once, at your entry point, and toggle dark mode with the `dark` class on
`<html>` — see [Styling](./components#styling) for the tokens:

```ts
import '@probe-web/ui/theme.css';
```

## Build settings

`@probe-web/client` addresses its Worker and wasm with `new URL(..., import.meta.url)`,
which does not survive dependency pre-bundling. That is the only thing a Vite React app has
to account for:

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  optimizeDeps: { exclude: ['@probe-web/client'] },
  worker: { format: 'es' },
});
```

Your `tsconfig.json` wants `"jsx": "react-jsx"` alongside the options in
[Getting started](./getting-started).
