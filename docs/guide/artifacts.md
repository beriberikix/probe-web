# Firmware files

`@probe-web/artifacts` handles the files a flashing page works with: picking them,
remembering them across reloads, watching them for rebuilds, and handing files such as
coredumps back to the user.

## Pick, remember and watch

With the [File System Access API](https://developer.mozilla.org/docs/Web/API/File_System_API),
a page can keep a handle to the ELF your build writes and notice when it changes. That
gives an edit, build and flash loop with no file dialog after the first one:

```ts
import { pickFile, rememberHandle, hasFileSystemAccess } from '@probe-web/artifacts';

if (hasFileSystemAccess()) {
  button.onclick = async () => {
    const artifact = await pickFile({ extensions: ['.elf'] }); // needs a user gesture
    await rememberHandle('firmware', artifact.handle);         // survives reloads
    await session.flash({ image: await artifact.bytes(), name: artifact.name, format: 'elf' });

    // Fires after each rebuild, once the file has stopped changing.
    artifact.watch(async (change) => {
      await session.flash({ image: change.bytes, name: change.name, format: 'elf' });
    });
  };
}
```

Watching polls the file every 500 ms by default, because the API has no change events. A
change is reported after the file has stayed the same for a moment, so a half-written ELF
is never flashed.

`<probe-flash-panel>` offers this as *Pick file & watch…* with *re-flash on change*. It
fires `artifact-changed` before each automatic re-flash.

## After a reload

A remembered handle comes back with `recallHandle(key)`. The browser may require read
permission again, and asking needs a user gesture:

```ts
import { recallHandle } from '@probe-web/artifacts';

const artifact = await recallHandle('firmware');
if (artifact && !(await artifact.hasPermission())) {
  resumeButton.onclick = () => artifact.ensurePermission(); // prompts once
}
```

`restoreHandles` restores several remembered handles at once. It checks silently on load,
and prompts only when called from a click with `request: true`.

## Other sources

`fromFile(file)` wraps a dropped or `<input type=file>` file, and `fromUrl(url)` a URL.
Both have the same `bytes()` interface as a picked file and work in every browser.

## Saving files

```ts
import { downloadBytes } from '@probe-web/artifacts';

const dump = await session.core(0).dumpCoreFile([[0x2000_0000, 0x2000_8000]]);
downloadBytes('firmware.coredump', dump);
```
