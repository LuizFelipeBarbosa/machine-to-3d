import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Page } from '@playwright/test';
import { summarizeGlb } from './lib/glb.js';

// These are the small subset of r128's browser globals used by the harness.
type CapturedObject = { children: unknown[] };
type CaptureWindow = {
  __capturedScene?: { getObjectByName(name: string): CapturedObject | undefined };
  THREE: {
    GLTFExporter: new () => {
      parse(object: CapturedObject, onDone: (result: ArrayBuffer | object) => void,
        options: { binary: boolean }): void;
    };
  };
};

async function main(): Promise<void> {
  const { input, root, out } = parseArguments();
  const html = await readFile(input, 'utf8');
  const require = createRequire(import.meta.url);
  const [exporter, three, controls] = await Promise.all([
    readFile(require.resolve('three-r128/examples/js/exporters/GLTFExporter.js'), 'utf8'),
    readFile(require.resolve('three-r128/build/three.min.js'), 'utf8'),
    readFile(require.resolve('three-r128/examples/js/controls/OrbitControls.js'), 'utf8'),
  ]);
  const preparedHtml = preparePage(html, exporter);
  const browser = await chromium.launch({ headless: true });
  let bytes: Buffer;
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const origin = 'http://capture.local/';
    const localScripts = new Map([
      ['https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js', three],
      ['https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js', controls],
    ]);
    await context.route('**/*', async route => {
      const url = route.request().url();
      if (url === origin) {
        await route.fulfill({ contentType: 'text/html', body: preparedHtml });
      } else if (localScripts.has(url)) {
        await route.fulfill({ contentType: 'application/javascript', body: localScripts.get(url)! });
      } else {
        await route.abort();
      }
    });
    // WebSockets are routed separately from ordinary HTTP requests.
    await context.routeWebSocket('**/*', socket => socket.close());
    const page = await context.newPage();
    bytes = await captureScene(page, origin, root);
  } finally {
    await browser.close();
  }
  if (bytes.length === 0) throw new Error('Empty export: exporter returned no bytes.');
  const summary = summarizeGlb(bytes);
  if (summary.meshCount === 0) throw new Error('Empty export: no meshes were exported.');
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, bytes);
  console.log(JSON.stringify(summary, null, 2));
}

function parseArguments() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { root: { type: 'string' }, out: { type: 'string' } },
  });
  if (positionals.length !== 1 || !values.root || !values.out) {
    throw new Error('Usage: npx tsx scripts/capture-glb.ts <input.html> --root <RootNodeName> --out <output.glb>');
  }
  return { input: positionals[0], root: values.root, out: values.out };
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
  // Decode once: &amp;lt; represents the literal text &lt; in the inner HTML.
  return value.replace(/&(#x[\da-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (entity, code: string) => {
    if (!code.startsWith('#')) return named[code.toLowerCase()];
    const hex = code[1].toLowerCase() === 'x';
    const point = Number.parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (point === 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return '\ufffd';
    return String.fromCodePoint(point);
  });
}

function resolveWidgetStatePlaceholder(html: string): string {
  return html.replaceAll('__CODEX_VISUALIZATION_WIDGET_STATE__', '{}');
}

function findInstrumentScriptIndex(html: string): number {
  const scripts = html.matchAll(/<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script\s*>/gi);
  for (const script of scripts) {
    const attributes = script[1].matchAll(/([^\s=<>/"']+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g);
    const hasSource = [...attributes].some(attribute => attribute[1].toLowerCase() === 'src');
    if (!hasSource && script[2].includes('new THREE.Scene(')) {
      return script.index;
    }
  }
  throw new Error("Could not find the instrument script: no inline <script> contains 'new THREE.Scene('.");
}

function preparePage(html: string, exporter: string): string {
  const iframeTags = html.match(/<iframe\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi) ?? [];
  for (const tag of iframeTags) {
    const attributes = new Map<string, string>();
    for (const match of tag.matchAll(/([^\s=<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      attributes.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4]);
    }
    if (attributes.get('id') === 'codex-visualization' && attributes.has('data-srcdoc')) {
      html = decodeHtmlEntities(attributes.get('data-srcdoc')!);
      html = resolveWidgetStatePlaceholder(html);
      break;
    }
  }
  const instrumentScriptIndex = findInstrumentScriptIndex(html);
  const injection = `<script>
THREE.Scene = class CapturedScene extends THREE.Scene {
  constructor(...args) {
    super(...args);
    window.__capturedScene = this;
  }
};
${exporter.replace(/<\/script/gi, '<\\/script')}
</script>\n`;
  return html.slice(0, instrumentScriptIndex) + injection + html.slice(instrumentScriptIndex);
}

async function captureScene(page: Page, origin: string, root: string): Promise<Buffer> {
  let onPageError: (error: Error) => void = () => {};
  const pageFailure = new Promise<never>((_, reject) => {
    onPageError = error => reject(new Error(`Page error: ${error.message}`));
  });
  page.on('pageerror', onPageError);
  try {
    return await Promise.race([pageFailure, (async () => {
      await page.goto(origin, { waitUntil: 'load', timeout: 15_000 });
      try {
        await page.waitForFunction(name => {
          const target = (window as unknown as CaptureWindow).__capturedScene?.getObjectByName(name);
          return target !== undefined && target.children.length > 0;
        }, root, { timeout: 15_000 });
      } catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError') {
          throw new Error(`Root "${root}" was not found with children within 15 seconds.`);
        }
        throw error;
      }
      const base64 = await page.evaluate(name => new Promise<string>((resolve, reject) => {
        const captured = window as unknown as CaptureWindow;
        const target = captured.__capturedScene?.getObjectByName(name);
        if (!target) {
          reject(new Error(`Root "${name}" disappeared before export.`));
          return;
        }
        const timeout = setTimeout(() => reject(new Error('GLB export timed out after 15 seconds.')), 15_000);
        try {
          new captured.THREE.GLTFExporter().parse(target, result => {
            clearTimeout(timeout);
            if (!(result instanceof ArrayBuffer) || result.byteLength === 0) {
              reject(new Error('Empty export: expected a non-empty binary ArrayBuffer.'));
              return;
            }
            const data = new Uint8Array(result);
            const chunks: string[] = [];
            for (let offset = 0; offset < data.length; offset += 0x8000) {
              chunks.push(String.fromCharCode(...data.subarray(offset, offset + 0x8000)));
            }
            resolve(btoa(chunks.join('')));
          }, { binary: true });
        } catch (error) {
          clearTimeout(timeout);
          reject(error);
        }
      }), root);
      return Buffer.from(base64, 'base64');
    })()]);
  } finally {
    page.off('pageerror', onPageError);
  }
}

main().catch(error => {
  console.error(`capture-glb: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
