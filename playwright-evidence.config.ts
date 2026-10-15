import type { PlaywrightTestConfig } from '@playwright/test';
import DefaultConfig from './playwright.config';

const config: PlaywrightTestConfig = {
  ...DefaultConfig,
  testMatch: 'application-errors.spec.ts',
  globalSetup: undefined,
  reporter: [['line']],
  use: { ...DefaultConfig.use, video: 'retain-on-failure' },
};

export default config;
