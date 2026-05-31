import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * Returns `false` during SSR and the initial client render, then `true` once the
 * component has hydrated on the client.
 *
 * Use this instead of a `setState`-in-effect mount flag (`useEffect(() =>
 * setMounted(true), [])`) to gate client-only UI such as skeletons or reads of
 * browser-only APIs. It avoids the extra render the effect pattern causes and
 * keeps the server/client markup consistent during hydration.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
