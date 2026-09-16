import { defineConfig } from '@playwright/test';

// Hardware-free browser tests: the flasher app with the fake-probe worker.
export default defineConfig({
  testDir: 'tests',
  timeout: 60_000,
  use: { baseURL: 'http://127.0.0.1:5173', headless: true },
  webServer: {
    command: 'npx vite --port 5173 --strictPort --host 127.0.0.1',
    cwd: 'apps/flash',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
