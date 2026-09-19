// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { getFunctionName } from 'convex/server';
import { ConvexError } from 'convex/values';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MachineAdmin } from './MachineAdmin';

const backend = vi.hoisted(() => ({
  generateUploadUrl: vi.fn(),
  publishVersion: vi.fn(),
  publishDraftVersion: vi.fn(),
  listVersions: vi.fn(),
  role: 'admin',
}));

vi.mock('../data/mode', () => ({ isConvexMode: true }));
vi.mock('../auth/useMe', () => ({ useMe: () => ({ me: { role: backend.role }, loading: false }) }));
vi.mock('convex/react', () => ({
  useMutation: (reference: Parameters<typeof getFunctionName>[0]) => {
    const name = getFunctionName(reference);
    if (name === 'files:generateUploadUrl') return backend.generateUploadUrl;
    if (name === 'machines:publishDraftVersion') return backend.publishDraftVersion;
    return backend.publishVersion;
  },
  useQuery: (reference: Parameters<typeof getFunctionName>[0], args: unknown) => (
    getFunctionName(reference) === 'machines:list' ? [
      { _id: 'machine', slug: 'test-machine', name: 'Test machine', kind: 'Instrument', currentVersionId: 'current', procedures: [] },
    ] : backend.listVersions(args)
  ),
}));
vi.mock('./useGlbCheck', () => ({
  useGlbCheck: (file: File | null) => ({
    summary: file ? { rootNodes: ['Root'], namedNodes: ['Root'], nodeCount: 1, meshCount: 0, animationCount: 0, boundingBox: null } : null,
    issues: file ? [] : ['Choose a GLB file.'],
  }),
}));
vi.mock('./DefinitionPreview', () => ({ DefinitionPreview: () => null }));

beforeEach(() => {
  backend.listVersions.mockReturnValue([
    { _id: 'newer', version: 4, status: 'draft', _creationTime: 1726747200000 },
    { _id: 'current', version: 3, status: 'published', _creationTime: 1726660800000 },
  ]);
});

afterEach(() => {
  cleanup();
  backend.role = 'admin';
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

function fillForm() {
  render(createElement(MemoryRouter, null, createElement(MachineAdmin)));
  fireEvent.click(screen.getByRole('button', { name: /Test machine/ }));
  const file = new File(['GLB'], 'model.glb');
  fireEvent.change(screen.getByLabelText('GLB file'), { target: { files: [file] } });
  const definition = { formatVersion: 1, rootNode: 'Root', parts: [], presetViews: [], stateVars: [] };
  fireEvent.change(screen.getByLabelText('machine.json'), { target: { value: JSON.stringify(definition) } });
  return { file, definition };
}

it('prefills an existing machine, shows its current version, and publishes the validated inputs', async () => {
  backend.generateUploadUrl.mockResolvedValue('https://upload.example.test');
  backend.publishVersion.mockResolvedValue({ version: 5 });
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ storageId: 'model-id' }) });
  vi.stubGlobal('fetch', fetch);
  const { file, definition } = fillForm();
  expect(screen.getByText('Current version: 3')).toBeTruthy();
  expect((screen.getByLabelText('Slug') as HTMLInputElement).value).toBe('test-machine');
  fireEvent.click(screen.getByRole('button', { name: 'Publish version' }));
  expect(await screen.findByText(/Published version 5/)).toBeTruthy();
  expect(backend.generateUploadUrl).toHaveBeenCalledWith({ kind: 'model' });
  expect(fetch).toHaveBeenCalledWith('https://upload.example.test', {
    method: 'POST', headers: { 'Content-Type': 'model/gltf-binary' }, body: file,
  });
  expect(backend.publishVersion).toHaveBeenCalledWith({
    slug: 'test-machine', name: 'Test machine', kind: 'Instrument', modelFileId: 'model-id', definition,
  });
  expect(screen.getByRole('link', { name: 'View machine' }).getAttribute('href')).toBe('/m/test-machine');
});

it('disables publishing for invalid metadata or a definition and lists schema paths', () => {
  fillForm();
  const publish = screen.getByRole('button', { name: 'Publish version' }) as HTMLButtonElement;
  expect(publish.disabled).toBe(false);
  fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'Bad slug' } });
  expect(publish.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'valid' } });
  fireEvent.change(screen.getByLabelText('machine.json'), { target: { value: '{"rootNode": 42}' } });
  expect(publish.disabled).toBe(true);
  expect(screen.getByText(/rootNode: Invalid input/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('machine.json'), { target: { value: '{' } });
  expect(screen.getByText(/^JSON:/)).toBeTruthy();
  expect(backend.publishVersion).not.toHaveBeenCalled();
});

