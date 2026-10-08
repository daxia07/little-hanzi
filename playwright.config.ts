import { defineConfig } from '@playwright/test';

const output = process.env.HANZI_QA_OUTPUT || 'outputs/qa/unconfigured';
const pilotBrowser = process.env.HANZI_PILOT_BROWSER === '1';
export default defineConfig({
  testDir: './tests',
  timeout: 45_000,
  expect: { timeout: 8_000 },
  workers: 1,
  retries: 0,
  forbidOnly: true,
  outputDir: `${output}/artifacts`,
  reporter: pilotBrowser
    ? [['list'], ['json', { outputFile: `${output}/results.json` }]]
    : [
        ['list'],
        ['json', { outputFile: `${output}/results.json` }],
        ['html', { outputFolder: `${output}/html`, open: 'never' }],
      ],
  use: {
    baseURL: process.env.HANZI_BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'integration', testMatch: 'integration/**/*.spec.ts' },
    {
      name: 'chromium',
      testMatch: 'e2e/**/*.spec.ts',
      use: { browserName: 'chromium', viewport: { width: 1280, height: 900 } },
    },
    {
      name: 'webkit',
      testMatch: 'e2e/**/*.spec.ts',
      use: {
        browserName: 'webkit',
        viewport: { width: 820, height: 1180 },
        hasTouch: true,
        isMobile: true,
      },
    },
    {
      name: 'pilot-chromium',
      testMatch: 'pilot-e2e/**/*.spec.ts',
      use: {
        browserName: 'chromium',
        viewport: { width: 1280, height: 900 },
        trace: 'off',
        video: 'off',
        screenshot: 'off',
      },
    },
    {
      name: 'pilot-webkit',
      testMatch: 'pilot-e2e/**/*.spec.ts',
      use: {
        browserName: 'webkit',
        viewport: { width: 820, height: 1180 },
        hasTouch: true,
        isMobile: true,
        trace: 'off',
        video: 'off',
        screenshot: 'off',
      },
    },
  ],
});
