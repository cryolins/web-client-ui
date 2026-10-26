import { test, expect, type Page, type TestInfo } from '@playwright/test';
import {
  waitForLoadingDone,
  openTable,
  expectContextMenus,
  gotoPage,
} from './utils';

async function openAdvancedFilters(page: Page) {
  await page
    .locator('.iris-grid .grid-wrapper')
    .click({ button: 'right', position: { x: 20, y: 20 } });
  await page.getByRole('button', { name: 'Advanced Filters' }).click();
}

async function moveMouseAwayFromTable(page: Page) {
  await page.mouse.move(0, 0);
  await page.mouse.click(0, 0);
}

const pageEvents = new WeakMap<Page, string[]>();

function recordPageEvents(page: Page) {
  const events: string[] = [];
  const log = (message: string) =>
    events.push(`${new Date().toISOString()} ${message}`);
  pageEvents.set(page, events);
  page.on('crash', () => log('crash'));
  page.on('pageerror', err => log(`pageerror: ${err.message}`));
  page.on('console', msg => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      log(`console.${msg.type()}: ${msg.text()}`);
    }
  });
  page.on('requestfailed', req =>
    log(`requestfailed: ${req.url()} ${req.failure()?.errorText}`)
  );
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) {
      log(`navigated: ${frame.url()}`);
    }
  });
}

async function attachPageEvents(page: Page, testInfo: TestInfo) {
  if (testInfo.status === testInfo.expectedStatus) {
    return;
  }
  await testInfo.attach('page-events', {
    body: [
      `url: ${page.isClosed() ? 'closed' : page.url()}`,
      ...(pageEvents.get(page) ?? []),
    ].join('\n'),
    contentType: 'text/plain',
  });
}

test.beforeEach(async ({ page }) => {
  recordPageEvents(page);
  await gotoPage(page, '');
  await openTable(page, 'all_types');

  const tableOperationsMenu = page.locator(
    'data-testid=btn-iris-grid-settings-button-table'
  );
  await tableOperationsMenu.click();

  // Wait for Table Options menu to show
  await expect(page.locator('.table-sidebar')).toHaveCount(1);
});

test.afterEach(async ({ page }, testInfo) => {
  await attachPageEvents(page, testInfo);
});

test('toggle column visibility', async ({ page }) => {
  await page
    .locator('.iris-grid .grid-wrapper')
    .click({ button: 'right', position: { x: 20, y: 20 } });

  await page.getByRole('button', { name: 'Hide Column' }).click();
  await expect(page.locator('.iris-grid-column')).toHaveScreenshot();

  await page
    .locator('.iris-grid .grid-wrapper')
    .click({ button: 'right', position: { x: 20, y: 20 } });

  await page.getByRole('button', { name: 'Show All Columns' }).click();
  await expect(page.locator('.iris-grid-column')).toHaveScreenshot();
});

test('quick filter and clear', async ({ page }) => {
  await page
    .locator('.iris-grid .grid-wrapper')
    .click({ button: 'right', position: { x: 20, y: 20 } });

  await page.getByRole('button', { name: 'Quick Filters' }).click();
  await page.keyboard.type('a999');

  await waitForLoadingDone(page);
  await expect(page.locator('.iris-grid-column')).toHaveScreenshot();

  await page
    .locator('.iris-grid .grid-wrapper')
    .click({ button: 'right', position: { x: 20, y: 20 } });

  await page.getByRole('button', { name: 'Clear Column Filter' }).click();

  await page
    .locator('.iris-grid .grid-wrapper')
    .hover({ position: { x: 20, y: 20 } });
  await page.mouse.wheel(0, -100);

  await waitForLoadingDone(page);
  await expect(page.locator('.iris-grid-column')).toHaveScreenshot();
});

test('advanced filters', async ({ page }) => {
  await openAdvancedFilters(page);
  await page.getByLabel('Sort String Ascending').click();

  await page.getByRole('button', { name: 'Done' }).click();
  await waitForLoadingDone(page);
  await moveMouseAwayFromTable(page);
  await expect(page.locator('.iris-grid-column')).toHaveScreenshot();

  await openAdvancedFilters(page);
  await page.getByLabel('Sort String Descending').click();

  await page.getByRole('button', { name: 'Done' }).click();
  await waitForLoadingDone(page);
  await moveMouseAwayFromTable(page);
  await expect(page.locator('.iris-grid-column')).toHaveScreenshot();

  await openAdvancedFilters(page);
  await page.getByPlaceholder('Enter value').click();
  await page.keyboard.type('a999');

  await page.getByRole('button', { name: 'Done' }).click();
  await waitForLoadingDone(page);
  await moveMouseAwayFromTable(page);
  await expect(page.locator('.iris-grid-column')).toHaveScreenshot();

  await openAdvancedFilters(page);
  await page.getByLabel('Remove Filter').click();

  await page.getByRole('button', { name: 'Done' }).click();
  await waitForLoadingDone(page);
  await moveMouseAwayFromTable(page);
  await expect(page.locator('.iris-grid-column')).toHaveScreenshot();

  await openAdvancedFilters(page);
  await page.getByRole('button', { name: 'Clear', exact: true }).click();

  await page.getByRole('button', { name: 'Done' }).click();
  await waitForLoadingDone(page);
  await moveMouseAwayFromTable(page);
  await expect(page.locator('.iris-grid-column')).toHaveScreenshot();

  await openAdvancedFilters(page);
  await page.getByRole('button', { name: 'Select All' }).click();

  await page.getByRole('button', { name: 'Done' }).click();
  await waitForLoadingDone(page);
  await moveMouseAwayFromTable(page);
  await expect(page.locator('.iris-grid-column')).toHaveScreenshot();
});

