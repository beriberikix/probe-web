# Web components

`@probe-web/ui` is a set of custom elements built with [Lit](https://lit.dev). They are
framework-agnostic: use them from plain HTML, React, Vue, Svelte or anything else that
renders DOM. Each element takes a `client`, `session` or `debugger` property, works on its
own, and reports what happens as DOM events.

```ts
import '@probe-web/ui';                 // registers every element
import '@probe-web/ui/flash-panel';     // or just the ones you use
```

## A flasher in a few lines

```html
<probe-device-picker></probe-device-picker>
<probe-flash-panel></probe-flash-panel>
<probe-rtt-terminal></probe-rtt-terminal>
<probe-semihosting-console></probe-semihosting-console>
```

```ts
import '@probe-web/ui';
import { Client, type Wire } from '@probe-web/client';

const $ = (s: string) => document.querySelector(s) as any;
const client = await Client.connect({ kind: 'webusb' });
$('probe-device-picker').client = client;
$('probe-semihosting-console').source = $('probe-rtt-terminal');

$('probe-device-picker').addEventListener('probe-selected', async (e: CustomEvent<Wire.DebugProbeEntry>) => {
  const session = await client.attach({ probe: e.detail, chip: 'MCXA153', protocol: 'Swd' });
  $('probe-flash-panel').session = session;
  $('probe-rtt-terminal').session = session;
});

$('probe-flash-panel').addEventListener('flash-done', (e: CustomEvent) => {
  $('probe-rtt-terminal').bootInfo = e.detail.bootInfo;
  $('probe-rtt-terminal').start();      // run the new image and stream its output
});
```

The [flasher](/flash/){target="_self"} is this, plus a target picker, manifests and a
serial monitor. Its source is `apps/flash/src/main.ts`.

## Elements

### Flashing and output

| Element | Takes | Events |
|---|---|---|
| `<probe-device-picker>` | `client` | `probe-selected` (`Wire.DebugProbeEntry`), `device-authorized` |
| `<probe-target-picker>` | `client`, `value` | `chip-selected` (name), `family-imported`, `svds-found` |
| `<probe-flash-panel>` | `session`, `job`; attributes `verify`, `chip-erase`, `keep-unwritten` | `flash-done` (`{ bootInfo, ms }`), `flash-failed`, `verify-done`, `erase-done`, `artifact-changed` |
| `<probe-rtt-terminal>` | `session`, `bootInfo`, `elf`, `defmtElf`; `start()`, `stop()` | `monitor-event`, `monitor-exit` |
| `<probe-semihosting-console>` | `source`: an element firing `monitor-event` | none |
| `<probe-rtt-plot>` | `debugger`; attributes `channel`, `format`, `window` | `channel-changed` |
| `<probe-test-runner>` | `session`, `bootInfo`; `list()`, `runAll()` | `tests-finished` (`{ total, passed, failed, ignored }`) |
| `<probe-serial-monitor>` | `port`; attributes `baudrate`, `line-ending` | `serial-line`, `serial-state` |

### Debugging

Each of these takes a `debugger` from `session.debugger()` and follows its events. Share
one debugger between them.

| Element | Shows | Events |
|---|---|---|
| `<probe-core-controls>` | Continue, pause, step, reset, vector catch, and the core's state | `debug-error` |
| `<probe-callstack>` | The stack at the current stop | `frame-selected` (`Frame`) |
| `<probe-variables>` | Scopes, variables and watches for a `frame`; editable | none |
| `<probe-registers>` | Core registers, with changes highlighted; editable when halted | none |
| `<probe-breakpoints>` | Source and address breakpoints | none |
| `<probe-disassembly>` | Instructions around the PC; the gutter toggles breakpoints | none |
| `<probe-memory-view>` | Hex and ASCII memory, grouping, editing, Intel HEX export | none |
| `<probe-peripherals>` | CMSIS-SVD peripherals, registers and fields, read live | none |

```ts
const dbg = session.debugger();
for (const el of document.querySelectorAll('probe-core-controls, probe-callstack, probe-variables, probe-registers'))
  (el as any).debugger = dbg;
document.querySelector('probe-callstack')!.addEventListener('frame-selected', (e) => {
  (document.querySelector('probe-variables') as any).frame = (e as CustomEvent).detail;
});
dbg.start();
```

The [workbench](/workbench/){target="_self"} puts all of them in dockable panels with a
Monaco source view. Its source is `apps/workbench/src/main.ts`.

`DebuggerElement` is the base class several panels share. Extend it to build your own
panel that follows a debugger's `stopped`, `continued` and `breakpoints` events.

## Events

Events bubble and cross shadow roots (`composed`), so you can listen on a container.

The [API reference](/api/ui/) lists every element's properties, methods and events.

## Styling

The elements render in shadow DOM, so page CSS does not leak into them. Size them from
outside like any block element.

They share one look with these docs, VitePress's default theme, and read it from CSS custom
properties. Import the theme to get the same tokens on your page:

```ts
import '@probe-web/ui/theme.css';
```

It defines the tokens and styles plain `button`, `input` and `select` to match. The
elements also render without it, using the light values as fallbacks. Set any token to
recolour every element:

| Token | What it colours |
|---|---|
| `--pw-c-bg`, `--pw-c-bg-alt`, `--pw-c-bg-soft` | backgrounds: panels, sidebars and cards |
| `--pw-c-text-1`, `--pw-c-text-2`, `--pw-c-text-3` | text, muted text and hints |
| `--pw-c-divider`, `--pw-c-border` | lines between rows and around inputs |
| `--pw-c-brand-1`…`3`, `--pw-c-brand-soft` | primary buttons, selection and focus |
| `--pw-c-green-*`, `--pw-c-yellow-*`, `--pw-c-red-*` | success, changed values and the PC, errors and breakpoints |
| `--pw-font-family-base`, `--pw-font-family-mono` | type |
| `--pw-radius`, `--pw-radius-lg`, `--pw-control-height` | shape and density |

For dark mode, add the `dark` class to `<html>`, as VitePress does. The terminals, the plot
and the workbench's editor follow the class as it changes. For your own xterm.js or canvas
code, `onSchemeChange` and `terminalTheme` do the same job.

`<probe-rtt-terminal>` and `<probe-serial-monitor>` are 320 and 260 pixels tall by default.
To make one fill its container, give the element a height and set `--pw-terminal-height: 0`.

## Using with React

The elements work in React, but object properties and custom events need a little wiring.
[Using with React](./react) covers it, with a complete example.

## Bundling

`@probe-web/ui` ships compiled JavaScript with type declarations, so nothing in your
toolchain has to know how to compile it — no decorator settings, no bundler-specific
options. It works on any bundler that reads `exports`.

The elements are registered as a side effect of importing them, and `@probe-web/ui` is a
barrel that imports all of them. Import the subpath you need instead, and you ship only
that element:

```ts
import '@probe-web/ui/flash-panel';     // just this one
import '@probe-web/ui';                 // all of them
```

xterm.js is loaded on demand, the first time `<probe-rtt-terminal>` or
`<probe-serial-monitor>` renders, so a page that never shows a terminal never downloads it.

**The elements load no wasm.** They use `@probe-web/client` for its types, and the one
runtime helper they need — the `_SEGGER_RTT` lookup behind `<probe-rtt-terminal>` — comes
from `@probe-web/client/elf`, which is plain JavaScript. So a page that uses the components
without connecting a probe never fetches the SDK's wasm module or the probe-rs worker, and a
bundler never puts them in its output. `<probe-target-picker>` is the one exception: importing
a CMSIS pack needs wasm, and it is loaded when a pack is actually picked.

`@probe-web/client` still needs one Vite setting, because it addresses its Worker and wasm
with `new URL(..., import.meta.url)`; see
[Getting started](./getting-started#use-the-sdk-in-your-own-page).
