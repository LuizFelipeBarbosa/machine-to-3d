// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { getFunctionName } from 'convex/server';
import type { FunctionReference } from 'convex/server';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CatalogProvider } from '../data/CatalogContext';
import type { MachineRecord, ProcedureRecord } from '../data/catalog';
import { usePlayerStore } from '../player/playerStore';
import { MachineWorkspace } from './MachineWorkspace';

const backend = vi.hoisted(() => ({ query: vi.fn(), complete: vi.fn(), create: vi.fn() }));
vi.mock('../data/mode', () => ({ isConvexMode: true }));
vi.mock('../scene', async () => {
  const { createElement, forwardRef, useImperativeHandle } = await import('react');
  return {
    MachineScene: forwardRef((_props, ref) => {
      useImperativeHandle(ref, () => ({ goToView() {}, resetView() {}, getCurrentView() {} }), []);
      return createElement('canvas');
    }),
  };
});
vi.mock('convex/react', () => ({
  useQuery: (reference: FunctionReference<'query'>, args: unknown) => (
    args === 'skip' ? undefined : backend.query(getFunctionName(reference), args)
  ),
  useMutation: (reference: FunctionReference<'mutation'>) => (
    getFunctionName(reference) === 'training:complete' ? backend.complete : backend.create
  ),
}));

const machine: MachineRecord = {
  slug: 'machine', name: 'Test machine', kind: 'Instrument', modelUrl: '/model.glb',
  definition: { formatVersion: 1, rootNode: 'root', parts: [], stateVars: [], presetViews: [] },
};
const procedure: ProcedureRecord = {
  slug: 'procedure', machineSlug: machine.slug, placeholder: false, versionId: 'approved',
  content: {
    formatVersion: 1, title: 'Approved procedure', summary: '', minutes: 1, start: {},
    steps: [{
      id: 'confirm', title: 'Confirm setup', where: 'instrument', body: '', parts: [],
      view: { pos: [1, 1, 1], target: [0, 0, 0] }, check: 'Setup is ready',
      media: { fileId: 'storage', alt: 'Setup image' },
    }],
  },
  mediaUrls: { storage: '/approved.png' },
};
const version = {
  ...machine, machineSlug: machine.slug, procedureSlug: procedure.slug,
  content: { ...procedure.content, title: 'Draft procedure' },
  linkTargets: { procedure: ['confirm'] }, mediaUrls: { storage: '/draft.png' },
};
const catalog = {
  getMachine: vi.fn(async () => machine),
  listMachines: vi.fn(async () => [{ ...machine, procedures: [{ slug: procedure.slug, title: procedure.content.title, minutes: 1 }] }]),
  getProcedure: vi.fn(async () => procedure),
  listStepIds: vi.fn(async () => ({ procedure: ['confirm'] })),
};

function app(path = '/m/machine/procedure') {
  window.history.replaceState(null, '', path);
  return render(createElement(BrowserRouter, null,
    createElement(CatalogProvider, { catalog, children:
      createElement(Routes, null,
        createElement(Route, { path: '/m/:machine/:procedure?', element: createElement(MachineWorkspace) }),
        createElement(Route, { path: '/m/:machine/:procedure/edit', element: createElement('p', null, 'Editor route') }),
      ),
    }),
  ));
}

beforeEach(() => {
  vi.resetAllMocks();
  usePlayerStore.setState({ progress: {} });
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
  Element.prototype.scrollIntoView = vi.fn();
  backend.complete.mockResolvedValue(null);
  backend.create.mockResolvedValue('new-id');
  backend.query.mockImplementation((name) => {
    if (name === 'users:me') return { role: 'author' };
    if (name === 'machines:getBySlug') return { ...machine, _id: 'machine-id' };
    if (name === 'procedures:listForMachine') return [
      { slug: 'procedure', title: 'Approved procedure', hasDraft: true, hasApproved: true },
      { slug: 'unpublished', title: 'Unpublished procedure', hasDraft: true, hasApproved: false },
    ];
    if (name === 'procedures:getVersion') return version;
    return undefined;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Convex workspace', () => {
  it('records approved completion with checkpoints and displays media and the Recorded notice', async () => {
    app();
    await screen.findByRole('heading', { name: 'Approved procedure' });
    expect(screen.getByRole('img', { name: 'Setup image' }).getAttribute('src')).toBe('/approved.png');
    expect(screen.getByRole('link', { name: 'Edit' }).getAttribute('href')).toBe('/m/machine/procedure/edit');
    fireEvent.click(screen.getByRole('checkbox', { name: /Setup is ready/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Finish procedure' }));
    await screen.findByText('Recorded');
    expect(backend.complete).toHaveBeenCalledExactlyOnceWith({
      procedureVersionId: 'approved', checkpoints: [{ stepId: 'confirm', at: expect.any(Number) }],
    });
  });

  it('previews a draft with its media and leaves stored progress and training records untouched', async () => {
    const saved = { cur: 1, checked: ['confirm'], done: ['confirm'] };
    usePlayerStore.setState({ progress: { 'machine/procedure': saved } });
    app('/m/machine/procedure?version=draft&step=confirm');
    await screen.findByText('Draft preview — not recorded');
    expect(backend.query).toHaveBeenCalledWith('procedures:getVersion', { versionId: 'draft' });
    expect(catalog.getProcedure).not.toHaveBeenCalled();
    expect(screen.getByRole('img', { name: 'Setup image' }).getAttribute('src')).toBe('/draft.png');
    fireEvent.click(screen.getByRole('checkbox', { name: /Setup is ready/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Finish procedure' }));
    expect(screen.getByRole('heading', { name: 'Procedure complete' })).toBeTruthy();
    expect(backend.complete).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().progress['machine/procedure']).toEqual(saved);
    fireEvent.click(screen.getByRole('button', { name: 'Back to the machine' }));
    expect(window.location.pathname + window.location.search).toBe('/m/machine');
  });

  it('gates preview loading and author tools for trainees', async () => {
    backend.query.mockImplementation((name) => name === 'users:me' ? { role: 'trainee' } : undefined);
    app('/m/machine/procedure?version=draft');
    await screen.findByText('Not authorized');
    expect(backend.query).not.toHaveBeenCalledWith('procedures:getVersion', expect.anything());
    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New procedure' })).toBeNull();
    expect(backend.complete).not.toHaveBeenCalled();
  });

  it('preserves unpublished author procedures and creates a procedure before opening its editor', async () => {
    app('/m/machine');
    await screen.findByRole('button', { name: 'New procedure' });
    expect(screen.getByRole('option', { name: 'Unpublished procedure' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Unpublished procedure' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText('Draft')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'New procedure' }));
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'new-procedure' } });
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: ' New procedure ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create procedure' }));
    await waitFor(() => expect(backend.create).toHaveBeenCalledExactlyOnceWith({
      machineId: 'machine-id', slug: 'new-procedure', title: 'New procedure',
    }));
    await screen.findByText('Editor route');
    expect(window.location.pathname).toBe('/m/machine/new-procedure/edit');
  });
});
