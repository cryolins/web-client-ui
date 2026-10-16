import type { PlaywrightTestConfig } from '@playwright/test';
import CIConfig from './playwright-ci.config';

process.env.E2E_CUSTOM_COLUMN_DIAGNOSTICS = '1';

const config: PlaywrightTestConfig = {
  ...CIConfig,
  // Repeat companion tests too: a single selected test cannot reproduce CI load.
  // Worker allocation stays identical to CI; full-suite load is not guaranteed.
  testMatch: 'table-operations.spec.ts',
  repeatEach: 10,
  outputDir: 'test-results/custom-column-diagnostics',
  reporter: [
    ['line'],
    ['html', { outputFolder: 'diagnostic-report', open: 'never' }],
  ],
  use: {
    ...CIConfig.use,
    // Keep failed first attempts even when their retries succeed.
    video: 'retain-on-failure',
  },
};

export default config;