it('reports upload failure and allows retry without publishing a version', async () => {
  backend.generateUploadUrl.mockResolvedValue('https://upload.example.test');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
  fillForm();
  fireEvent.click(screen.getByRole('button', { name: 'Publish version' }));
  expect((await screen.findByRole('alert')).textContent).toContain('GLB could not be uploaded');
  await waitFor(() => expect((screen.getByRole('button', { name: 'Publish version' }) as HTMLButtonElement).disabled).toBe(false));
  expect(backend.publishVersion).not.toHaveBeenCalled();
});

it('shows the selected machine versions with status, date, and publishing only for drafts', () => {
  render(createElement(MemoryRouter, null, createElement(MachineAdmin)));
  expect(screen.queryByRole('region', { name: 'Machine versions' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Test machine/ }));
  const versions = screen.getByRole('region', { name: 'Machine versions' });
  const rows = within(versions).getAllByRole('listitem');
  expect(within(rows[0]).getByText(`v4 · Draft · ${new Date(1726747200000).toLocaleDateString()}`)).toBeTruthy();
  expect(within(rows[1]).getByText(`v3 · Published · ${new Date(1726660800000).toLocaleDateString()}`)).toBeTruthy();
  expect(within(rows[0]).getByRole('button', { name: 'Publish' })).toBeTruthy();
  expect(within(rows[1]).queryByRole('button', { name: 'Publish' })).toBeNull();
  expect(backend.listVersions).toHaveBeenCalledWith({ machineId: 'machine' });
});

it('publishes the selected draft version', async () => {
  backend.publishDraftVersion.mockResolvedValue(null);
  render(createElement(MemoryRouter, null, createElement(MachineAdmin)));
  fireEvent.click(screen.getByRole('button', { name: /Test machine/ }));
  const versions = screen.getByRole('region', { name: 'Machine versions' });
  const publish = within(versions).getByRole('button', { name: 'Publish' }) as HTMLButtonElement;
  fireEvent.click(publish);
  expect(backend.publishDraftVersion).toHaveBeenCalledWith({ machineVersionId: 'newer' });
  await waitFor(() => expect(publish.disabled).toBe(false));
});

it.each(['Machine version superseded', 'Only draft machine versions can be published'])(
  'reports the draft publishing error: %s', async (message) => {
    backend.publishDraftVersion.mockRejectedValue(new ConvexError(message));
    render(createElement(MemoryRouter, null, createElement(MachineAdmin)));
    fireEvent.click(screen.getByRole('button', { name: /Test machine/ }));
    const versions = screen.getByRole('region', { name: 'Machine versions' });
    fireEvent.click(within(versions).getByRole('button', { name: 'Publish' }));
    const error = await within(versions).findByRole('alert');
    expect(error.textContent).toBe(message);
    expect(error.className).toBe('notice error');
  },
);

it('shows a loading notice while the selected machine versions are pending', () => {
  backend.listVersions.mockReturnValue(undefined);
  render(createElement(MemoryRouter, null, createElement(MachineAdmin)));
  fireEvent.click(screen.getByRole('button', { name: /Test machine/ }));
  const versions = screen.getByRole('region', { name: 'Machine versions' });
  expect(within(versions).getByRole('status').textContent).toBe('Loading versions…');
  expect(within(versions).queryByText('No versions yet.')).toBeNull();
});

it('shows an empty notice when the selected machine has no versions', () => {
  backend.listVersions.mockReturnValue([]);
  render(createElement(MemoryRouter, null, createElement(MachineAdmin)));
  fireEvent.click(screen.getByRole('button', { name: /Test machine/ }));
  const versions = screen.getByRole('region', { name: 'Machine versions' });
  expect(within(versions).getByText('No versions yet.')).toBeTruthy();
  expect(within(versions).queryByRole('status')).toBeNull();
});

it('denies non-admins access to the form', () => {
  backend.role = 'author';
  render(createElement(MemoryRouter, null, createElement(MachineAdmin)));
  expect(screen.getByRole('alert').textContent).toBe('Not authorized');
  expect(screen.queryByLabelText('Slug')).toBeNull();
});
