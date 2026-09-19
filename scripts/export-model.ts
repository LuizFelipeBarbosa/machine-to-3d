import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { summarizeGlb } from './lib/glb.js';

// Texture-free exports only need these two asynchronous FileReader operations.
class NodeFileReader {
  result: ArrayBuffer | string | null = null;
  onload: (() => void) | null = null;
  onloadend: (() => void) | null = null;

  async readAsArrayBuffer(blob: Blob): Promise<void> {
    this.result = await blob.arrayBuffer();
    this.onload?.();
    this.onloadend?.();
  }

  async readAsDataURL(blob: Blob): Promise<void> {
    const buffer = await blob.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    this.result = `data:${blob.type || 'application/octet-stream'};base64,${base64}`;
    this.onload?.();
    this.onloadend?.();
  }
}

export async function exportModel(modulePath: string): Promise<Buffer> {
  if (typeof globalThis.FileReader === 'undefined') {
    Object.defineProperty(globalThis, 'FileReader', {
      value: NodeFileReader,
      configurable: true,
      writable: true,
    });
  }

  const module = await import(pathToFileURL(resolve(modulePath)).href);
  const { root, clips } = module.buildModel();
  if (!root.name) {
    throw new Error('Expected a named root node.');
  }
  // GLTFExporter ignores clips attached to objects unless passed in its options.
  const result = await new GLTFExporter().parseAsync(root, { binary: true, animations: clips });
  if (!(result instanceof ArrayBuffer)) {
    throw new Error('Expected a binary glTF export.');
  }
  return Buffer.from(result);
}

async function main(): Promise<void> {
  const { modulePath, outputPath } = parseArguments();
  const glb = await exportModel(modulePath);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, glb);
  const summary = summarizeGlb(glb);
  console.log(JSON.stringify(summary, null, 2));

  if (summary.meshCount === 0) {
    throw new Error('Expected at least one mesh.');
  }
  if (summary.rootNodes.length !== 1) {
    throw new Error(`Expected exactly one scene root node; found ${summary.rootNodes.length}.`);
  }
}

function parseArguments() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string' },
    },
  });
  if (positionals.length !== 1 || !values.out) {
    throw new Error('Usage: node --import tsx scripts/export-model.ts <buildModel.ts> --out <file.glb>');
  }
  return { modulePath: positionals[0], outputPath: resolve(values.out) };
}

// Importing exportModel from tests must not run the CLI.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`export-model: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
