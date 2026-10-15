import { test as base, type ConsoleMessage, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';

export function collectApplicationErrors(
  page: Page,
  fail: (error: Error) => void
): () => Promise<unknown[]> {
  const pending: Promise<unknown>[] = [];
  const onConsole = (message: ConsoleMessage) => {
    if (message.type() !== 'error') {
      return;
    }
    // Start reading live handles before fail-fast teardown can close the page.
    pending.push(
      Promise.all(
        message.args().map(async arg => {
          try {
            const serialized = await arg.evaluate(value => {
              const seen = new WeakSet<object>();
              function serialize(item: unknown, depth = 0): unknown {
                if (typeof item === 'bigint') return `${item}n`;
                if (typeof item === 'undefined') return '[undefined]';
                if (typeof item === 'function' || typeof item === 'symbol') {
                  return String(item);
                }
                if (item === null || typeof item !== 'object') return item;
                if (seen.has(item)) return '[Circular]';
                if (depth > 8) return '[Max depth]';
                seen.add(item);
                const result: Record<string, unknown> = {};
                const object = item as Record<string, unknown>;
                const keys = new Set(Object.keys(object));
                ['name', 'message', 'stack', 'cause'].forEach(key => {
                  if (key in object) keys.add(key);
                });
                keys.forEach(key => {
                  try {
                    result[key] = serialize(object[key], depth + 1);
                  } catch (error) {
                    result[key] = `[Unavailable: ${String(error)}]`;
                  }
                });
                // GWT JavaScriptException wraps the application exception.
                try {
                  if (typeof object.getThrown === 'function') {
                    result.thrown = serialize(object.getThrown(), depth + 1);
                  }
                } catch (error) {
                  result.thrown = `[Unavailable: ${String(error)}]`;
                }
                return result;
              }
              return serialize(value);
            });
            return serialized;
          } catch (error) {
            return { unavailable: String(error), preview: arg.toString() };
          }
        })
      ).then(args => ({
        type: 'console.error',
        text: message.text(),
        location: message.location(),
        args,
      }))
    );
    fail(new Error(message.text()));
  };
  const onPageError = (error: Error) => {
    pending.push(
      Promise.resolve({
        type: 'pageerror',
        name: error.name,
        message: error.message,
        stack: error.stack,
      })
    );
    fail(error);
  };
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  return async () => {
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
    return Promise.all(pending);
  };
}

export const test = base.extend<{ applicationErrors: void }>({
  applicationErrors: [
    async ({ page, browser, browserName }, use, testInfo) => {
      const collect = collectApplicationErrors(page, error => {
        throw error;
      });
      try {
        await use();
      } finally {
        const errors = await collect();
        await testInfo.attach('application-errors', {
          body: JSON.stringify(errors, null, 2),
          contentType: 'application/json',
        });
        let frontendCommit = process.env.E2E_FRONTEND_COMMIT;
        if (frontendCommit == null || frontendCommit === '') {
          try {
            frontendCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
              encoding: 'utf8',
            }).trim();
          } catch {
            frontendCommit = 'unknown';
          }
        }
        await testInfo.attach('reproduction-metadata', {
          body: JSON.stringify(
            {
              backendImage: process.env.DHC_IMAGE ?? 'unknown (local backend)',
              frontendCommit,
              browserName,
              browserVersion: browser.version(),
              actualWorkers: testInfo.config.metadata.actualWorkers,
              configuredWorkers: testInfo.config.workers,
              workerIndex: testInfo.workerIndex,
              parallelIndex: testInfo.parallelIndex,
              retry: testInfo.retry,
              repeatEachIndex: testInfo.repeatEachIndex,
              diagnostic: process.env.E2E_CUSTOM_COLUMN_DIAGNOSTICS === '1',
            },
            null,
            2
          ),
          contentType: 'application/json',
        });
      }
    },
    { auto: true },
  ],
});
