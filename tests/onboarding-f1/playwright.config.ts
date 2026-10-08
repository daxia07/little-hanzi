import { defineConfig } from '@playwright/test';

const output = process.env.HANZI_F1_OUTPUT || 'outputs/qa/onboarding-f1';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: 0,
  forbidOnly: true,
  outputDir: `${output}/artifacts`,
  reporter: [
    ['list'],
    ['json', { outputFile: `${output}/results.json` }],
    ['html', { outputFolder: `${output}/html`, open: 'never' }],
  ],
  use: {
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  projects: [
    {
      name: 'chromium',
      testMatch: '**/*.spec.ts',
      use: {
        browserName: 'chromium',
        viewport: { width: 1280, height: 900 },
      },
    },
    {
      name: 'webkit',
      testMatch: '**/*.spec.ts',
      use: {
        browserName: 'webkit',
        viewport: { width: 820, height: 1180 },
        hasTouch: true,
        isMobile: true,
      },
    },
  ],
});
