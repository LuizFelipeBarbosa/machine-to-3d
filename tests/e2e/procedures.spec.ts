import { expect, test } from '@playwright/test';
import { SEED_MACHINES } from '../../seed/manifest';
import { openAndSettle, themed } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
});

for (const machine of SEED_MACHINES) {
  if (machine.procedureSlugs.length === 0) continue;

  test.describe(machine.name, () => {
    for (const procedureSlug of machine.procedureSlugs) {
      test(`${procedureSlug}: every step`, async ({ page }, testInfo) => {
        await openAndSettle(page, `/m/${machine.slug}/${procedureSlug}`);

        const steps = page.locator('.steps > .step');
        await expect(steps.first()).toBeVisible();
        const stepCount = await steps.count();
        // Allow long procedures enough time for every software-rendered capture.
        test.setTimeout(Math.max(testInfo.timeout, 30_000 + stepCount * 15_000));

        for (let index = 0; index < stepCount; index += 1) {
          const stepNumber = String(index + 1).padStart(2, '0');

          await test.step(`Step ${stepNumber}`, async () => {
            await expect(page.locator('.panel-count')).toHaveText(
              `Step ${index + 1} of ${stepCount}`,
            );
            await expect(page).toHaveScreenshot(
              `${machine.slug}-${procedureSlug}-step-${stepNumber}.png`,
            );

            const checkpoint = page.locator('label.check input[type=checkbox]');
            if ((await checkpoint.count()) > 0 && !(await checkpoint.isChecked())) {
              await checkpoint.check();
            }

            await page.getByRole('button', {
              name: /^(Next step|Finish procedure)$/,
            }).click();
            await page.waitForTimeout(1500);
          });
        }

        await expect(page.locator('.complete')).toContainText('Procedure complete');
      });
    }

    if (machine.slug === 'park-nx10' && machine.procedureSlugs.includes('nc-scan')) {
      test('nc-scan: step 1 in dark theme', async ({ page }) => {
        await openAndSettle(page, '/m/park-nx10/nc-scan');
        await themed(page, 'dark');
        await expect(page).toHaveScreenshot('park-nx10-nc-scan-step-01-dark.png');
      });

      test('nc-scan: step 1 at narrow width', async ({ page }) => {
        await page.setViewportSize({ width: 820, height: 900 });
        await openAndSettle(page, '/m/park-nx10/nc-scan');
        await expect(page).toHaveScreenshot('park-nx10-nc-scan-step-01-narrow.png');
      });
    }
  });
}
