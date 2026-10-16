import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  collectApplicationErrors,
  test as applicationTest,
} from './application-errors';

if (process.env.E2E_ERROR_CONTRACT != null) {
  applicationTest('fail-fast contract', async ({ page }, testInfo) => {
    if (
      process.env.E2E_ERROR_CONTRACT === 'console' ||
      (process.env.E2E_ERROR_CONTRACT === 'recover' && testInfo.retry === 0)
    ) {
      await page.evaluate(() => {
        // eslint-disable-next-line no-console
        console.error(new Error('contract-console'), {
          getThrown: () => new TypeError('contract-underlying'),
        });
      });
    } else if (process.env.E2E_ERROR_CONTRACT === 'pageerror') {
      await page.setContent(
        '<script>throw new Error("contract-pageerror")</script>'
      );
    } else {
      await page.setContent('No application errors');
    }
  });
} else {
  test('captures application stacks, wrapped thrown values and unsafe arguments', async ({
    page,
  }) => {
    const failures: Error[] = [];
    const collect = collectApplicationErrors(page, error =>
      failures.push(error)
    );
    const consoleEvent = page.waitForEvent('console');
    await page.evaluate(function consoleApplicationFrame() {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      const unsafe = {
        get broken() {
          throw new Error('getter unavailable');
        },
      };
      // eslint-disable-next-line no-console
      console.error(
        new Error('native-error'),
        {
          getThrown: function wrappedApplicationFrame() {
            return new TypeError('underlying-error');
          },
        },
        cyclic,
        unsafe,
        { bigint: BigInt(42) },
        undefined,
        () => 'function argument'
      );
    });
    await consoleEvent;
    const pageErrorEvent = page.waitForEvent('pageerror');
    await page.setContent(
      '<script>function applicationFrame() { throw new Error("uncaught-error"); } applicationFrame();</script>'
    );
    await pageErrorEvent;
    const errors = (await collect()) as {
      args?: Record<string, unknown>[];
      stack?: string;
    }[];
    expect(failures).toHaveLength(2);
    const args = errors[0].args ?? [];
    expect(args[0]).toMatchObject({
      name: 'Error',
      message: 'native-error',
      stack: expect.stringContaining('consoleApplicationFrame'),
    });
    expect(args[1]).toMatchObject({
      thrown: {
        name: 'TypeError',
        message: 'underlying-error',
        stack: expect.stringContaining('wrappedApplicationFrame'),
      },
    });
    expect(args[2]).toEqual({ self: '[Circular]' });
    expect(args[3].broken).toContain('getter unavailable');
    expect(args[4]).toEqual({ bigint: '42n' });
    expect(args[5]).toBe('[undefined]');
    expect(args[6]).toContain('function argument');
    expect(errors[1].stack).toContain('applicationFrame');
  });

  test('fail-fast errors fail the run and teardown still attaches evidence', async ({
    browserName,
  }, testInfo) => {
    // A fail-then-pass run must retain evidence from the failed first attempt.
    ['none', 'console', 'pageerror', 'recover'].forEach(mode => {
      const output = testInfo.outputPath(mode);
      const result = spawnSync(
        process.execPath,
        [
          path.join(
            path.dirname(require.resolve('playwright/package.json')),
            'cli.js'
          ),
          'test',
          '--config=playwright-evidence.config.ts',
          `--project=${browserName}`,
          '--workers=1',
          `--retries=${mode === 'recover' ? 1 : 0}`,
          '--repeat-each=1',
          '--reporter=json',
          `--output=${output}`,
        ],
        {
          cwd: path.resolve(__dirname, '..'),
          env: {
            ...process.env,
            E2E_ERROR_CONTRACT: mode,
            PLAYWRIGHT_JSON_OUTPUT_NAME: path.join(output, 'report.json'),
          },
          encoding: 'utf8',
        }
      );
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(
        mode === 'none' || mode === 'recover' ? 0 : 1
      );
      if (mode !== 'none') {
        const report = JSON.parse(
          readFileSync(path.join(output, 'report.json'), 'utf8')
        );
        const { attachments } = report.suites[0].specs[0].tests[0].results[0];
        const evidence = attachments.find(
          (attachment: { name: string }) =>
            attachment.name === 'application-errors'
        );
        expect(evidence, result.stdout + result.stderr).toBeDefined();
        const errorBody = Buffer.from(evidence.body, 'base64').toString();
        expect(errorBody).toContain(
          `contract-${mode === 'recover' ? 'console' : mode}`
        );
        if (mode === 'console' || mode === 'recover') {
          expect(JSON.parse(errorBody)[0].args[1]).toMatchObject({
            thrown: {
              message: 'contract-underlying',
              stack: expect.any(String),
            },
          });
        }
        const metadata = attachments.find(
          (attachment: { name: string }) =>
            attachment.name === 'reproduction-metadata'
        );
        expect(metadata).toBeDefined();
        expect(
          JSON.parse(Buffer.from(metadata.body, 'base64').toString())
        ).toMatchObject({
          actualWorkers: 1,
          browserVersion: expect.any(String),
          frontendCommit: expect.any(String),
        });
        const video = attachments.find(
          (attachment: { name: string }) => attachment.name === 'video'
        );
        expect(video).toBeDefined();
        expect(existsSync(video.path)).toBe(true);
        if (mode === 'recover') {
          expect(
            report.suites[0].specs[0].tests[0].results.map(
              (attempt: { status: string }) => attempt.status
            )
          ).toEqual(['failed', 'passed']);
        }
      }
    });
  });
}
