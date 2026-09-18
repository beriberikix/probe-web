// The inspector's workspace: sidebar views that summarise their step, the log panel, the
// sashes and the status bar. Presentation only: it follows the statuses main.ts writes.
import { PanelTabs, onTextChange, setViewBadge, wireSashes } from '../../shared/shell.ts';

const $ = (id: string) => document.getElementById(id)!;

new PanelTabs($('panel-tabs'));
wireSashes('inspect');

onTextChange($('conn-status'), (t) => {
  const m = /^connected \((\w+)\)/.exec(t);
  const label = m ? (m[1] === 'webusb' ? 'WebUSB' : 'WebSocket') : t.startsWith('failed') ? 'failed' : t;
  const state = m ? 'ok' : t.startsWith('failed') ? 'err' : t ? 'busy' : '';
  setViewBadge($('view-connection'), label, state);
  $('sb-connection').textContent = m ? `connected · ${label}` : t.startsWith('failed') ? 'connection failed' : 'not connected';
  $('sb-connection').dataset.state = state;
});
onTextChange($('scan-status'), (t) => {
  const state = t.startsWith('done') ? 'ok' : t.startsWith('failed') ? 'err' : t ? 'busy' : '';
  setViewBadge($('view-scan'), t.startsWith('failed') ? 'failed' : t, state);
  $('sb-scan').textContent = t;
});
$('picker').addEventListener('probe-selected', (e) => {
  const name = (e as CustomEvent<{ identifier: string }>).detail.identifier;
  setViewBadge($('view-probe'), name, 'ok');
  $('sb-probe').textContent = name;
});
