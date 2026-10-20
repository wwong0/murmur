import { useSyncExternalStore } from 'react';

// A slice of the page view store. `select` must return the same value for the same snapshot,
// or React reads it as a change on every render.
export function useView(view, select) {
  return useSyncExternalStore(
    (onChange) => view.subscribe(() => onChange()),
    () => select(view.get()),
    () => select(view.get()),
  );
}
