import { describe, expect, it, vi } from 'vitest';
import type { ConvexReactClient } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { createConvexCatalog } from './convexCatalog';

function setup() {
  const query = vi.fn();
  const catalog = createConvexCatalog({ query } as unknown as ConvexReactClient);
  return { query, catalog };
}

describe('Convex catalog', () => {
  it('lists only playable procedures even for authors who can see drafts', async () => {
    const { query, catalog } = setup();
    query.mockResolvedValue([{
      slug: 'machine', name: 'Machine', kind: 'Instrument', procedures: [
        { slug: 'approved', title: 'Approved', minutes: 3, hasApproved: true },
        { slug: 'draft', title: 'Draft', minutes: 4, hasApproved: false },
      ],
    }]);
    expect(await catalog.listMachines()).toEqual([{
      slug: 'machine', name: 'Machine', kind: 'Instrument',
      procedures: [{ slug: 'approved', title: 'Approved', minutes: 3 }],
    }]);
    expect(query).toHaveBeenCalledWith(api.machines.list, {});
  });

  it('retains approved machine snapshots and detects placeholder text, not identifiers', async () => {
    const { query, catalog } = setup();
    const content = { title: 'Approved', summary: '', steps: [{ id: 'placeholder', title: 'Check', body: 'Placeholder content' }] };
    const definition = { rootNode: 'approved-machine' };
    query.mockResolvedValue({ content, definition, versionId: 'version', modelUrl: '/approved.glb' });
    expect(await catalog.getProcedure('machine', 'procedure')).toEqual({
      slug: 'procedure', machineSlug: 'machine', content, versionId: 'version', placeholder: true,
      machineVersion: { definition, modelUrl: '/approved.glb' },
    });
    expect(query).toHaveBeenCalledWith(api.procedures.getForPlay, { machineSlug: 'machine', procedureSlug: 'procedure' });
    content.steps[0].body = 'Ready';
    expect((await catalog.getProcedure('machine', 'procedure'))?.placeholder).toBe(false);
  });

  it('uses the complete server link map without querying every procedure', async () => {
    const { query, catalog } = setup();
    const linkTargets = { first: ['one'], second: ['two'] };
    query.mockResolvedValueOnce([{
      slug: 'machine', procedures: [{ slug: 'first', hasApproved: true }, { slug: 'second', hasApproved: true }],
    }]).mockResolvedValueOnce({ linkTargets });
    expect(await catalog.listStepIds('machine')).toBe(linkTargets);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('handles missing records and refuses missing model URLs', async () => {
    const { query, catalog } = setup();
    query.mockResolvedValue(null);
    expect(await catalog.getMachine('missing')).toBeNull();
    expect(await catalog.getProcedure('missing', 'missing')).toBeNull();
    query.mockResolvedValue({ version: { modelUrl: null } });
    await expect(catalog.getMachine('machine')).rejects.toThrow('model is unavailable');
    query.mockResolvedValue({ modelUrl: null });
    await expect(catalog.getProcedure('machine', 'procedure')).rejects.toThrow('model is unavailable');
    query.mockResolvedValue([]);
    expect(await catalog.listStepIds('missing')).toEqual({});
  });
});
