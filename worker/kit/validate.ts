import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ZodType } from 'zod';
import { summarizeGlb, type GlbSummary } from '../../scripts/lib/glb.js';
import {
  MachineDefinitionSchema, referencedClips, referencedNodes, type MachineDefinition,
} from '../../shared/machine.js';
import { ProcedureContentSchema } from '../../shared/procedure.js';
import { validateProcedure, type LinkTargets } from '../../shared/validateProcedure.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readJson<T>(dir: string, file: string, schema: ZodType<T>, issues: string[]): T | undefined {
  try {
    const result = schema.safeParse(JSON.parse(readFileSync(join(dir, file), 'utf8')));
    if (result.success) return result.data;
    for (const issue of result.error.issues) {
      const path = issue.path.length ? `${file}.${issue.path.join('.')}` : file;
      issues.push(`${path}: ${issue.message}`);
    }
  } catch (error) {
    issues.push(`${file}: ${errorMessage(error)}`);
  }
  return undefined;
}

function procedureFiles(dir: string, issues: string[]): string[] {
  try {
    return readdirSync(join(dir, 'procedures')).filter(file => file.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      issues.push(`procedures: ${errorMessage(error)}`);
    }
    return [];
  }
}

function validateGlb(summary: GlbSummary, definition: MachineDefinition, issues: string[]): void {
  if (summary.rootNodes.length !== 1 || summary.rootNodes[0] !== definition.rootNode) {
    issues.push(`model.glb: Expected exactly one root named "${definition.rootNode}"; found ${JSON.stringify(summary.rootNodes)}.`);
  }
  for (const name of summary.duplicateNames) {
    issues.push(`model.glb: Duplicate node name "${name}".`);
  }
  for (const name of referencedNodes(definition)) {
    if (!summary.namedNodes.includes(name)) {
      issues.push(`model.glb: Missing referenced node "${name}".`);
    }
  }

  const transformNodes = new Set(definition.stateVars.flatMap(stateVar =>
    stateVar.effects.flatMap(effect =>
      effect.type === 'translate' || effect.type === 'rotate' ? [effect.node] : [])));
  const nodeClips = new Map<string, string>();
  for (const name of referencedClips(definition)) {
    const animations = summary.animations.filter(animation => animation.name === name);
    if (animations.length === 0) {
      issues.push(`model.glb: Missing referenced clip "${name}".`);
    }
    if (animations.length > 1) {
      issues.push(`model.glb: Duplicate referenced clip "${name}".`);
    }
    for (const animation of animations) {
      for (const node of animation.targetNodes) {
        if (transformNodes.has(node)) {
          issues.push(`model.glb: Clip "${name}" targets node "${node}", also targeted by a translate/rotate effect.`);
        }
        const owner = nodeClips.get(node);
        if (owner !== undefined && owner !== name) {
          issues.push(`model.glb: Node "${node}" is targeted by two referenced clips: "${owner}" and "${name}".`);
        }
        nodeClips.set(node, name);
      }
    }
  }
}

export function validateWorkspace(dir: string): { issues: string[]; warnings: string[] } {
  const issues: string[] = [];
  const warnings: string[] = [];
  const definition = readJson(dir, 'machine.json', MachineDefinitionSchema, issues);
  try {
    const summary = summarizeGlb(readFileSync(join(dir, 'model.glb')));
    if (definition) validateGlb(summary, definition, issues);
  } catch (error) {
    issues.push(`model.glb: ${errorMessage(error)}`);
  }

  const procedures = procedureFiles(dir, issues).flatMap(file => {
    const content = readJson(dir, `procedures/${file}`, ProcedureContentSchema, issues);
    return content ? [{ file, slug: file.slice(0, -5), content }] : [];
  });
  const linkTargets: LinkTargets = Object.fromEntries(procedures.map(({ slug, content }) =>
    [slug, content.steps.map(step => step.id)]));
  for (const { file, slug, content } of procedures) {
    if (definition) {
      for (const issue of validateProcedure(content, definition, linkTargets)) {
        issues.push(`procedures/${file}.${issue.path}: ${issue.message}`);
      }
    }
    for (const step of content.steps) {
      if (step.provenance === 'inferred') {
        warnings.push(`warning: ${slug}: step ${step.id} is inferred`);
      }
    }
  }
  return { issues, warnings };
}

function main(): void {
  if (process.argv.length !== 3) {
    console.error('validate: Usage: node --import tsx worker/kit/validate.ts <workspace>');
    process.exitCode = 1;
    return;
  }
  const dir = resolve(process.argv[2]);
  const { issues, warnings } = validateWorkspace(dir);
  for (const issue of issues) console.error(issue);
  for (const warning of warnings) console.warn(warning);
  if (issues.length > 0) {
    process.exitCode = 1;
  } else {
    console.log(`validate: ok (${procedureFiles(dir, []).length} procedures)`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
