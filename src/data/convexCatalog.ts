import type { ConvexReactClient } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { Catalog } from './catalog';

export function createConvexCatalog(client: ConvexReactClient): Catalog {
  return {
    async listMachines() {
      const machines = await client.query(api.machines.list, {});
      return machines.map(({ slug, name, kind, procedures }) => ({
        slug,
        name,
        kind,
        procedures: procedures
          .filter((procedure) => procedure.hasApproved)
          .map(({ slug, title, minutes }) => ({ slug, title, minutes })),
      }));
    },

    async getMachine(slug) {
      const machine = await client.query(api.machines.getBySlug, { slug });
      if (!machine) return null;
      if (!machine.version.modelUrl) {
        throw new Error('The machine model is unavailable.');
      }
      return {
        slug: machine.slug,
        name: machine.name,
        kind: machine.kind,
        modelUrl: machine.version.modelUrl,
        definition: machine.version.definition,
      };
    },

    async getProcedure(machineSlug, procedureSlug) {
      const procedure = await client.query(api.procedures.getForPlay, { machineSlug, procedureSlug });
      if (!procedure) return null;
      if (!procedure.modelUrl) {
        throw new Error('The approved procedure’s machine model is unavailable.');
      }
      const { content, versionId, sourceVideoUrl } = procedure;
      const text = [content.title, content.summary, ...content.steps.flatMap((step) => [
        step.title, step.body, step.caution ?? '', step.check ?? '',
      ])].join(' ');
      return {
        slug: procedureSlug,
        machineSlug,
        content,
        versionId,
        sourceVideoUrl,
        mediaUrls: procedure.mediaUrls,
        machineVersion: { modelUrl: procedure.modelUrl, definition: procedure.definition },
        placeholder: /\bplaceholder\b/i.test(text),
      };
    },

    async listStepIds(machineSlug) {
      const machines = await client.query(api.machines.list, {});
      const machine = machines.find((entry) => entry.slug === machineSlug);
      for (const summary of machine?.procedures ?? []) {
        if (!summary.hasApproved) continue;
        const procedure = await client.query(api.procedures.getForPlay, {
          machineSlug,
          procedureSlug: summary.slug,
        });
        // Each playable procedure already includes all approved link targets.
        if (procedure) return procedure.linkTargets;
      }
      return {};
    },
  };
}
