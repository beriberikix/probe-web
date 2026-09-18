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

The elements render in shadow DOM with their own compact styles, so page CSS does not leak
into them. Size them from outside like any block element. The terminal and the plot fill
the space they are given.

## Bundling

The package ships TypeScript source that uses Lit's decorators. Compile it with
`experimentalDecorators: true` and `useDefineForClassFields: false`. The package's own
`tsconfig.json` sets both, and Vite and esbuild pick it up.
