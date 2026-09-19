import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from '@playwright/test';
import { createServer } from 'vite';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--out' || !args[1])) {
    throw new Error('Usage: npx tsx scripts/export-nx10.ts [--out seed/park-nx10/model.glb]');
  }
  const repoRoot = fileURLToPath(new URL('../', import.meta.url));
  const outputPath = resolve(repoRoot, args[1] ?? 'seed/park-nx10/model.glb');
  const server = await createServer({
    root: repoRoot,
    configFile: false,
    cacheDir: '/tmp/nx10-vite-cache',
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, open: false },
  });
  let browser: Browser | undefined;
  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Vite did not open a TCP port.');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/seed/park-nx10/export.html`);
    await page.waitForFunction(
      () => window.__glbBase64 !== undefined || window.__glbError !== undefined,
      { },
      { timeout: 30_000 },
    );
    const result = await page.evaluate(() => ({
      base64: window.__glbBase64,
      error: window.__glbError,
    }));
    if (result.error !== undefined) throw new Error(result.error);
    if (!result.base64) throw new Error('The export page returned no GLB data.');
    const glb = Buffer.from(result.base64, 'base64');
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, glb);
    console.log(`Wrote ${glb.byteLength} bytes to ${outputPath}`);
  } finally {
    try {
      await browser?.close();
    } finally {
      await server.close();
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
