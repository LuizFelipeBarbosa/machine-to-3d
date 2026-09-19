import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { summarizeGlb, type GlbSummary } from './lib/glb.js';

async function main(): Promise<void> {
  const { file, root, requiredNames, json } = parseArguments();
  const summary = summarizeGlb(await readFile(file));
  console.log(json ? JSON.stringify(summary, null, 2) : formatSummary(summary));

  if (summary.duplicateNames.length > 0) {
    throw new Error(`Duplicate node names: ${summary.duplicateNames.join(', ')}.`);
  }
  if (summary.rootNodes.length !== 1) {
    throw new Error(`Expected exactly one scene root node; found ${summary.rootNodes.length}.`);
  }
  if (root !== undefined && summary.rootNodes[0] !== root) {
    throw new Error(`Expected root "${root}"; found "${summary.rootNodes[0]}".`);
  }
  const missing = requiredNames.filter(name => !summary.namedNodes.includes(name));
  if (missing.length > 0) {
    throw new Error(`Missing required named nodes: ${missing.join(', ')}.`);
  }
}

function parseArguments() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: 'string' },
      require: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  });
  if (positionals.length !== 1) {
    throw new Error('Usage: npx tsx scripts/inspect-glb.ts <file.glb> [--root <name>] [--require <name,name,...>] [--json]');
  }
  return {
    file: positionals[0],
    root: values.root,
    requiredNames: values.require?.split(',').map(name => name.trim()).filter(Boolean) ?? [],
    json: values.json,
  };
}

function formatSummary(summary: GlbSummary): string {
  const bounds = summary.boundingBox;
  return [
    `Generator: ${summary.generator ?? '(unspecified)'}`,
    `Root nodes: ${JSON.stringify(summary.rootNodes)}`,
    `Named nodes: ${summary.namedNodes.join(', ')}`,
    `Nodes: ${summary.nodeCount}; meshes: ${summary.meshCount}; animations: ${summary.animationCount}`,
    `Extensions used: ${summary.extensionsUsed.join(', ') || '(none)'}`,
    bounds ? `Bounding box: min ${JSON.stringify(bounds.min)}, max ${JSON.stringify(bounds.max)}`
      : 'Bounding box: unavailable',
  ].join('\n');
}

main().catch(error => {
  console.error(`inspect-glb: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
