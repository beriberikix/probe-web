/**
 * React wrappers for the elements this app uses.
 *
 * `@lit/react`'s `createComponent` is the portable way to use a custom element from React: it
 * sets object properties as properties (not stringified attributes) and turns DOM events into
 * `onSomething` props. It works the same on React 18 and 19, so an app that uses it does not
 * have to care which one it is on.
 *
 * Importing the element module is what registers the custom element, and it also gives us the
 * class `createComponent` needs to know which properties the element has.
 */
import * as React from 'react';
import { createComponent, type EventName } from '@lit/react';
import { ProbeDevicePicker } from '@probe-web/ui/device-picker';
import { ProbeFlashPanel } from '@probe-web/ui/flash-panel';
import { ProbeRttTerminal } from '@probe-web/ui/rtt-terminal';
import type { Wire } from '@probe-web/client';

/**
 * `@lit/react` 1.0.8's types still require `React.createFactory`, which `@types/react` 19
 * removed, so `react: React` does not type-check on React 19. Nothing calls it at runtime —
 * this cast is the whole workaround. See lit/lit#4762.
 */
const react = React as unknown as Parameters<typeof createComponent>[0]['react'];

export const DevicePicker = createComponent({
  tagName: 'probe-device-picker',
  elementClass: ProbeDevicePicker,
  react: react,
  events: {
    // The name on the left is the React prop; the string is the DOM event.
    onProbeSelected: 'probe-selected' as EventName<CustomEvent<Wire.DebugProbeEntry>>,
    onDeviceAuthorized: 'device-authorized',
  },
});

export const FlashPanel = createComponent({
  tagName: 'probe-flash-panel',
  elementClass: ProbeFlashPanel,
  react: react,
  events: {
    onFlashDone: 'flash-done' as EventName<CustomEvent<{ bootInfo: Wire.BootInfo; ms: number }>>,
    onFlashFailed: 'flash-failed' as EventName<CustomEvent<unknown>>,
  },
});

export const RttTerminal = createComponent({
  tagName: 'probe-rtt-terminal',
  elementClass: ProbeRttTerminal,
  react: react,
  events: { onMonitorExit: 'monitor-exit' },
});

