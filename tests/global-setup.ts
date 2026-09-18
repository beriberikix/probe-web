import { chromium, type FullConfig } from '@playwright/test';

/**
 * Load the flasher once before the suite.
 *
 * Vite transforms on demand, and the first page to ask for the app pays for all of it — the
 * components, Monaco, and the 12.6 MB fake-probe worker. Whichever spec goes first wears that
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

    // Each other app has dependencies of its own — dockview and Monaco in the workbench and the
    // IDE example. Vite optimises those on first request and reloads the page when it does,
    // which looks like a test flake if it happens mid-spec.
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
