// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcedureContent } from '../../shared/procedure';
import { useEditorStore } from './editorStore';
import { useAutosave } from './useAutosave';

const initialContent: ProcedureContent = {
  formatVersion: 1, title: 'Procedure', summary: '', minutes: 1, start: {},
  steps: [{ id: 'one', title: 'One', body: '', where: 'software', parts: [], view: { pos: [1, 1, 1], target: [0, 0, 0] } }],
};

beforeEach(() => {
  vi.useFakeTimers();
  useEditorStore.setState({ ...useEditorStore.getInitialState(), content: initialContent }, true);
});

afterEach(async () => {
  cleanup();
  await Promise.resolve();
  vi.useRealTimers();
});

function edit(title: string) {
  act(() => useEditorStore.getState().patchMeta({ title }));
}

describe('autosave', () => {
  it('debounces edits for 1500 ms and marks only the submitted snapshot saved', async () => {
    let finish: () => void = () => {};
    const onSave = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { result } = renderHook(() => useAutosave(onSave));
    expect(result.current.status).toBe('saved');
    edit('First edit');
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    edit('Second edit');
    await act(async () => vi.advanceTimersByTimeAsync(1499));
    expect(onSave).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(onSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ title: 'Second edit' }));
    expect(result.current.status).toBe('saving');
    edit('Edited during save');
    await act(async () => finish());
    expect(result.current.status).toBe('unsaved');
    expect(useEditorStore.getState().dirty).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    await act(async () => finish());
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('saved');
  });

  it('keeps failures dirty, surfaces errors, and retries when requested', async () => {
    const onSave = vi.fn<NonNullable<Parameters<typeof useAutosave>[0]>>()
      .mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(undefined);
    const { result } = renderHook(() => useAutosave(onSave));
    edit('Changed');
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe('Offline');
    expect(useEditorStore.getState().dirty).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(onSave).toHaveBeenCalledOnce();
    await act(async () => { expect(await result.current.saveNow()).toBe(true); });
    expect(result.current.status).toBe('saved');
  });

  it('flushes before unload and saves its own snapshot when another route loads', async () => {
    const onSave = vi.fn(async () => {});
    const { unmount } = renderHook(() => useAutosave(onSave));
    edit('Before unload');
    await act(async () => window.dispatchEvent(new Event('beforeunload')));
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Before unload' }));
    edit('Before route change');
    unmount();
    useEditorStore.setState({ content: { ...initialContent, title: 'Another draft' }, dirty: true });
    await act(async () => {});
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Before route change' }));
    expect(useEditorStore.getState().dirty).toBe(true);
    expect(useEditorStore.getState().content?.title).toBe('Another draft');
  });

  it('flushes edits made during a request without overlapping saves', async () => {
    let finish: () => void = () => {};
    const onSave = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { result } = renderHook(() => useAutosave(onSave));
    edit('First');
    await act(async () => { void result.current.saveNow(); });
    edit('Latest');
    let flushed: Promise<boolean>;
    await act(async () => { flushed = result.current.flush(); });
    expect(onSave).toHaveBeenCalledOnce();
    await act(async () => finish());
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Latest' }));
    await act(async () => { finish(); expect(await flushed!).toBe(true); });
    expect(result.current.status).toBe('saved');
  });

  it('pauses autosave and the unmount save when discarding a draft', async () => {
    const onSave = vi.fn(async () => {});
    const { result, unmount } = renderHook(() => useAutosave(onSave));
    edit('Discarded changes');
    await act(async () => result.current.pause());
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    unmount();
    await act(async () => {});
    expect(onSave).not.toHaveBeenCalled();
  });
});
