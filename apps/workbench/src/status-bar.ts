// The status bar, VS Code style: run state on the left (the text is main.ts's #status),
// the target on the right. Presentation only: it mirrors what the toolbar holds.
import { onTextChange } from '../../shared/shell.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

onTextChange($('status'), (text) => {
  const state = text === 'running' ? 'running'
    : text.startsWith('stopped') ? 'stopped'
    : text.endsWith('…') ? 'busy'
    : /fail|error/i.test(text) ? 'err' : '';
  $('status').dataset.state = state;
  document.body.classList.toggle('debugging', state === 'running' || state === 'stopped');
});

function mirror() {
  const transport = $<HTMLSelectElement>('transport');
  $('sb-transport').textContent = transport.selectedOptions[0]?.textContent ?? '';
  $('sb-chip').textContent = $<HTMLInputElement>('chip').value;
  $('sb-elf').textContent = $('elf-name').textContent ?? '';
}
for (const id of ['transport', 'chip']) $(id).addEventListener('input', mirror);
$('transport').addEventListener('change', mirror);
onTextChange($('elf-name'), mirror);
// main.ts restores the settings (storage, query string) after this module has run.
setTimeout(mirror, 0);
