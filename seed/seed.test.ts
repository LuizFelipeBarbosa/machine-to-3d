/// <reference types="node" />
// @vitest-environment node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MachineDefinitionSchema, referencedNodes } from '../shared/machine';
import { ProcedureContentSchema } from '../shared/procedure';
import { validateProcedure, type LinkTargets } from '../shared/validateProcedure';
import { summarizeGlb } from '../scripts/lib/glb';
import { SEED_MACHINES } from './manifest';

function readJson(...segments: string[]): unknown {
  const file = resolve(process.cwd(), ...segments);
  return JSON.parse(readFileSync(file, 'utf8'));
}

describe('seed content', () => {
  for (const machine of SEED_MACHINES) {
    describe(machine.slug, () => {
      it('validates the machine definition against its GLB', () => {
        const definition = MachineDefinitionSchema.parse(readJson(machine.dir, 'machine.json'));
        const bytes = readFileSync(resolve(process.cwd(), machine.dir, 'model.glb'));
        const summary = summarizeGlb(bytes);

        expect(summary.rootNodes).toEqual([definition.rootNode]);
        for (const node of referencedNodes(definition)) {
          expect(summary.namedNodes, `Missing GLB node: ${node}`).toContain(node);
        }
      });

      for (const slug of machine.procedureSlugs) {
        it(`validates ${slug} and its cross-links`, () => {
          const definition = MachineDefinitionSchema.parse(readJson(machine.dir, 'machine.json'));
          const procedures = machine.procedureSlugs.map((procedureSlug) => ({
            slug: procedureSlug,
            content: ProcedureContentSchema.parse(
              readJson(machine.dir, 'procedures', `${procedureSlug}.json`),
            ),
          }));
          const linkTargets: LinkTargets = {};
          for (const procedure of procedures) {
            linkTargets[procedure.slug] = procedure.content.steps.map((step) => step.id);
          }

          const procedure = procedures.find((entry) => entry.slug === slug)!;
          expect(validateProcedure(procedure.content, definition, linkTargets)).toEqual([]);
        });
      }
    });
  }

  it('includes the three Park NX10 procedures with 11, 6, and 5 steps', () => {
    const machine = SEED_MACHINES.find((entry) => entry.slug === 'park-nx10')!;
    expect(machine.procedureSlugs).toEqual(['nc-scan', 'probe-exchange', 'shutdown']);

    const stepCounts = machine.procedureSlugs.map((slug) => {
      const content = ProcedureContentSchema.parse(
        readJson(machine.dir, 'procedures', `${slug}.json`),
      );
      return content.steps.length;
    });
    expect(stepCounts).toEqual([11, 6, 5]);
  });
});
