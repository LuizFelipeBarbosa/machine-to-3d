import { beforeEach, describe, it, expect, vi } from 'vitest';
import { usePlayerStore } from './playerStore';

const key = 'nx10/load-sample';

describe('playerStore', () => {
  beforeEach(() => {
    usePlayerStore.setState({ progress: {} });
  });

  it('returns fresh defaults without creating progress when reading an absent key', () => {
    const store = usePlayerStore.getState();
    const progress = store.get(key);
    expect(progress).toEqual({ cur: 0, done: [], checked: [] });
    expect(store.get(key)).not.toBe(progress);
    progress.done.push('local-only');
    expect(store.get(key).done).toEqual([]);
    expect(usePlayerStore.getState().progress).toEqual({});
  });

  it('clamps navigation to zero through the complete position', () => {
    const store = usePlayerStore.getState();
    store.go(key, -3, 4);
    expect(store.get(key).cur).toBe(0);
    store.go(key, 10, 4);
    expect(store.get(key).cur).toBe(4);
    store.go(key, 2, 4);
    expect(store.get(key).cur).toBe(2);
    store.go(key, 1, 0);
    expect(store.get(key).cur).toBe(0);
  });

  it('records each done id once and advances one step, clamped at completion', () => {
    const store = usePlayerStore.getState();
    store.markDoneAndAdvance(key, 'raise', 2);
    expect(store.get(key)).toEqual({ cur: 1, done: ['raise'], checked: [] });
    store.markDoneAndAdvance(key, 'raise', 2);
    expect(store.get(key)).toEqual({ cur: 2, done: ['raise'], checked: [] });
    store.markDoneAndAdvance(key, 'load', 2);
    expect(store.get(key)).toEqual({ cur: 2, done: ['raise', 'load'], checked: [] });
  });

  it('adds and removes checked ids without duplicating or removing other checkpoints', () => {
    const store = usePlayerStore.getState();
    store.setChecked(key, 'raise', true);
    store.setChecked(key, 'raise', true);
    store.setChecked(key, 'load', true);
    expect(store.get(key).checked).toEqual(['raise', 'load']);
    store.setChecked(key, 'raise', false);
    expect(store.get(key).checked).toEqual(['load']);
  });

  it('restarts with default progress', () => {
    const store = usePlayerStore.getState();
    store.setChecked(key, 'raise', true);
    store.markDoneAndAdvance(key, 'raise', 2);
    store.restart(key);
    expect(store.get(key)).toEqual({ cur: 0, done: [], checked: [] });
  });

  it('keeps different procedure keys independent', () => {
    const store = usePlayerStore.getState();
    const otherKey = 'nx10/align-laser';
    store.setChecked(otherKey, 'align', true);
    store.markDoneAndAdvance(otherKey, 'align', 3);
    store.go(key, 3, 4);
    store.setChecked(key, 'load', true);
    store.restart(key);
    expect(store.get(otherKey)).toEqual({ cur: 1, done: ['align'], checked: ['align'] });
  });

  it('works when localStorage is absent or its operations throw', () => {
    try {
      vi.stubGlobal('localStorage', undefined);
      expect(() => usePlayerStore.getState().go(key, 1, 3)).not.toThrow();
      vi.stubGlobal('localStorage', {
        getItem() { throw new Error('Storage unavailable'); },
        setItem() { throw new Error('Storage unavailable'); },
        removeItem() { throw new Error('Storage unavailable'); },
      });
      expect(() => usePlayerStore.getState().setChecked(key, 'raise', true)).not.toThrow();
      expect(usePlayerStore.getState().get(key)).toEqual({ cur: 1, done: [], checked: ['raise'] });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
