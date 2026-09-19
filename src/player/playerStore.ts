import { create } from 'zustand';
import type { StoreApi, UseBoundStore } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { StateStorage } from 'zustand/middleware';

export type Progress = { cur: number; done: string[]; checked: string[] };
export type PlayerStore = {
  progress: Record<string, Progress>;
  get(key: string): Progress;
  go(key: string, index: number, stepCount: number): void;
  markDoneAndAdvance(key: string, stepId: string, stepCount: number): void;
  setChecked(key: string, stepId: string, checked: boolean): void;
  restart(key: string): void;
};

function emptyProgress(): Progress {
  return { cur: 0, done: [], checked: [] };
}

function clampIndex(index: number, stepCount: number): number {
  return Math.max(0, Math.min(index, stepCount));
}

// Access and individual operations can both throw (for example in private browsing).
function guardedStorage(): StateStorage {
  return {
    getItem(name) {
      try {
        return globalThis.localStorage?.getItem(name) ?? null;
      } catch {
        return null;
      }
    },
    setItem(name, value) {
      try {
        globalThis.localStorage?.setItem(name, value);
      } catch {
        // Progress remains available in the Zustand store for this session.
      }
    },
    removeItem(name) {
      try {
        globalThis.localStorage?.removeItem(name);
      } catch {
        // Unavailable storage must not prevent using the player.
      }
    },
  };
}

export const usePlayerStore: UseBoundStore<StoreApi<PlayerStore>> = create<PlayerStore>()(
  persist(
    (set, get) => ({
      progress: {},
      get(key) {
        return get().progress[key] ?? emptyProgress();
      },
      go(key, index, stepCount) {
        set((store) => ({
          progress: {
            ...store.progress,
            [key]: { ...store.get(key), cur: clampIndex(index, stepCount) },
          },
        }));
      },
      markDoneAndAdvance(key, stepId, stepCount) {
        set((store) => {
          const progress = store.get(key);
          return {
            progress: {
              ...store.progress,
              [key]: {
                ...progress,
                done: progress.done.includes(stepId) ? progress.done : [...progress.done, stepId],
                cur: clampIndex(progress.cur + 1, stepCount),
              },
            },
          };
        });
      },
      setChecked(key, stepId, checked) {
        set((store) => {
          const progress = store.get(key);
          const withoutStep = progress.checked.filter((id) => id !== stepId);
          return {
            progress: {
              ...store.progress,
              [key]: { ...progress, checked: checked ? [...withoutStep, stepId] : withoutStep },
            },
          };
        });
      },
      restart(key) {
        set((store) => ({ progress: { ...store.progress, [key]: emptyProgress() } }));
      },
    }),
    {
      name: 'bench-guide:progress',
      storage: createJSONStorage(guardedStorage),
      partialize: (store) => ({ progress: store.progress }),
    },
  ),
);
