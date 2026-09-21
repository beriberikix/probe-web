import { chromium, type FullConfig } from '@playwright/test';

/**
 * Load the flasher once before the suite.
 *
 * Vite transforms on demand, and the first page to ask for the app pays for all of it — the
 * components, Monaco, and the 10 MB fake-probe worker. Whichever spec goes first wears that
 * cost while the others run beside it: on CI the target-picker test took three minutes on its
 * first attempt and 1.6 seconds on the retry. Warming once here keeps a spec's own timeout
 * about the spec.
 */
export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL ?? 'http://127.0.0.1:5173';
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();

    // The flasher, including a fake flash, which pulls in the client and the worker.
    await page.goto(`${baseURL}/?auto=1&transport=webusb&fake=1`, { timeout: 180_000 });
    await page.waitForFunction(
      () => document.querySelector('#log')?.textContent?.includes('AUTORUN_DONE') ?? false,
      undefined,
      { timeout: 180_000 },
    );

    // Each other app has dependencies of its own — dockview in the workbench, React in the
    // example. Vite optimises those on first request and reloads the page when it does, which
    // looks like a test flake if it happens mid-spec.
    //
    // Monaco is no longer among them: it is behind a dynamic import, so idle network here
    // proves only that Vite served what the page *asked* for, and the first spec to open a
    // source file still pays its transform. Driving the workbench to a stop from here would
    // close that gap, but every version of it was more fragile than the rare flake it fixes,
    // and CI retries once. Left as a known gap rather than a brittle warmup.
    for (const path of ['/workbench/?fake=1', '/inspect/', '/monaco-ide/']) {
      await page.goto(`${baseURL}${path}`, { timeout: 180_000 });
      // Idle network means Vite has served every module this page asks for, which is the
      // point — no assumptions about what the app renders.
      await page.waitForLoadState('networkidle', { timeout: 180_000 });
    }
  } finally {
    await browser.close();
  }
}
