import { expect, test } from '@playwright/test';
import { SEED_MACHINES } from '../../seed/manifest';
import { openAndSettle } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
});

for (const machine of SEED_MACHINES) {
  test.describe(machine.name, () => {
    test('machine explorer', async ({ page }) => {
      await openAndSettle(page, `/m/${machine.slug}`);
      await expect(page.locator('.machine h1')).toHaveText(machine.name);
      await expect(page.locator('.machine h1')).toBeVisible();
      await expect(page.getByRole('combobox', { name: 'Procedure', exact: true })).toHaveValue('');
      await expect(page.locator('.scene-fail')).not.toBeVisible();
      await expect(page.locator('.machine-scene canvas')).toBeVisible();
      await expect(page).toHaveScreenshot(`${machine.slug}-explorer.png`);
    });
  });
}