test('sort by', async ({ page }) => {
  await page
    .locator('.iris-grid .grid-wrapper')
    .click({ button: 'right', position: { x: 20, y: 20 } });

  await page.getByRole('button', { name: 'Sort By' }).hover();

  await page.getByRole('button', { name: 'String Ascending' }).click();

  await waitForLoadingDone(page);
  await expect(page.locator('.iris-grid-column')).toHaveScreenshot();

  await page
    .locator('.iris-grid .grid-wrapper')
    .click({ button: 'right', position: { x: 20, y: 20 } });

  await page.getByRole('button', { name: 'Sort By' }).hover();
  await page.getByRole('button', { name: 'String Descending' }).click();

  await waitForLoadingDone(page);
  await expect(page.locator('.iris-grid-column')).toHaveScreenshot();

  await page
    .locator('.iris-grid .grid-wrapper')
    .click({ button: 'right', position: { x: 20, y: 20 } });

  await page.getByRole('button', { name: 'Sort By' }).hover();
  await page.getByRole('button', { name: 'Remove Sort' }).click();

  await waitForLoadingDone(page);
  await expect(page.locator('.iris-grid-column')).toHaveScreenshot();
});

test('freeze column', async ({ page }) => {
  await page
    .locator('.iris-grid .grid-wrapper')
    .click({ button: 'right', position: { x: 20, y: 20 } });

  await page.getByRole('button', { name: 'Freeze Column' }).click();

  await waitForLoadingDone(page);
  await expect(page.locator('.iris-grid-column')).toHaveScreenshot();

  await page
    .locator('.iris-grid .grid-wrapper')
    .click({ button: 'right', position: { x: 20, y: 20 } });

  await page.getByRole('button', { name: 'Unfreeze Column' }).click();

  await waitForLoadingDone(page);
  await expect(page.locator('.iris-grid-column')).toHaveScreenshot();
});

test('reverse table', async ({ page }) => {
  await page
    .locator('.iris-grid .grid-wrapper')
    .click({ button: 'right', position: { x: 20, y: 20 } });

  await page.getByRole('button', { name: 'Reverse Table' }).click();

  await waitForLoadingDone(page);
  await expect(page.locator('.iris-grid-column')).toHaveScreenshot();
});

test('filter by value', async ({ page }) => {
  await page
    .locator('.iris-grid .grid-wrapper')
    .click({ button: 'right', position: { x: 20, y: 60 } });
  await expectContextMenus(page, 1);

  await page.getByRole('button', { name: 'Filter by Value' }).hover();
  await expectContextMenus(page, 2);
  await page.getByRole('button', { name: 'text is exactly' }).click();

  await waitForLoadingDone(page);
  await expect(page.locator('.iris-grid-column')).toHaveScreenshot();

  await page
    .locator('.iris-grid .grid-wrapper')
    .click({ button: 'right', position: { x: 20, y: 60 } });
  await page.getByRole('button', { name: 'Clear Column Filter' }).click();
});

test('go to', async ({ page }) => {
  await page
    .locator('.iris-grid .grid-wrapper')
    .click({ button: 'right', position: { x: 20, y: 60 } });
  await expectContextMenus(page, 1);

  await page.getByRole('button', { name: 'Go to' }).click();
  await page.getByLabel('filter-type-select').selectOption('Equals');

  await waitForLoadingDone(page);
  await expect(page.locator('.iris-grid-column')).toHaveScreenshot();

  await page.locator('[aria-label="Next match"]').first().click();
  await page.locator('[aria-label="Next match"]').first().click();

  await waitForLoadingDone(page);
  await expect(page.locator('.iris-grid-column')).toHaveScreenshot();

  await page.locator('[aria-label="Previous match"]').first().click();

  await waitForLoadingDone(page);
  await expect(page.locator('.iris-grid-column')).toHaveScreenshot();
});

test('open custom context menu with another custom context menu open', async ({
  page,
}) => {
  await page.goto('');

  await page.getByText('Console', { exact: true }).click({ button: 'right' });
  await expect(page.getByText('Close', { exact: true })).toHaveCount(1);

  await page
    .getByText('Command History')
    .click({ button: 'right', force: true });
  await expect(page.getByText('Close', { exact: true })).toHaveCount(1);

  await page.getByText('Console', { exact: true }).click({ force: true });
});
