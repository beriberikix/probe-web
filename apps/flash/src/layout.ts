// The flasher's workspace: sidebar views that summarise their step, the output panel's
// tabs, resizable sashes and the status bar. Presentation only: it follows the statuses
// and events main.ts already produces and changes nothing about what they do.
import { PanelTabs, onTextChange, setViewBadge, wireSashes } from '../../shared/shell.ts';

const $ = (id: string) => document.getElementById(id)!;
const qs = new URLSearchParams(location.search);

const tabs = new PanelTabs($('panel-tabs'), 'probe-web.flash.panel-tab');
// Automation that drives a panel starts on it.
if (qs.has('serialtest')) tabs.select('panel-serial');
else if (qs.has('monitor')) tabs.select('panel-rtt');

$('rtt').addEventListener('monitor-event', (e) => {
  const kind = (e as CustomEvent<{ kind: string }>).detail.kind;
  tabs.markUnread(kind === 'semihosting' ? 'panel-semi' : 'panel-rtt');
});
$('serial').addEventListener('serial-line', () => tabs.markUnread('panel-serial'));

wireSashes('flash');

type State = 'ok' | 'err' | 'busy' | '';
interface Summary { badge: string; state: State; bar: string }

/** Mirror a status line into its view's badge and a status-bar item. */
function follow(id: string, view: string, bar: string, read: (text: string) => Summary) {
  onTextChange($(id), (text) => {
    const s = read(text);
    setViewBadge($(view), s.badge, s.state);
    $(bar).textContent = s.bar;
    $(bar).dataset.state = s.state;
  });
}

const failed = (t: string) => t.startsWith('failed');

follow('conn-status', 'view-connection', 'sb-connection', (t) => {
  const m = /^connected \((\w+)\)/.exec(t);
  if (m) {
    const label = m[1] === 'webusb' ? 'WebUSB' : 'WebSocket';
    return { badge: label, state: 'ok', bar: `connected · ${label}` };
  }
  if (failed(t)) return { badge: 'failed', state: 'err', bar: 'connection failed' };
  return { badge: t, state: t ? 'busy' : '', bar: t || 'not connected' };
});
follow('attach-status', 'view-target', 'sb-target', (t) => {
  const m = /^attached to (\S+)/.exec(t);
  if (m) return { badge: m[1], state: 'ok', bar: m[1] };
  if (failed(t)) return { badge: 'failed', state: 'err', bar: '' };
  return { badge: t, state: t ? 'busy' : '', bar: '' };
});

$('picker').addEventListener('probe-selected', (e) => {
  const name = (e as CustomEvent<{ identifier: string }>).detail.identifier;
  setViewBadge($('view-probe'), name, 'ok');
  $('sb-probe').textContent = name;
});

const flashStatus = $('sb-flash');
$('flash').addEventListener('flash-done', (e) => {
  flashStatus.textContent = `flashed in ${(e as CustomEvent<{ ms: number }>).detail.ms} ms`;
});
$('flash').addEventListener('flash-failed', () => { flashStatus.textContent = 'flash failed'; });
