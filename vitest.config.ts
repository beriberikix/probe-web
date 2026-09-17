import { defineConfig } from 'vitest/config';

// Unit tests live in each package's test/ directory; tests/ holds Playwright specs.
export default defineConfig({
  test: { include: ['packages/*/test/**/*.test.ts'] },
});
