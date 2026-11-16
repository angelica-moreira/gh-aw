import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const configDir = dirname(fileURLToPath(import.meta.url));
// Use the system Chromium where it is installed (CI); elsewhere fall back to
// Playwright's bundled browser (`npx playwright install chromium`).
const systemChromium = '/usr/bin/chromium-browser';

const chromiumUse = {
  ...devices['Desktop Chrome'],
  launchOptions: existsSync(systemChromium) ? { executablePath: systemChromium } : {},
};

// Specs that write to and read the system clipboard (see the 'clipboard' project).
const clipboardSpecs = ['copy-button', 'copy-button-layout', 'heading-links', 'homepage-links'].map(
  (name) => `**/${name}.spec.ts`,
);

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './tests',
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 1 : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: 'html',
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: 'http://localhost:4321',
    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium',
      use: chromiumUse,
      testIgnore: clipboardSpecs,
    },
    {
      // The OS clipboard is shared by every browser, so specs that read it run
      // one at a time in their own project.
      name: 'clipboard',
      use: chromiumUse,
      testMatch: clipboardSpecs,
      fullyParallel: false,
      workers: 1,
    },
  ],

  /* Run your local dev server before starting the tests */
  webServer: {
    // Ensure the command always runs relative to the docs folder, regardless
    // of the caller's current working directory.
    cwd: configDir,
    // Search is only available in production builds, so run tests against a
    // built preview server.
    command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 4321',
    url: 'http://localhost:4321/gh-aw/',
    reuseExistingServer: !process.env.CI,
    timeout: 180 * 1000,
  },
});
