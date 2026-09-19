// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { getFunctionName } from 'convex/server';
import type { FunctionReference } from 'convex/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditorStore } from '../editor/editorStore';
import { Editor } from './Editor';

const backend = vi.hoisted(() => ({ query: vi.fn(), save: vi.fn(), approve: vi.fn(), discard: vi.fn(), createDraft: vi.fn() }));
vi.mock('../data/mode', () => ({ isConvexMode: true }));
vi.mock('../scene', () => ({ MachineScene: () => null }));
vi.mock('convex/react', () => ({
  useQuery: (reference: FunctionReference<'query'>, args: unknown) => args === 'skip' ? undefined : backend.query(getFunctionName(reference)),
  useMutation: (reference: FunctionReference<'mutation'>) => {
    const name = getFunctionName(reference);
    if (name === 'procedures:saveDraft') return backend.save;
    if (name === 'procedures:approve') return backend.approve;
    if (name === 'procedures:discardDraft') return backend.discard;
    if (name === 'procedures:createDraft') return backend.createDraft;
    return vi.fn();
  },
}));

const content = {
  formatVersion: 1 as const, title: 'Procedure', summary: '', minutes: 1, start: {},
  steps: [{ id: 'first', title: 'First', body: '', where: 'software' as const, parts: [], view: { pos: [1, 1, 1], target: [0, 0, 0] } }],
};
const version = {
  _id: 'draft', procedureId: 'procedure', version: 2, status: 'draft', content,
  procedureSlug: 'procedure', machineSlug: 'machine', modelUrl: '/model.glb',
  definition: { formatVersion: 1, rootNode: 'root', parts: [], stateVars: [], presetViews: [] },
};
const context = {
  procedureId: 'procedure', machineId: 'machine-id', machineSlug: 'machine', machineName: 'Machine',
  draftId: 'draft', approvedId: 'approved', modelUrl: '/model.glb', definition: version.definition,
  versions: [
    { _id: 'draft', version: 2, status: 'draft', _creationTime: 2 },
    { _id: 'approved', version: 1, status: 'approved', _creationTime: 1 },
  ],
  linkTargets: { procedure: ['first'] }, procedureTitles: { procedure: 'Procedure' }, mediaUrls: {},
};

function app() {
  return createElement(MemoryRouter, { initialEntries: ['/m/machine/procedure/edit'] },
    createElement(Routes, null,
      createElement(Route, { path: '/m/:machine/:procedure/edit', element: createElement(Editor) }),
      createElement(Route, { path: '/m/:machine/:procedure', element: createElement('p', null, 'Player route') }),
    ));
}

beforeEach(() => {
  useEditorStore.setState(useEditorStore.getInitialState(), true);
  vi.resetAllMocks();
  backend.query.mockImplementation((name) => {
    if (name === 'users:me') return { role: 'approver' };
    if (name === 'procedures:getEditorContext') return context;
    if (name === 'procedures:getVersion') return version;
    return undefined;
  });
  backend.save.mockResolvedValue(null);
  backend.approve.mockResolvedValue(null);
});

afterEach(cleanup);

describe('Convex editor route', () => {
  it('keeps local edits and selection when server query results change', async () => {
    const view = render(app());
    fireEvent.change(screen.getByLabelText('Step title'), { target: { value: 'Local edit' } });
    const localContent = useEditorStore.getState().content;
    backend.query.mockImplementation((name) => {
      if (name === 'users:me') return { role: 'approver' };
      if (name === 'procedures:getEditorContext') return { ...context, linkTargets: { ...context.linkTargets, other: ['target'] } };
      if (name === 'procedures:getVersion') return { ...version, content: { ...content, title: 'Server response' } };
      return undefined;
    });
    view.rerender(app());
    expect(useEditorStore.getState().content).toBe(localContent);
    expect(useEditorStore.getState().selectedStepId).toBe('first');
    expect(useEditorStore.getState().dirty).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Save now' }));
    await waitFor(() => expect(backend.save).toHaveBeenCalledWith({ versionId: 'draft', content: localContent }));
  });

  it('saves the latest content before approving with the change note', async () => {
    const order: string[] = [];
    backend.save.mockImplementation(async () => { order.push('save'); });
    backend.approve.mockImplementation(async () => { order.push('approve'); });
    render(app());
    fireEvent.change(screen.getByLabelText('Step title'), { target: { value: 'Ready for approval' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve…' }));
    fireEvent.change(screen.getByLabelText('Change note'), { target: { value: 'Reviewed changes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(backend.approve).toHaveBeenCalledWith({ versionId: 'draft', changeNote: 'Reviewed changes' }));
    expect(order).toEqual(['save', 'approve']);
  });

  it('waits for saving before navigating to preview', async () => {
    let finish: () => void = () => {};
    backend.save.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(app());
    fireEvent.change(screen.getByLabelText('Step title'), { target: { value: 'Preview this' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await act(async () => {});
    expect(screen.queryByText('Player route')).toBeNull();
    await act(async () => finish());
    expect(screen.getByText('Player route')).toBeTruthy();
  });
});
