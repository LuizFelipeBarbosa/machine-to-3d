import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { dedupeNodeNames } from './lib/glb.js';

async function main(): Promise<void> {
  const { input, output } = parseArguments();
  const result = dedupeNodeNames(await readFile(input));
  await writeFile(output ?? input, result.bytes);

  const renames = Object.entries(result.renamed).flatMap(([originalName, names]) =>
    names.map(name => `${originalName} -> ${name}`));
  if (renames.length === 0) {
    console.log('No duplicate node names found.');
  } else {
    console.log(renames.join('\n'));
  }
}

function parseArguments(): { input: string; output: string | undefined } {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { out: { type: 'string' } },
  });
  if (positionals.length !== 1) {
    throw new Error('Usage: node --import tsx scripts/dedupe-glb-names.ts <in.glb> [--out <out.glb>]');
  }
  return { input: positionals[0], output: values.out };
}

main().catch(error => {
  console.error(`dedupe-glb-names: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
