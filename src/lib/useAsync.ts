import { useEffect, useState } from 'react';

type AsyncState<T> = { data: T | null; error: Error | null; loading: boolean };

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ data: null, error: null, loading: true });

  useEffect(() => {
    let active = true;
    setState({ data: null, error: null, loading: true });

    async function load() {
      try {
        const data = await fn();
        if (active) {
          setState({ data, error: null, loading: false });
        }
      } catch (cause) {
        if (active) {
          const error = cause instanceof Error ? cause : new Error(String(cause));
          setState({ data: null, error, loading: false });
        }
      }
    }

    void load();
    return () => {
      active = false;
    };
    // Callers list every value used by fn; changing its inline identity must not refetch.
  }, deps);

  return state;
}
