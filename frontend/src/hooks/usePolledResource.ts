'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '@/lib/api';

export interface PolledResource<T> {
  data: T | null;
  error: string | null;
  /** True only for the very first load of a given `key` — drives skeletons. */
  loading: boolean;
  /** True while a background refresh is in flight — drives the subtle spinner. */
  refreshing: boolean;
  refresh: () => void;
}

interface Options {
  intervalMs?: number;
  enabled?: boolean;
}

/**
 * Fetch-and-poll for one resource.
 *
 * The scheduler's state changes on its own (jobs fire, get deferred, fail), so
 * every view polls. Keeping that in one hook means the tables, the stat cards
 * and the throughput panel all behave identically: skeleton on first load,
 * silent refresh afterwards, and no flicker when data is unchanged.
 *
 * `key` identifies the query — changing it (new tab, new search) resets to the
 * loading state and refetches immediately.
 */
export function usePolledResource<T>(
  key: string,
  fetcher: (signal: AbortSignal) => Promise<T>,
  { intervalMs = 5_000, enabled = true }: Options = {},
): PolledResource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [refreshing, setRefreshing] = useState(false);

  // Held in a ref so an inline arrow function does not restart the interval on
  // every render.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    let isFirstLoad = true;

    setLoading(true);
    setError(null);

    const load = async () => {
      if (!isFirstLoad) setRefreshing(true);
      try {
        const result = await fetcherRef.current(controller.signal);
        if (cancelled) return;
        setData(result);
        setError(null);
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return;
        setError(err instanceof ApiError ? err.message : 'Something went wrong while loading data.');
      } finally {
        if (!cancelled) {
          setLoading(false);
          setRefreshing(false);
          isFirstLoad = false;
        }
      }
    };

    void load();
    const timer = intervalMs > 0 ? setInterval(() => void load(), intervalMs) : null;

    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearInterval(timer);
    };
  }, [key, enabled, intervalMs, nonce]);

  return { data, error, loading, refreshing, refresh };
}
