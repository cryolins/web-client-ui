import { test, expect } from '@playwright/test';
import { generateId, pasteInMonaco } from './utils';

// keep this as serial becomes it runs commands
test.describe.configure({ mode: 'serial' });

test('test creating a file, saving it, reloading the page, closing it, re-opening it, running it, then deleting it', async ({
  page,
  browserName,
}) => {
  await page.goto('');

  // Click text=File Explorer
  await page.locator('text=File Explorer').click();

  // Click [aria-label="New notebook"]
  await page.locator('[aria-label="New notebook"]').click();

  // Click editor container
  await page.locator('.script-editor .editor-container').click();

  const message = `Hello notebook ${browserName} ${generateId()}!`;
  const command = `print("${message}")`;

  await pasteInMonaco(
    page.locator('.script-editor .editor-container'),
    command
  );

  await expect(
    page.locator('.script-editor .editor-container .view-lines')
  ).toContainText(message);

  // Click the Save button
  await page.locator('[aria-label="Save"]').click();

  // Generate a unique filename so it doesn't conflict with any previously created files
  const filename = `__playwright_test${generateId()}.py`;

  // Fill id=file-name-input
  await page.locator('id=file-name-input').fill(filename);

  // Click button:has-text("Save")
  await page.locator('button:has-text("Save")').click();

  // The reload restores the panel from the persisted workspace, so wait for the
  // saved file to be recorded there
  await expect
    .poll(() =>
      page.evaluate(
        () => localStorage.getItem('deephaven.WorkspaceStorage') ?? ''
      )
    )
    .toContain(`"itemName":"/${filename}"`);

  // Reload page to check state of panel is saved
  // The save is eagerly shown as finished but completes on the server
  // asynchronously, so a reload can load the file before its contents are
  // written. Reload until the saved contents are loaded.
  await expect(async () => {
    await page.reload();
    await expect(
      page.locator('.script-editor .editor-container .view-lines')
    ).toContainText(message, { timeout: 5000 });
  }).toPass({ timeout: 30000 });

  // Click close on the notebook file .lm_close_tab
  await page.locator('.lm_close_tab').click();

  // Wait for notebook file to close
  await expect(page.locator('.notebook-toolbar')).toHaveCount(0);

  // Wait for file to appear in file explorer
  const fileInExplorer = page.locator('.item-list-item', { hasText: filename });
  await expect(fileInExplorer).toHaveCount(1);

  // Click to re-open the file
  await fileInExplorer.click();

  // Click the Run button
  await page.locator('.notebook-toolbar [aria-label="Run"]').click();

  // Click close on the notebook file .lm_close_tab
  await page.locator('.lm_close_tab').click();

  // Right-click the file to open the menu, then delete it
  await page.locator(`text=${filename}`).click({
    button: 'right',
  });

  // Click button:has-text("Delete")
  await page.locator('button:has-text("Delete")').click();

  // Confirm delete
  await page
    .locator('.modal-content')
    .locator('button:has-text("Delete")')
    .click();

  await expect(fileInExplorer).toHaveCount(0);
});
