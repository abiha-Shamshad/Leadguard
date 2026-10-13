// TASK-013: end-to-end at phone (360 px) and desktop (1280 px) widths against a local stack
// (`pnpm dev:stack` + `pnpm dev:web`). Uses the installed Google Chrome (PW_CHANNEL=chrome by default);
// set PW_CHANNEL= (empty) and run `npx playwright install chromium` to use the bundled browser instead.
import { defineConfig, devices } from '@playwright/test';

// Unset = installed Google Chrome; empty string = Playwright's bundled Chromium (CI).
const channel = process.env.PW_CHANNEL === undefined ? 'chrome' : process.env.PW_CHANNEL || undefined;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  use: {
    baseURL: process.env.WEB_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    channel: channel,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel: channel, viewport: { width: 1280, height: 800 } } },
    { name: 'phone', use: { ...devices['Pixel 5'], channel: channel, viewport: { width: 360, height: 740 } } },
  ],
});
