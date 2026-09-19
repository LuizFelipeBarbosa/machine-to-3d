import type { Page } from '@playwright/test';

export async function openAndSettle(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.locator('.machine-scene canvas').waitFor({ state: 'visible' });
  await page.waitForTimeout(1500);
}

export async function themed(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((value) => {
    document.documentElement.dataset.theme = value;
  }, theme);
  await page.waitForTimeout(1500);
}
