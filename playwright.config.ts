import { defineConfig } from '@playwright/test';

// Hardware-free browser tests: the flasher app with the fake-probe worker.
const ci = !!process.env.CI;

export default defineConfig({
  testDir: 'tests',
  testIgnore: ['global-setup.ts'],
  // Pay Vite's on-demand transform once, before any spec's clock starts.
  globalSetup: './tests/global-setup.ts',
  timeout: 60_000,
  // On CI a failure is all we get to work with, so keep a trace and an HTML report (the
  // workflow uploads playwright-report/ when the job fails). One retry tells flaky from broken.
  retries: ci ? 1 : 0,
  reporter: ci ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npx vite --port 5173 --strictPort --host 127.0.0.1',
    cwd: 'apps/flash',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
