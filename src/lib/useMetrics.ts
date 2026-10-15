import { useSyncExternalStore } from 'react';

import type { MetricsStore } from './store';

/**
 * Subscribes a component to the metrics store.
 *
 * Returns the store itself rather than a snapshot: components read the buffers they need
 * during render, and re-render when the store's version changes. That keeps the expensive
 * ring buffers out of React's state machinery entirely.
 */
export function useMetrics(store: MetricsStore): MetricsStore {
  useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.version,
  );
  return store;
}
