# @probe-web/artifacts

Firmware images as inputs. Pick a file once with the File System Access API,
remember its handle in IndexedDB so it survives reloads, and watch it so a
rebuild re-flashes without another file dialog. Drag-dropped files
(`fromFile`) and URLs (`fromUrl`) share the same `ArtifactSource` shape, and
`downloadBytes()` hands a file (a coredump, a memory dump) back to the user.

```ts
import { pickFile, rememberHandle } from '@probe-web/artifacts';

button.onclick = async () => {
  const artifact = await pickFile({ extensions: ['.elf'] }); // must run in a user gesture
  await rememberHandle('app', artifact.handle); // recallHandle('app') after a reload
  await flash(await artifact.bytes());
  // Polls the file; fires after each rebuild, once the file has stopped changing.
  const stop = artifact.watch((change) => void flash(change.bytes));
};
```

- The picker and handle persistence need the File System Access API
  (Chromium-based desktop browsers); check `hasFileSystemAccess()` first.
  `fromFile`, `fromUrl` and `downloadBytes` work anywhere.
- `pickFile()` and permission requests need a user gesture. After a reload, a
  recalled handle may need read permission again: `restoreHandles()` checks
  without prompting on load, and asks with `request: true` from a click.
- Watching polls (default every 500 ms); the API has no change events.

API reference: https://beriberikix.github.io/probe-web/api/artifacts/
