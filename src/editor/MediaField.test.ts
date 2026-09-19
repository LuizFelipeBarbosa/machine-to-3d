// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaField } from './MediaField';

const backend = vi.hoisted(() => ({ generateUploadUrl: vi.fn(), isConvexMode: true }));
vi.mock('convex/react', () => ({ useMutation: () => backend.generateUploadUrl, useQuery: () => '/uploaded.png' }));
vi.mock('../data/mode', () => ({ get isConvexMode() { return backend.isConvexMode; } }));

afterEach(() => {
  cleanup();
  backend.isConvexMode = true;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('step media', () => {
  it('uploads the image, attaches the returned storage id, and edits alt text or removes media', async () => {
    backend.generateUploadUrl.mockResolvedValue('https://upload.example.test');
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ storageId: 'image-id' }) });
    vi.stubGlobal('fetch', fetch);
    const onChange = vi.fn();
    const view = render(createElement(MediaField, { media: undefined, onChange }));
    const file = new File(['image'], 'screenshot.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Image'), { target: { files: [file] } });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ fileId: 'image-id', alt: '' }));
    expect(backend.generateUploadUrl).toHaveBeenCalledWith({ kind: 'media' });
    expect(fetch).toHaveBeenCalledWith('https://upload.example.test', {
      method: 'POST', headers: { 'Content-Type': 'image/png' }, body: file,
    });
    view.rerender(createElement(MediaField, {
      media: { fileId: 'image-id', alt: 'Control panel' }, mediaUrls: { 'image-id': '/screen.png' }, onChange,
    }));
    expect(screen.getByRole('img', { name: 'Control panel' }).getAttribute('src')).toBe('/screen.png');
    fireEvent.change(screen.getByLabelText('Alt text'), { target: { value: 'Scan settings' } });
    expect(onChange).toHaveBeenLastCalledWith({ fileId: 'image-id', alt: 'Scan settings' });
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it('shows upload failures without attaching a file', async () => {
    backend.generateUploadUrl.mockResolvedValue('https://upload.example.test');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    const onChange = vi.fn();
    render(createElement(MediaField, { media: undefined, onChange }));
    fireEvent.change(screen.getByLabelText('Image'), {
      target: { files: [new File(['image'], 'screenshot.png', { type: 'image/png' })] },
    });
    expect((await screen.findByRole('alert')).textContent).toContain('could not be uploaded');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows the backend requirement in local mode without upload controls', () => {
    backend.isConvexMode = false;
    render(createElement(MediaField, { media: undefined, onChange: vi.fn() }));
    expect(screen.getByText('Uploads need the backend')).toBeTruthy();
    expect(screen.queryByLabelText('Image')).toBeNull();
  });
});
