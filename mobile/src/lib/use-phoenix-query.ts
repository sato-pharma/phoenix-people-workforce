import { useCallback, useEffect, useState } from "react";

import { ApiError, NetworkError, apiGetData } from "./api";
import { useSession } from "./session";

type QueryState<T> = {
  data: T | null;
  error: string | null;
  /** True on the first load only — a refresh keeps the previous data on screen. */
  loading: boolean;
  /** True while a pull-to-refresh is in flight. */
  refreshing: boolean;
};

/**
 * Fetch a Phoenix endpoint for the current session, with refresh and expiry handling.
 *
 * Every screen's read goes through this so three behaviours are consistent everywhere:
 *
 *   1. A 401/403 signs the app out rather than showing an error — the session is genuinely over
 *      (expired, revoked from "Log out everywhere", or the employee record went inactive), and
 *      leaving the person staring at "Forbidden" with no way forward is the wrong answer.
 *   2. A refresh keeps the last good data visible. A rep pulling to refresh on a weak connection
 *      should not lose the screen they were reading.
 *   3. A network failure is reported as a network failure, not as a server error. They have
 *      different remedies and a field user can act on the difference.
 *
 * Deliberately not a caching library. There is no offline story in this phase, and a stale-while-
 * revalidate cache that silently serves yesterday's attendance would be worse than a spinner.
 */
export function usePhoenixQuery<T>(path: string): QueryState<T> & { refresh: () => void } {
  const { handleExpiredSession, token } = useSession();
  const [state, setState] = useState<QueryState<T>>({
    data: null,
    error: null,
    loading: true,
    refreshing: false,
  });

  const load = useCallback(
    async (mode: "initial" | "refresh") => {
      if (!token) return;

      setState((previous) => ({
        ...previous,
        error: null,
        loading: mode === "initial",
        refreshing: mode === "refresh",
      }));

      try {
        const data = await apiGetData<T>(path, token);
        setState({ data, error: null, loading: false, refreshing: false });
      } catch (error) {
        if (error instanceof ApiError && error.isSessionExpired) {
          await handleExpiredSession();
          return;
        }

        const message =
          error instanceof NetworkError || error instanceof ApiError
            ? error.message
            : "Something went wrong loading this screen.";

        setState((previous) => ({ ...previous, error: message, loading: false, refreshing: false }));
      }
    },
    [handleExpiredSession, path, token],
  );

  useEffect(() => {
    void load("initial");
  }, [load]);

  const refresh = useCallback(() => {
    void load("refresh");
  }, [load]);

  return { ...state, refresh };
}
